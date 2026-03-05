import chalk from "chalk";
import prompts from "prompts";
import { execa } from "execa";
function normalize(text) {
    return text.trim().toLowerCase();
}
function findVmMatches(vms, target) {
    const q = normalize(target);
    if (!q)
        return [];
    const exact = vms.filter((vm) => normalize(vm.name) === q);
    if (exact.length > 0)
        return exact;
    return vms.filter((vm) => normalize(vm.name).includes(q));
}
async function listVms() {
    const out = await execa("az", [
        "vm",
        "list",
        "-d",
        "--query",
        "[].{name:name,resourceGroup:resourceGroup,osType:storageProfile.osDisk.osType,powerState:powerState}",
        "-o",
        "json",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const parsed = JSON.parse(out.stdout);
    return Array.isArray(parsed) ? parsed : [];
}
async function selectVm(matches, vmName) {
    if (matches.length === 0)
        return null;
    if (matches.length === 1)
        return matches[0];
    const pick = await prompts({
        type: "select",
        name: "vm",
        message: `Multiple VMs match "${vmName}". Which VM?`,
        choices: matches.map((vm) => ({
            title: `${vm.name} (${vm.resourceGroup})${vm.powerState ? ` [${vm.powerState}]` : ""}`,
            value: `${vm.resourceGroup}:::${vm.name}`,
        })),
    });
    if (!pick.vm)
        return null;
    const [resourceGroup, name] = String(pick.vm).split(":::");
    return matches.find((vm) => vm.resourceGroup === resourceGroup && vm.name === name) ?? null;
}
function buildScript(osType, fqdn, server) {
    const target = fqdn.replace(/"/g, "");
    const dnsServer = (server ?? "").replace(/"/g, "");
    const hasServer = dnsServer.length > 0;
    const isWindows = normalize(osType ?? "") === "windows";
    if (isWindows) {
        return hasServer ? `nslookup ${target} ${dnsServer}` : `nslookup ${target}`;
    }
    if (hasServer) {
        return [
            "if command -v nslookup >/dev/null 2>&1; then",
            `  nslookup ${target} ${dnsServer}`,
            "elif command -v dig >/dev/null 2>&1; then",
            `  dig ${target} @${dnsServer}`,
            "else",
            '  echo "Neither nslookup nor dig is installed" >&2',
            "  exit 1",
            "fi",
        ].join("\n");
    }
    return [
        "if command -v nslookup >/dev/null 2>&1; then",
        `  nslookup ${target}`,
        "elif command -v dig >/dev/null 2>&1; then",
        `  dig ${target}`,
        "else",
        '  echo "Neither nslookup nor dig is installed" >&2',
        "  exit 1",
        "fi",
    ].join("\n");
}
function extractErrorText(err) {
    const e = err;
    return (e.stderr ?? e.shortMessage ?? e.message ?? String(err)).trim();
}
function printVmRunCommandHelp(errorText, vm) {
    const text = errorText.toLowerCase();
    if (text.includes("authorizationfailed") || text.includes("does not have authorization")) {
        console.log(chalk.red("Could not run command inside VM: missing permission."));
        console.log(chalk.yellow("Required permission: Microsoft.Compute/virtualMachines/runCommand/action"));
        console.log(chalk.gray("\nHow to fix:"));
        console.log(`1. Ask admin to grant you "Virtual Machine Contributor" on VM/RG/subscription scope.`);
        console.log(`2. Refresh credentials: run "az account clear" then "az login".`);
        console.log(`3. Retry the command.\n`);
        console.log(chalk.gray(`VM: ${vm.name} | Resource Group: ${vm.resourceGroup}\n`));
        return;
    }
    if (text.includes("resourcegroupnotfound") || text.includes("could not be found")) {
        console.log(chalk.red("VM or resource group not found in current subscription."));
        console.log(chalk.gray("Check subscription context and VM name, then retry.\n"));
        return;
    }
    if (text.includes("runcommand") && text.includes("not found")) {
        console.log(chalk.red("Run Command extension/capability is unavailable on this VM."));
        console.log(chalk.gray("Ensure VM agent is healthy and Run Command is supported.\n"));
        return;
    }
    console.log(chalk.red("Could not run DNS test inside VM."));
    console.log(chalk.yellow("Azure CLI returned an error. See summary below:"));
    const lines = errorText.split("\n").filter(Boolean).slice(0, 6);
    console.log(lines.join("\n"));
    if (errorText.split("\n").length > 6) {
        console.log(chalk.gray("...truncated...\n"));
    }
    else {
        console.log("");
    }
}
export async function testDnsOnVm(input) {
    const allVms = await listVms();
    const matches = findVmMatches(allVms, input.vmName);
    const vm = await selectVm(matches, input.vmName);
    if (!vm) {
        console.log(chalk.yellow(`No VM matched "${input.vmName}".`));
        return;
    }
    const osType = vm.osType ?? "Linux";
    const commandId = normalize(osType) === "windows" ? "RunPowerShellScript" : "RunShellScript";
    const script = buildScript(osType, input.fqdn, input.server);
    console.log(chalk.gray(`\nRunning DNS check inside VM ${vm.name} (${vm.resourceGroup}) using ${commandId}...\n`));
    let message = "";
    try {
        const out = await execa("az", [
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
        ], { stdio: ["ignore", "pipe", "pipe"] });
        const parsed = JSON.parse(out.stdout);
        message = parsed?.value?.[0]?.message ?? "";
    }
    catch (err) {
        const errorText = extractErrorText(err);
        printVmRunCommandHelp(errorText, vm);
        return;
    }
    console.log(chalk.bold(`DNS check in VM: ${vm.name}`));
    console.log(chalk.gray(`Target: ${input.fqdn}${input.server ? ` | Server: ${input.server}` : ""}\n`));
    if (message) {
        console.log(message.trim());
        console.log("");
    }
    else {
        console.log(chalk.yellow("No output returned by run-command.\n"));
    }
}
