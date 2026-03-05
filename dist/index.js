#!/usr/bin/env node
import prompts from "prompts";
import chalk from "chalk";
import ora from "ora";
import { execa } from "execa";
import { createInterface } from "node:readline";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { format } from "node:util";
import { translateToAzCommand } from "./utils/translator.js";
import { handleListType } from "./services/azureTypes.js";
import { testPublicIps } from "./services/publicIpTester.js";
import { testDns } from "./services/dnsTester.js";
import { testDnsOnVm } from "./services/vmDnsTester.js";
import { testDnsReverse } from "./services/dnsReverseTester.js";
import { testFqdnPorts } from "./services/fqdnPortTester.js";
import { testDnsRecord } from "./services/dnsRecordTester.js";
import { diagnoseDnsDrift } from "./services/dnsDriftDiagnoser.js";
import { addVmHostOverride, listVmHostOverrides, removeVmHostOverride, } from "./services/vmHostsInspector.js";
import { inspectVmWindowsServices, startVmWindowsService, stopVmWindowsService, } from "./services/vmWindowsServicesInspector.js";
import { getAccount, isAzureCliInstalled, listSubscriptions, loginAzure, setSubscription, } from "./utils/azRunner.js";
function normalizeForMatch(text) {
    return text.trim().toLowerCase();
}
function formatAccountLine(account) {
    const subscriptionName = account.name ?? "<unknown subscription>";
    const subscriptionId = account.id ?? "<unknown id>";
    const user = account.user?.name ?? "<unknown user>";
    return `User: ${user} | Subscription: ${subscriptionName} (${subscriptionId})`;
}
function buildPromptLabel(subscriptionName) {
    if (!subscriptionName)
        return "AzMan>";
    return `AzMan[${subscriptionName}]>`;
}
function stripAnsi(text) {
    return text.replace(/\u001b\[[0-9;]*m/g, "");
}
function createHistoryRecorder(filePath) {
    const original = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
    };
    let activeCapture = null;
    const tap = (method) => (...args) => {
        method(...args);
        if (!activeCapture)
            return;
        const line = stripAnsi(format(...args));
        activeCapture.responses.push(line);
    };
    console.log = tap(original.log);
    console.info = tap(original.info);
    console.warn = tap(original.warn);
    console.error = tap(original.error);
    return {
        start: (command, subscription) => {
            const capture = {
                timestamp: new Date().toISOString(),
                command,
                subscription,
                responses: [],
            };
            activeCapture = capture;
            return capture;
        },
        finish: async (capture) => {
            if (activeCapture === capture)
                activeCapture = null;
            const entry = {
                timestamp: capture.timestamp,
                subscription: capture.subscription ?? null,
                command: capture.command,
                response: capture.responses.join("\n").trim(),
                responseLines: capture.responses,
            };
            try {
                await mkdir(path.dirname(filePath), { recursive: true });
                await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
            }
            catch (err) {
                original.error(chalk.yellow(`Could not write history file: ${String(err)}`));
            }
        },
        restore: () => {
            console.log = original.log;
            console.info = original.info;
            console.warn = original.warn;
            console.error = original.error;
            activeCapture = null;
        },
    };
}
function findSubscriptionMatches(subscriptions, target) {
    const q = normalizeForMatch(target);
    if (!q)
        return [];
    const exactId = subscriptions.filter((s) => normalizeForMatch(s.id) === q);
    if (exactId.length > 0)
        return exactId;
    const exactName = subscriptions.filter((s) => normalizeForMatch(s.name) === q);
    if (exactName.length > 0)
        return exactName;
    return subscriptions.filter((s) => normalizeForMatch(s.name).includes(q) || normalizeForMatch(s.id).includes(q));
}
async function showSubscriptions() {
    const subs = await listSubscriptions();
    if (subs.length === 0) {
        console.log(chalk.yellow("No subscriptions found for this account."));
        return;
    }
    console.log(chalk.bold("\nSubscriptions:\n"));
    for (const sub of subs) {
        const marker = sub.isDefault ? "*" : " ";
        console.log(`${marker} ${sub.name} (${sub.id})${sub.state ? ` [${sub.state}]` : ""}`);
    }
    console.log(chalk.gray('\nTip: use "switch subscription <name or id>".\n'));
}
async function switchSubscription(target) {
    const subs = await listSubscriptions();
    const matches = findSubscriptionMatches(subs, target);
    if (matches.length === 0) {
        console.log(chalk.yellow(`No subscription matched "${target}".`));
        return;
    }
    let chosen = matches[0];
    if (matches.length > 1) {
        const pick = await prompts({
            type: "select",
            name: "subscriptionId",
            message: `Multiple matches for "${target}". Which subscription?`,
            choices: matches.map((sub) => ({
                title: `${sub.name} (${sub.id})${sub.state ? ` [${sub.state}]` : ""}`,
                value: sub.id,
            })),
        });
        if (!pick.subscriptionId)
            return;
        const selected = matches.find((sub) => sub.id === pick.subscriptionId);
        if (!selected)
            return;
        chosen = selected;
    }
    await setSubscription(chosen.id);
    const account = await getAccount();
    if (account) {
        console.log(chalk.green(`Switched to: ${account.name} (${account.id})\n`));
    }
    else {
        console.log(chalk.green(`Switched to: ${chosen.name} (${chosen.id})\n`));
    }
}
async function ensureAzureSession() {
    if (!(await isAzureCliInstalled())) {
        throw new Error("Azure CLI (az) is not installed or not in PATH.");
    }
    let account = await getAccount();
    if (!account) {
        console.log(chalk.yellow("You are not logged into Azure CLI."));
        const { doLogin } = await prompts({
            type: "confirm",
            name: "doLogin",
            message: "Login now with az login?",
            initial: true,
        });
        if (!doLogin) {
            throw new Error("Login is required to use AzMan.");
        }
        const ok = await loginAzure();
        if (!ok) {
            throw new Error("Azure login failed.");
        }
        account = await getAccount();
        if (!account) {
            throw new Error("Logged in, but unable to read Azure account context.");
        }
    }
    console.log(chalk.bold.cyan("\nWelcome to AzMan!\n"));
    console.log(chalk.gray(formatAccountLine(account)));
    console.log(chalk.gray('Type what you want (examples: "list vm", "list resources", "types").'));
    console.log(chalk.gray('Type "subscriptions" to list and "switch subscription <name or id>" to change context.'));
    console.log(chalk.gray('Type "exit" to quit.\n'));
}
async function readCommandLine(promptLabel, history) {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        historySize: 500,
        removeHistoryDuplicates: false,
    });
    rl.history = [...history];
    const text = await new Promise((resolve) => {
        rl.question(`${chalk.bold(promptLabel)} `, (answer) => resolve(answer));
    });
    const nextHistory = [...rl.history];
    rl.close();
    return { text, history: nextHistory };
}
async function main() {
    await ensureAzureSession();
    let currentSubscriptionName = (await getAccount())?.name;
    let commandHistory = [];
    const historyFilePath = path.join(process.cwd(), "logs", "azman-history.jsonl");
    const historyRecorder = createHistoryRecorder(historyFilePath);
    try {
        while (true) {
            const input = await readCommandLine(buildPromptLabel(currentSubscriptionName), commandHistory);
            commandHistory = input.history;
            const userText = (input.text ?? "").trim();
            if (!userText)
                continue;
            if (["exit", "quit", "bye"].includes(userText.toLowerCase())) {
                console.log(chalk.gray("Bye.\n"));
                return;
            }
            const capture = historyRecorder.start(userText, currentSubscriptionName);
            try {
                const cmd = await translateToAzCommand(userText);
                if (cmd.kind === "clarify") {
                    console.log(chalk.yellow(cmd.message));
                    continue;
                }
                if (cmd.kind === "list_type") {
                    await handleListType(cmd.requestedType, cmd.format ?? "table");
                    continue;
                }
                if (cmd.kind === "types") {
                    await handleListType("__SHOW_TYPES__", "table");
                    continue;
                }
                if (cmd.kind === "subscriptions") {
                    await showSubscriptions();
                    continue;
                }
                if (cmd.kind === "switch_subscription") {
                    try {
                        await switchSubscription(cmd.target);
                        currentSubscriptionName = (await getAccount())?.name;
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "test_public_ips") {
                    try {
                        const ports = cmd.ports && cmd.ports.length > 0 ? cmd.ports : [cmd.port ?? 443];
                        await testPublicIps(ports);
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "test_dns") {
                    try {
                        await testDns({ fqdn: cmd.fqdn, server: cmd.server, trace: cmd.trace });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "test_dns_vm") {
                    try {
                        await testDnsOnVm({ vmName: cmd.vmName, fqdn: cmd.fqdn, server: cmd.server });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "diagnose_dns_drift") {
                    try {
                        await diagnoseDnsDrift({ fqdn: cmd.fqdn, vmName: cmd.vmName, server: cmd.server });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "list_vm_host_overrides") {
                    try {
                        await listVmHostOverrides({ vmName: cmd.vmName, pattern: cmd.pattern });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "add_vm_host_override") {
                    try {
                        await addVmHostOverride({
                            vmName: cmd.vmName,
                            ip: cmd.ip,
                            hostname: cmd.hostname,
                        });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "remove_vm_host_override") {
                    try {
                        await removeVmHostOverride({
                            vmName: cmd.vmName,
                            hostname: cmd.hostname,
                        });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "inspect_vm_windows_services") {
                    try {
                        await inspectVmWindowsServices({
                            vmName: cmd.vmName,
                            names: cmd.names,
                            pattern: cmd.pattern,
                            runningOnly: cmd.runningOnly,
                        });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "start_vm_windows_service") {
                    try {
                        await startVmWindowsService({
                            vmName: cmd.vmName,
                            serviceName: cmd.serviceName,
                        });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "stop_vm_windows_service") {
                    try {
                        await stopVmWindowsService({
                            vmName: cmd.vmName,
                            serviceName: cmd.serviceName,
                        });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "test_dns_reverse") {
                    try {
                        await testDnsReverse({ ip: cmd.ip, server: cmd.server });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "test_dns_record") {
                    try {
                        await testDnsRecord({
                            fqdn: cmd.fqdn,
                            recordType: cmd.recordType,
                            server: cmd.server,
                        });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                if (cmd.kind === "test_fqdn_ports") {
                    try {
                        await testFqdnPorts({ fqdn: cmd.fqdn, ports: cmd.ports });
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red(message));
                    }
                    continue;
                }
                console.log(chalk.gray("\nProposed command:"));
                console.log(chalk.cyan(`az ${cmd.args.join(" ")}`));
                if (cmd.explanation)
                    console.log(chalk.gray(cmd.explanation));
                const { ok } = await prompts({
                    type: "confirm",
                    name: "ok",
                    message: "Run this command?",
                    initial: true,
                });
                if (!ok) {
                    console.log(chalk.gray("Ok, not running it.\n"));
                    continue;
                }
                const spinner = ora(chalk.gray("Running Azure command...")).start();
                try {
                    await execa("az", cmd.args, { stdio: "inherit" });
                    spinner.succeed(chalk.green("Command completed."));
                }
                catch (err) {
                    spinner.fail(chalk.red("Command failed."));
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(chalk.red(message));
                }
                console.log("");
            }
            finally {
                await historyRecorder.finish(capture);
            }
        }
    }
    finally {
        historyRecorder.restore();
    }
}
main().catch((err) => {
    console.error(chalk.red("Fatal error:"), err?.message ?? err);
    process.exit(1);
});
