import chalk from "chalk";
import prompts from "prompts";
import { execa } from "execa";

type VmInfo = {
  name: string;
  resourceGroup: string;
  osType?: string;
  powerState?: string;
};

type ListVmHostOverridesInput = {
  vmName: string;
  pattern?: string;
};

type AddVmHostOverrideInput = {
  vmName: string;
  ip: string;
  hostname: string;
};

type RemoveVmHostOverrideInput = {
  vmName: string;
  hostname: string;
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

function buildScript(osType: string | undefined, pattern?: string): string {
  const p = (pattern ?? "").replace(/"/g, "");
  const hasPattern = p.length > 0;
  const isWindows = normalize(osType ?? "") === "windows";

  if (isWindows) {
    if (hasPattern) {
      return [
        "$path='C:\\Windows\\System32\\drivers\\etc\\hosts'",
        "$lines = Get-Content $path | Where-Object { $_ -match '^[^#].+\\s+\\S+' }",
        `$lines | Select-String -Pattern "${p}"`,
      ].join("\n");
    }
    return [
      "$path='C:\\Windows\\System32\\drivers\\etc\\hosts'",
      "Get-Content $path | Where-Object { $_ -match '^[^#].+\\s+\\S+' }",
    ].join("\n");
  }

  if (hasPattern) {
    return `grep -Ev '^\\s*#|^\\s*$' /etc/hosts | grep -i '${p}'`;
  }
  return "grep -Ev '^\\s*#|^\\s*$' /etc/hosts";
}

function buildAddHostScript(osType: string | undefined, ip: string, hostname: string): string {
  const safeIp = ip.replace(/'/g, "''").trim();
  const safeHost = hostname.replace(/'/g, "''").trim();
  const isWindows = normalize(osType ?? "") === "windows";

  if (isWindows) {
    return [
      "$ErrorActionPreference='Stop'",
      "$path='C:\\Windows\\System32\\drivers\\etc\\hosts'",
      `$ip='${safeIp}'`,
      `$targetHost='${safeHost}'`,
      "$existing = Get-Content $path | Where-Object { $_ -match ('^\\s*' + [regex]::Escape($ip) + '\\s+' + [regex]::Escape($targetHost) + '\\s*$') }",
      "if ($existing) { Write-Output 'AZMAN_HOSTS_RESULT=ALREADY_EXISTS'; return }",
      "Add-Content -Path $path -Value ($ip + ' ' + $targetHost)",
      "Write-Output 'AZMAN_HOSTS_RESULT=ADDED'",
    ].join("; ");
  }

  return [
    "set -e",
    "HOSTS_FILE='/etc/hosts'",
    `IP='${safeIp}'`,
    `HOST='${safeHost}'`,
    "if grep -Eiq \"^[[:space:]]*$IP[[:space:]]+$HOST([[:space:]]|$)\" \"$HOSTS_FILE\"; then echo 'AZMAN_HOSTS_RESULT=ALREADY_EXISTS'; exit 0; fi",
    "echo \"$IP $HOST\" >> \"$HOSTS_FILE\"",
    "echo 'AZMAN_HOSTS_RESULT=ADDED'",
  ].join("; ");
}

function buildRemoveHostScript(osType: string | undefined, hostname: string): string {
  const safeHost = hostname.replace(/'/g, "''").trim();
  const isWindows = normalize(osType ?? "") === "windows";

  if (isWindows) {
    return [
      "$ErrorActionPreference='Stop'",
      "$path='C:\\Windows\\System32\\drivers\\etc\\hosts'",
      `$targetHost='${safeHost}'`,
      "$before = Get-Content $path",
      "$updated = $before | Where-Object { $_ -notmatch ('^\\s*\\S+\\s+' + [regex]::Escape($targetHost) + '(\\s+|$)') }",
      "if ($updated.Count -eq $before.Count) { Write-Output 'AZMAN_HOSTS_RESULT=NOT_FOUND'; return }",
      "Set-Content -Path $path -Value $updated",
      "Write-Output 'AZMAN_HOSTS_RESULT=REMOVED'",
    ].join("; ");
  }

  return [
    "set -e",
    "HOSTS_FILE='/etc/hosts'",
    `HOST='${safeHost}'`,
    "TMP='/tmp/azman-hosts.$$'",
    "if ! grep -Eiq \"^[[:space:]]*[^#[:space:]]+[[:space:]]+$HOST([[:space:]]|$)\" \"$HOSTS_FILE\"; then echo 'AZMAN_HOSTS_RESULT=NOT_FOUND'; exit 0; fi",
    "awk -v h=\"$HOST\" 'BEGIN{IGNORECASE=1} !($0 ~ \"^[[:space:]]*[^#[:space:]]+[[:space:]]+\" h \"([[:space:]]|$)\")' \"$HOSTS_FILE\" > \"$TMP\"",
    "cat \"$TMP\" > \"$HOSTS_FILE\"",
    "rm -f \"$TMP\"",
    "echo 'AZMAN_HOSTS_RESULT=REMOVED'",
  ].join("; ");
}

function extractErrorText(err: unknown): string {
  const e = err as CommandError;
  return (e.stderr ?? e.shortMessage ?? e.message ?? String(err)).trim();
}

function printErrorHelp(errorText: string): void {
  const text = errorText.toLowerCase();
  if (text.includes("authorizationfailed") || text.includes("does not have authorization")) {
    console.log(chalk.red("Could not inspect hosts file inside VM: missing permission."));
    console.log(
      chalk.yellow(
        'Need action: "Microsoft.Compute/virtualMachines/runCommand/action" (e.g., Virtual Machine Contributor).',
      ),
    );
    console.log(chalk.gray('Then refresh auth: "az account clear" and "az login".\n'));
    return;
  }

  console.log(chalk.red("Could not inspect hosts file inside VM."));
  const lines = errorText.split("\n").filter(Boolean).slice(0, 6);
  console.log(lines.join("\n"));
  if (errorText.split("\n").length > 6) console.log(chalk.gray("...truncated...\n"));
  else console.log("");
}

export async function listVmHostOverrides(input: ListVmHostOverridesInput): Promise<void> {
  const allVms = await listVms();
  const matches = findVmMatches(allVms, input.vmName);
  const vm = await selectVm(matches, input.vmName);
  if (!vm) {
    console.log(chalk.yellow(`No VM matched "${input.vmName}".`));
    return;
  }

  const commandId = normalize(vm.osType ?? "") === "windows" ? "RunPowerShellScript" : "RunShellScript";
  const script = buildScript(vm.osType, input.pattern);

  console.log(
    chalk.gray(
      `\nReading hosts overrides in VM ${vm.name} (${vm.resourceGroup})...\n`,
    ),
  );

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
    const message = parsed?.value?.[0]?.message?.trim() ?? "";

    console.log(chalk.bold(`Hosts overrides in VM: ${vm.name}`));
    if (input.pattern) {
      console.log(chalk.gray(`Filter: ${input.pattern}`));
    }
    console.log("");

    if (!message) {
      console.log(chalk.yellow("No hosts entries found (or no output returned).\n"));
      return;
    }

    const cleaned = message
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .join("\n");
    console.log(cleaned);
    console.log("");
  } catch (err) {
    const errorText = extractErrorText(err);
    printErrorHelp(errorText);
  }
}

async function resolveVm(vmName: string): Promise<VmInfo | null> {
  const allVms = await listVms();
  const matches = findVmMatches(allVms, vmName);
  return selectVm(matches, vmName);
}

async function runVmCommand(vm: VmInfo, script: string): Promise<string> {
  const commandId = normalize(vm.osType ?? "") === "windows" ? "RunPowerShellScript" : "RunShellScript";
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
  return (parsed?.value ?? []).map((v) => v?.message ?? "").join("\n").trim();
}

function parseHostsActionResult(message: string): "ADDED" | "REMOVED" | "NOT_FOUND" | "ALREADY_EXISTS" | null {
  const line = message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("AZMAN_HOSTS_RESULT="));
  if (!line) return null;
  const value = line.slice("AZMAN_HOSTS_RESULT=".length).trim();
  if (value === "ADDED" || value === "REMOVED" || value === "NOT_FOUND" || value === "ALREADY_EXISTS") {
    return value;
  }
  return null;
}

export async function addVmHostOverride(input: AddVmHostOverrideInput): Promise<void> {
  const vm = await resolveVm(input.vmName);
  if (!vm) {
    console.log(chalk.yellow(`No VM matched "${input.vmName}".`));
    return;
  }

  console.log(chalk.gray(`\nAdding hosts override in VM ${vm.name} (${vm.resourceGroup})...\n`));
  try {
    const script = buildAddHostScript(vm.osType, input.ip, input.hostname);
    const message = await runVmCommand(vm, script);
    const result = parseHostsActionResult(message);

    if (result === "ALREADY_EXISTS") {
      console.log(chalk.yellow(`Hosts override already exists: ${input.ip} ${input.hostname}\n`));
      return;
    }
    if (result === "ADDED") {
      console.log(chalk.green(`Hosts override added: ${input.ip} ${input.hostname}\n`));
      return;
    }

    console.log(chalk.yellow("Could not confirm add result from VM output."));
    if (message) console.log(chalk.gray(message));
    console.log("");
  } catch (err) {
    const errorText = extractErrorText(err);
    printErrorHelp(errorText);
  }
}

export async function removeVmHostOverride(input: RemoveVmHostOverrideInput): Promise<void> {
  const vm = await resolveVm(input.vmName);
  if (!vm) {
    console.log(chalk.yellow(`No VM matched "${input.vmName}".`));
    return;
  }

  console.log(chalk.gray(`\nRemoving hosts override in VM ${vm.name} (${vm.resourceGroup})...\n`));
  try {
    const script = buildRemoveHostScript(vm.osType, input.hostname);
    const message = await runVmCommand(vm, script);
    const result = parseHostsActionResult(message);

    if (result === "NOT_FOUND") {
      console.log(chalk.yellow(`No hosts override found for hostname "${input.hostname}".\n`));
      return;
    }
    if (result === "REMOVED") {
      console.log(chalk.green(`Hosts override removed for hostname "${input.hostname}".\n`));
      return;
    }

    console.log(chalk.yellow("Could not confirm remove result from VM output."));
    if (message) console.log(chalk.gray(message));
    console.log("");
  } catch (err) {
    const errorText = extractErrorText(err);
    printErrorHelp(errorText);
  }
}
