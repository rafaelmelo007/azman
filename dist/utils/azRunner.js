import { execa } from "execa";
async function runAz(args) {
    const result = await execa("az", args, { stdio: ["ignore", "pipe", "pipe"] });
    return result.stdout;
}
async function isAzureCliInstalled() {
    try {
        await execa("az", ["--version"], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
async function getAccount() {
    try {
        const out = await runAz(["account", "show", "--output", "json"]);
        return JSON.parse(out);
    }
    catch {
        return null; // not logged in (or az not configured)
    }
}
async function listSubscriptions() {
    const out = await runAz(["account", "list", "--output", "json"]);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
}
async function setSubscription(subscriptionIdOrName) {
    await execa("az", ["account", "set", "--subscription", subscriptionIdOrName], { stdio: "ignore" });
}
async function loginAzure() {
    try {
        // This will open browser/device login flow depending on environment
        await execa("az", ["login"], { stdio: "inherit" });
        return true;
    }
    catch {
        return false;
    }
}
async function listAllResources() {
    // Table is nice for humans; JSON is better for machines
    await execa("az", ["resource", "list", "--output", "table"], { stdio: "inherit" });
}
export { isAzureCliInstalled, getAccount, loginAzure, runAz, listAllResources };
export { listSubscriptions, setSubscription };
