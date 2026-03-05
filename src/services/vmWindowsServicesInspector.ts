import chalk from "chalk";
import prompts from "prompts";
import { execa } from "execa";

type VmInfo = {
  name: string;
  resourceGroup: string;
  osType?: string;
  powerState?: string;
};

type InspectVmWindowsServicesInput = {
  vmName: string;
  names?: string[];
  pattern?: string;
  runningOnly?: boolean;
};

type StartVmWindowsServiceInput = {
  vmName: string;
  serviceName: string;
};

type StopVmWindowsServiceInput = {
  vmName: string;
  serviceName: string;
};

type CommandError = {
  message?: string;
  stderr?: string;
  stdout?: string;
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

function extractErrorText(err: unknown): string {
  const e = err as CommandError;
  return (e.stderr ?? e.shortMessage ?? e.message ?? String(err)).trim();
}

function printErrorHelp(errorText: string): void {
  const text = errorText.toLowerCase();
  if (text.includes("authorizationfailed") || text.includes("does not have authorization")) {
    console.log(chalk.red("Could not inspect Windows services inside VM: missing permission."));
    console.log(
      chalk.yellow(
        'Need action: "Microsoft.Compute/virtualMachines/runCommand/action" (e.g., Virtual Machine Contributor).',
      ),
    );
    console.log(chalk.gray('Then refresh auth: "az account clear" and "az login".\n'));
    return;
  }

  console.log(chalk.red("Could not inspect Windows services inside VM."));
  const lines = errorText.split("\n").filter(Boolean).slice(0, 6);
  console.log(lines.join("\n"));
  if (errorText.split("\n").length > 6) console.log(chalk.gray("...truncated...\n"));
  else console.log("");
}

function isDebugEnabled(): boolean {
  const raw = (process.env.AZMAN_DEBUG_SERVICES ?? process.env.AZMAN_DEBUG ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function truncateDebug(text: string, limit = 2000): string {
  if (!text) return "<empty>";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...<truncated ${text.length - limit} chars>`;
}

function printDebugBlock(title: string, content: string): void {
  console.log(chalk.magenta(`[debug] ${title}`));
  console.log(chalk.gray(content));
}

function buildPowerShellScript(input: InspectVmWindowsServicesInput, includeProbe = false): string {
  const names = (input.names ?? [])
    .map((n) => n.replace(/'/g, "''").trim())
    .filter(Boolean);
  const pattern = (input.pattern ?? "").replace(/'/g, "''").trim();

  const statements: string[] = [];
  statements.push("$ErrorActionPreference = 'Stop'");
  if (includeProbe) statements.push("Write-Output 'AZMAN_PROBE=1'");
  statements.push("$services = Get-Service");

  if (names.length > 0) {
    const quoted = names.map((n) => `'${n}'`).join(",");
    statements.push(`$names = @(${quoted})`);
    statements.push(
      "$services = $services | Where-Object { $names -contains $_.Name -or $names -contains $_.DisplayName }",
    );
  } else if (pattern) {
    statements.push(
      `$services = $services | Where-Object { $_.Name -match '${pattern}' -or $_.DisplayName -match '${pattern}' }`,
    );
  }
  if (input.runningOnly !== undefined) {
    statements.push(
      input.runningOnly
        ? "$services = $services | Where-Object { $_.Status -eq 'Running' }"
        : "$services = $services | Where-Object { $_.Status -ne 'Running' }",
    );
  }
  statements.push("$rows = @($services | Select-Object Name,Status,DisplayName | Sort-Object Name)");
  statements.push("Write-Output ('AZMAN_SERVICES_COUNT=' + $rows.Count)");
  statements.push(
    "if ($rows.Count -gt 0) { ($rows | Format-Table -AutoSize | Out-String -Width 4096).TrimEnd() | Write-Output }",
  );
  return statements.join("; ");
}

function parseCountFromMessage(message: string): number | null {
  const matches = Array.from(message.matchAll(/AZMAN_SERVICES_COUNT=(\d+)/g));
  if (matches.length === 0) return null;

  const raw = matches[matches.length - 1]?.[1];
  const count = Number(raw);
  return Number.isFinite(count) ? count : null;
}

function stripCountLines(message: string): string {
  return message
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !line.startsWith("AZMAN_SERVICES_COUNT=") && line !== "AZMAN_PROBE=1")
    .join("\n")
    .trim();
}

function estimateRowsFromTable(tableOutput: string): number {
  return tableOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function formatFilterLabel(input: InspectVmWindowsServicesInput): string {
  const parts: string[] = [];
  if (input.names && input.names.length > 0) parts.push(`names=${input.names.join(",")}`);
  if (input.pattern) parts.push(`pattern=${input.pattern}`);
  if (input.runningOnly !== undefined) parts.push(`state=${input.runningOnly ? "running" : "not-running"}`);
  return `Filter: ${parts.join(" | ")}`;
}

function buildStartServiceScript(serviceName: string): string {
  const safeServiceName = serviceName.replace(/'/g, "''").trim();
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = '${safeServiceName}'`,
    "$svc = Get-Service | Where-Object { $_.Name -ieq $target -or $_.DisplayName -ieq $target } | Select-Object -First 1",
    "if (-not $svc) { Write-Output 'AZMAN_START_RESULT=NOT_FOUND'; return }",
    "if ($svc.Status -eq 'Running') { Write-Output ('AZMAN_START_RESULT=ALREADY_RUNNING|' + $svc.Name); return }",
    "Start-Service -Name $svc.Name",
    "$after = Get-Service -Name $svc.Name",
    "Write-Output ('AZMAN_START_RESULT=STARTED|' + $svc.Name + '|' + $after.Status)",
  ].join("; ");
}

function buildStopServiceScript(serviceName: string): string {
  const safeServiceName = serviceName.replace(/'/g, "''").trim();
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = '${safeServiceName}'`,
    "$svc = Get-Service | Where-Object { $_.Name -ieq $target -or $_.DisplayName -ieq $target } | Select-Object -First 1",
    "if (-not $svc) { Write-Output 'AZMAN_STOP_RESULT=NOT_FOUND'; return }",
    "if ($svc.Status -eq 'Stopped') { Write-Output ('AZMAN_STOP_RESULT=ALREADY_STOPPED|' + $svc.Name); return }",
    "Stop-Service -Name $svc.Name -Force",
    "$after = Get-Service -Name $svc.Name",
    "Write-Output ('AZMAN_STOP_RESULT=STOPPED|' + $svc.Name + '|' + $after.Status)",
  ].join("; ");
}

async function runVmScript(vm: VmInfo, script: string): Promise<{ stdout: string; stderr: string }> {
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
      "RunPowerShellScript",
      "--scripts",
      script,
      "-o",
      "json",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return { stdout: out.stdout, stderr: out.stderr };
}

export async function inspectVmWindowsServices(input: InspectVmWindowsServicesInput): Promise<void> {
  const allVms = await listVms();
  const matches = findVmMatches(allVms, input.vmName);
  const vm = await selectVm(matches, input.vmName);
  if (!vm) {
    console.log(chalk.yellow(`No VM matched "${input.vmName}".`));
    return;
  }

  if (normalize(vm.osType ?? "") !== "windows") {
    console.log(chalk.yellow(`VM "${vm.name}" is not Windows (detected: ${vm.osType ?? "unknown"}).\n`));
    return;
  }

  const script = buildPowerShellScript(input);
  console.log(chalk.gray(`\nChecking Windows services in VM ${vm.name} (${vm.resourceGroup})...\n`));

  try {
    const debugEnabled = isDebugEnabled();
    let run = await runVmScript(vm, script);
    let parsed = JSON.parse(run.stdout) as { value?: Array<{ message?: string; code?: string }> };
    let message = (parsed?.value ?? []).map((v) => v?.message ?? "").join("\n");

    if (!message.trim()) {
      const probeScript = buildPowerShellScript(input, true);
      if (debugEnabled) printDebugBlock("retry", "First run returned empty message; retrying with probe output.");
      run = await runVmScript(vm, probeScript);
      parsed = JSON.parse(run.stdout) as { value?: Array<{ message?: string; code?: string }> };
      message = (parsed?.value ?? []).map((v) => v?.message ?? "").join("\n");
      if (debugEnabled) printDebugBlock("probe script", probeScript);
    }

    const count = parseCountFromMessage(message);
    const tableOutput = stripCountLines(message);

    if (debugEnabled) {
      const codes = (parsed?.value ?? []).map((v) => v.code ?? "<no-code>").join(", ");
      printDebugBlock(
        "az vm run-command summary",
        `stdout.length=${run.stdout.length}\nstderr.length=${run.stderr.length}\nvalueItems=${parsed?.value?.length ?? 0}\ncodes=${codes || "<none>"}`,
      );
      printDebugBlock("script", script);
      printDebugBlock("raw stdout", truncateDebug(run.stdout));
      printDebugBlock("joined message", truncateDebug(message));
      printDebugBlock("parsed", `count=${count ?? "null"}\ntableOutput.length=${tableOutput.length}`);
    }

    console.log(chalk.bold(`Windows services in VM: ${vm.name}`));
    console.log(chalk.gray(formatFilterLabel(input)));
    console.log("");

    if (!message.trim()) {
      console.log(
        chalk.yellow(
          "Azure run-command returned empty stdout for this VM. Unable to read services output.\n",
        ),
      );
      return;
    }

    const estimatedRows = estimateRowsFromTable(tableOutput);
    const hasRows = tableOutput.length > 0 && estimatedRows > 0;
    if (count === 0 || (!hasRows && count === null)) {
      const noRowsMessage =
        input.runningOnly === true
          ? "No running services matched the filter.\n"
          : input.runningOnly === false
            ? "No non-running services matched the filter.\n"
            : "No services matched the filter.\n";
      console.log(chalk.yellow(noRowsMessage));
      return;
    }

    console.log(chalk.gray(`Matched services: ${count ?? `${estimatedRows}+ (count truncated)`}`));
    if (tableOutput) console.log(tableOutput);
    console.log("");
  } catch (err) {
    const errorText = extractErrorText(err);
    if (isDebugEnabled()) {
      const e = err as CommandError;
      printDebugBlock("error stderr", truncateDebug(e.stderr ?? "<empty>"));
      printDebugBlock("error stdout", truncateDebug(e.stdout ?? "<empty>"));
      printDebugBlock("error message", truncateDebug(errorText));
    }
    printErrorHelp(errorText);
  }
}

export async function startVmWindowsService(input: StartVmWindowsServiceInput): Promise<void> {
  const allVms = await listVms();
  const matches = findVmMatches(allVms, input.vmName);
  const vm = await selectVm(matches, input.vmName);
  if (!vm) {
    console.log(chalk.yellow(`No VM matched "${input.vmName}".`));
    return;
  }

  if (normalize(vm.osType ?? "") !== "windows") {
    console.log(chalk.yellow(`VM "${vm.name}" is not Windows (detected: ${vm.osType ?? "unknown"}).\n`));
    return;
  }

  const script = buildStartServiceScript(input.serviceName);
  console.log(
    chalk.gray(`\nStarting Windows service "${input.serviceName}" in VM ${vm.name} (${vm.resourceGroup})...\n`),
  );

  try {
    const run = await runVmScript(vm, script);
    const parsed = JSON.parse(run.stdout) as { value?: Array<{ message?: string; code?: string }> };
    const message = (parsed?.value ?? []).map((v) => v?.message ?? "").join("\n").trim();
    const debugEnabled = isDebugEnabled();

    if (debugEnabled) {
      const codes = (parsed?.value ?? []).map((v) => v.code ?? "<no-code>").join(", ");
      printDebugBlock(
        "az vm run-command summary",
        `stdout.length=${run.stdout.length}\nstderr.length=${run.stderr.length}\nvalueItems=${parsed?.value?.length ?? 0}\ncodes=${codes || "<none>"}`,
      );
      printDebugBlock("script", script);
      printDebugBlock("joined message", truncateDebug(message));
    }

    const resultLine = message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("AZMAN_START_RESULT="));
    const errorLine = message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("AZMAN_START_ERROR="));

    if (errorLine) {
      console.log(chalk.red(errorLine.replace("AZMAN_START_ERROR=", "")));
      console.log("");
      return;
    }

    if (!resultLine) {
      console.log(chalk.yellow("Could not determine service start result from VM output."));
      if (message) console.log(chalk.gray(message));
      console.log("");
      return;
    }

    const payload = resultLine.replace("AZMAN_START_RESULT=", "");
    const [status, name, afterStatus] = payload.split("|");

    if (status === "NOT_FOUND") {
      console.log(chalk.yellow(`Service "${input.serviceName}" was not found by Name or DisplayName.\n`));
      return;
    }

    if (status === "ALREADY_RUNNING") {
      console.log(chalk.green(`Service "${name ?? input.serviceName}" is already running.\n`));
      return;
    }

    if (status === "STARTED") {
      const currentStatus = (afterStatus ?? "").trim();
      if (normalize(currentStatus) === "running") {
        console.log(chalk.green(`Service "${name ?? input.serviceName}" started successfully.\n`));
      } else {
        console.log(
          chalk.yellow(
            `Start command executed for "${name ?? input.serviceName}", but current status is "${currentStatus || "unknown"}".\n`,
          ),
        );
      }
      return;
    }

    console.log(chalk.yellow(`Unexpected service start result: ${payload}\n`));
  } catch (err) {
    const errorText = extractErrorText(err);
    printErrorHelp(errorText);
  }
}

export async function stopVmWindowsService(input: StopVmWindowsServiceInput): Promise<void> {
  const allVms = await listVms();
  const matches = findVmMatches(allVms, input.vmName);
  const vm = await selectVm(matches, input.vmName);
  if (!vm) {
    console.log(chalk.yellow(`No VM matched "${input.vmName}".`));
    return;
  }

  if (normalize(vm.osType ?? "") !== "windows") {
    console.log(chalk.yellow(`VM "${vm.name}" is not Windows (detected: ${vm.osType ?? "unknown"}).\n`));
    return;
  }

  const script = buildStopServiceScript(input.serviceName);
  console.log(
    chalk.gray(`\nStopping Windows service "${input.serviceName}" in VM ${vm.name} (${vm.resourceGroup})...\n`),
  );

  try {
    const run = await runVmScript(vm, script);
    const parsed = JSON.parse(run.stdout) as { value?: Array<{ message?: string; code?: string }> };
    const message = (parsed?.value ?? []).map((v) => v?.message ?? "").join("\n").trim();
    const debugEnabled = isDebugEnabled();

    if (debugEnabled) {
      const codes = (parsed?.value ?? []).map((v) => v.code ?? "<no-code>").join(", ");
      printDebugBlock(
        "az vm run-command summary",
        `stdout.length=${run.stdout.length}\nstderr.length=${run.stderr.length}\nvalueItems=${parsed?.value?.length ?? 0}\ncodes=${codes || "<none>"}`,
      );
      printDebugBlock("script", script);
      printDebugBlock("joined message", truncateDebug(message));
    }

    const resultLine = message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("AZMAN_STOP_RESULT="));
    const errorLine = message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("AZMAN_STOP_ERROR="));

    if (errorLine) {
      console.log(chalk.red(errorLine.replace("AZMAN_STOP_ERROR=", "")));
      console.log("");
      return;
    }

    if (!resultLine) {
      console.log(chalk.yellow("Could not determine service stop result from VM output."));
      if (message) console.log(chalk.gray(message));
      console.log("");
      return;
    }

    const payload = resultLine.replace("AZMAN_STOP_RESULT=", "");
    const [status, name, afterStatus] = payload.split("|");

    if (status === "NOT_FOUND") {
      console.log(chalk.yellow(`Service "${input.serviceName}" was not found by Name or DisplayName.\n`));
      return;
    }

    if (status === "ALREADY_STOPPED") {
      console.log(chalk.green(`Service "${name ?? input.serviceName}" is already stopped.\n`));
      return;
    }

    if (status === "STOPPED") {
      const currentStatus = (afterStatus ?? "").trim();
      if (normalize(currentStatus) === "stopped") {
        console.log(chalk.green(`Service "${name ?? input.serviceName}" stopped successfully.\n`));
      } else {
        console.log(
          chalk.yellow(
            `Stop command executed for "${name ?? input.serviceName}", but current status is "${currentStatus || "unknown"}".\n`,
          ),
        );
      }
      return;
    }

    console.log(chalk.yellow(`Unexpected service stop result: ${payload}\n`));
  } catch (err) {
    const errorText = extractErrorText(err);
    printErrorHelp(errorText);
  }
}
