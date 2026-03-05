import chalk from "chalk";
import prompts from "prompts";
import { execa } from "execa";
import { Resolver } from "node:dns/promises";

type VmInfo = {
  name: string;
  resourceGroup: string;
  osType?: string;
  powerState?: string;
};

type DiagnoseDnsDriftInput = {
  fqdn: string;
  vmName: string;
  server?: string;
};

type CommandError = {
  message?: string;
  stderr?: string;
  shortMessage?: string;
};

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function findVmMatches(vms: VmInfo[], target: string): VmInfo[] {
  const q = normalize(target);
  if (!q) return [];

  const exact = vms.filter((vm) => normalize(vm.name) === q);
  if (exact.length > 0) return exact;

  return vms.filter((vm) => normalize(vm.name).includes(q));
}

async function listVms(): Promise<VmInfo[]> {
  const out = await execa(
    "az",
    [
      "vm",
      "list",
      "-d",
      "--query",
      "[].{name:name,resourceGroup:resourceGroup,osType:storageProfile.osDisk.osType,powerState:powerState}",
      "-o",
      "json",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(out.stdout) as VmInfo[];
  return Array.isArray(parsed) ? parsed : [];
}

async function selectVm(matches: VmInfo[], vmName: string): Promise<VmInfo | null> {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  const pick = await prompts({
    type: "select",
    name: "vm",
    message: `Multiple VMs match "${vmName}". Which VM?`,
    choices: matches.map((vm) => ({
      title: `${vm.name} (${vm.resourceGroup})${vm.powerState ? ` [${vm.powerState}]` : ""}`,
      value: `${vm.resourceGroup}:::${vm.name}`,
    })),
  });

  if (!pick.vm) return null;
  const [resourceGroup, name] = String(pick.vm).split(":::");
  return matches.find((vm) => vm.resourceGroup === resourceGroup && vm.name === name) ?? null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function isPrivateIpv4(ip: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

async function getExternalARecords(fqdn: string): Promise<string[]> {
  const resolver = new Resolver();
  try {
    const values = await resolver.resolve4(fqdn);
    return unique(values);
  } catch {
    return [];
  }
}

function buildVmScript(osType: string | undefined, fqdn: string, server?: string): string {
  const target = fqdn.replace(/"/g, "");
  const dnsServer = (server ?? "").replace(/"/g, "");
  const isWindows = normalize(osType ?? "") === "windows";

  if (isWindows) {
    if (dnsServer) {
      return [
        `$records = Resolve-DnsName -Name "${target}" -Type A -Server "${dnsServer}" -ErrorAction SilentlyContinue`,
        '$ips = @($records | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress })',
        'Write-Output ("AZMAN_DNS_VM_A=" + ($ips -join ","))',
      ].join("\n");
    }
    return [
      `$records = Resolve-DnsName -Name "${target}" -Type A -ErrorAction SilentlyContinue`,
      '$ips = @($records | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress })',
      'Write-Output ("AZMAN_DNS_VM_A=" + ($ips -join ","))',
    ].join("\n");
  }

  if (dnsServer) {
    return [
      'if command -v dig >/dev/null 2>&1; then',
      `  ips=$(dig +short A "${target}" @"${dnsServer}" | paste -sd, -)`,
      'elif command -v nslookup >/dev/null 2>&1; then',
      `  ips=$(nslookup "${target}" "${dnsServer}" 2>/dev/null | awk '/^Address: /{print $2}' | tail -n +2 | paste -sd, -)`,
      "else",
      '  ips=""',
      "fi",
      'echo "AZMAN_DNS_VM_A=${ips}"',
    ].join("\n");
  }

  return [
    'if command -v dig >/dev/null 2>&1; then',
    `  ips=$(dig +short A "${target}" | paste -sd, -)`,
    'elif command -v nslookup >/dev/null 2>&1; then',
    `  ips=$(nslookup "${target}" 2>/dev/null | awk '/^Address: /{print $2}' | tail -n +2 | paste -sd, -)`,
    "else",
    '  ips=""',
    "fi",
    'echo "AZMAN_DNS_VM_A=${ips}"',
  ].join("\n");
}

function extractErrorText(err: unknown): string {
  const e = err as CommandError;
  return (e.stderr ?? e.shortMessage ?? e.message ?? String(err)).trim();
}

function printPermissionHint(errorText: string): void {
  const text = errorText.toLowerCase();
  if (text.includes("authorizationfailed") || text.includes("does not have authorization")) {
    console.log(chalk.red("Could not run VM-side DNS diagnostic: missing permission."));
    console.log(
      chalk.yellow(
        'Need action: "Microsoft.Compute/virtualMachines/runCommand/action" (e.g., Virtual Machine Contributor).',
      ),
    );
    console.log(chalk.gray('Then refresh auth: "az account clear" and "az login".\n'));
    return;
  }

  const lines = errorText.split("\n").filter(Boolean).slice(0, 6);
  console.log(chalk.red("Could not run VM-side DNS diagnostic."));
  console.log(lines.join("\n"));
  if (errorText.split("\n").length > 6) console.log(chalk.gray("...truncated...\n"));
  else console.log("");
}

async function getVmARecords(vm: VmInfo, fqdn: string, server?: string): Promise<string[] | null> {
  const commandId = normalize(vm.osType ?? "") === "windows" ? "RunPowerShellScript" : "RunShellScript";
  const script = buildVmScript(vm.osType, fqdn, server);

  try {
    const out = await execa(
      "az",
      [
        "vm",
        "run-command",
        "invoke",
        "-g",
        vm.resourceGroup,
        "-n",
        vm.name,
        "--command-id",
        commandId,
        "--scripts",
        script,
        "-o",
        "json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const parsed = JSON.parse(out.stdout) as { value?: Array<{ message?: string }> };
    const message = parsed?.value?.[0]?.message ?? "";
    const line = message
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("AZMAN_DNS_VM_A="));
    if (!line) return [];

    const raw = line.slice("AZMAN_DNS_VM_A=".length).trim();
    if (!raw) return [];
    return unique(raw.split(",").map((v) => v.trim()));
  } catch (err) {
    const errorText = extractErrorText(err);
    printPermissionHint(errorText);
    return null;
  }
}

function printDiagnosis(fqdn: string, external: string[], vmValues: string[]): void {
  const overlap = vmValues.filter((ip) => external.includes(ip));
  const externalStr = external.length > 0 ? external.join(", ") : "<none>";
  const vmStr = vmValues.length > 0 ? vmValues.join(", ") : "<none>";

  console.log(chalk.bold(`\nDNS drift diagnosis for ${fqdn}`));
  console.log(`External/default resolver: ${externalStr}`);
  console.log(`Inside VM resolver:       ${vmStr}\n`);

  if (external.length === 0 && vmValues.length === 0) {
    console.log(chalk.yellow("Inconclusive: both external and VM lookups returned no A records.\n"));
    return;
  }

  if (overlap.length > 0 && external.length === vmValues.length && overlap.length === external.length) {
    console.log(chalk.green("No DNS drift detected: VM and external resolution are consistent.\n"));
    return;
  }

  if (overlap.length === 0) {
    const vmPrivate = vmValues.some(isPrivateIpv4);
    console.log(chalk.red("MISMATCH DETECTED: VM resolution differs from external resolution."));
    if (vmPrivate) {
      console.log(
        chalk.yellow(
          "VM resolved to private IP(s) while external resolved to different/public IP(s). Likely hosts override or internal DNS split-horizon.",
        ),
      );
    }
    console.log(chalk.gray("\nNext steps:"));
    console.log("1. Check VM hosts file for this FQDN override.");
    console.log("2. Query internal DNS zone/forwarder records for this FQDN.");
    console.log("3. Compare VM DNS server configuration with expected resolver.\n");
    return;
  }

  console.log(chalk.yellow("Partial mismatch: some records overlap, some differ."));
  console.log(chalk.gray("Check for stale cache, weighted records, or split DNS policies.\n"));
}

export async function diagnoseDnsDrift(input: DiagnoseDnsDriftInput): Promise<void> {
  const allVms = await listVms();
  const matches = findVmMatches(allVms, input.vmName);
  const vm = await selectVm(matches, input.vmName);
  if (!vm) {
    console.log(chalk.yellow(`No VM matched "${input.vmName}".`));
    return;
  }

  console.log(chalk.gray(`\nRunning DNS drift diagnosis for ${input.fqdn} using VM ${vm.name}...\n`));
  const external = await getExternalARecords(input.fqdn);
  const vmValues = await getVmARecords(vm, input.fqdn, input.server);
  if (vmValues === null) return;

  printDiagnosis(input.fqdn, external, vmValues);
}
