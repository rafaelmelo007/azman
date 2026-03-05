import { execa } from "execa";

type AzAccount = {
  id?: string;
  name?: string;
  user?: { name?: string; type?: string };
  tenantId?: string;
};

type AzSubscription = {
  id: string;
  name: string;
  state?: string;
  isDefault?: boolean;
  tenantId?: string;
};


async function runAz(args: string[]) {
  const result = await execa("az", args, { stdio: ["ignore", "pipe", "pipe"] });
  return result.stdout;
}

async function isAzureCliInstalled(): Promise<boolean> {
  try {
    await execa("az", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function getAccount(): Promise<AzAccount | null> {
  try {
    const out = await runAz(["account", "show", "--output", "json"]);
    return JSON.parse(out) as AzAccount;
  } catch {
    return null; // not logged in (or az not configured)
  }
}

async function listSubscriptions(): Promise<AzSubscription[]> {
  const out = await runAz(["account", "list", "--output", "json"]);
  const parsed = JSON.parse(out) as AzSubscription[];
  return Array.isArray(parsed) ? parsed : [];
}

async function setSubscription(subscriptionIdOrName: string): Promise<void> {
  await execa("az", ["account", "set", "--subscription", subscriptionIdOrName], { stdio: "ignore" });
}

async function loginAzure(): Promise<boolean> {
  try {
    // This will open browser/device login flow depending on environment
    await execa("az", ["login"], { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

async function listAllResources(): Promise<void> {
  // Table is nice for humans; JSON is better for machines
  await execa("az", ["resource", "list", "--output", "table"], { stdio: "inherit" });
}


export { isAzureCliInstalled, getAccount, loginAzure, runAz, listAllResources };
export type { AzAccount, AzSubscription };
export { listSubscriptions, setSubscription };
