import { execa } from "execa";
import prompts from "prompts";
import chalk from "chalk";

async function runAz(args: string[]) {
  const r = await execa("az", args, { stdio: ["ignore", "pipe", "pipe"] });
  return r.stdout;
}

export async function getPresentResourceTypes(): Promise<string[]> {
  const out = await runAz(["resource", "list", "--query", "[].type", "-o", "tsv"]);
  const types = out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  return Array.from(new Set(types)).sort((a, b) => a.localeCompare(b));
}

function resolveType(userTypeRaw: string, presentTypes: string[]) {
  const q = userTypeRaw.trim().toLowerCase();
  if (!q) return null;

  const aliases: Record<string, string> = {
    vm: "Microsoft.Compute/virtualMachines",
    vms: "Microsoft.Compute/virtualMachines",
    "virtual machine": "Microsoft.Compute/virtualMachines",
    "virtual machines": "Microsoft.Compute/virtualMachines",
    "public ip": "Microsoft.Network/publicIPAddresses",
    "public ips": "Microsoft.Network/publicIPAddresses",
    publicip: "Microsoft.Network/publicIPAddresses",
    publicips: "Microsoft.Network/publicIPAddresses",
    nsg: "Microsoft.Network/networkSecurityGroups",
    vnet: "Microsoft.Network/virtualNetworks",
    kv: "Microsoft.KeyVault/vaults",
    keyvault: "Microsoft.KeyVault/vaults",
  };

  const aliasHit = aliases[q];
  if (aliasHit && presentTypes.includes(aliasHit)) return aliasHit;

  const exact = presentTypes.find((t) => t.toLowerCase() === q);
  if (exact) return exact;

  const contains = presentTypes.filter((t) => t.toLowerCase().includes(q));
  if (contains.length === 1) return contains[0];

  return { ambiguous: contains };
}

async function execListByType(resolvedType: string, format: "table" | "json") {
  await execa("az", ["resource", "list", "--resource-type", resolvedType, "-o", format], {
    stdio: "inherit",
  });
}

export async function handleListType(requestedType: string, format: "table" | "json") {
  const presentTypes = await getPresentResourceTypes();

  // Special internal command: show types
  if (requestedType === "__SHOW_TYPES__") {
    console.log(chalk.bold("\nResource types present in this subscription:\n"));
    presentTypes.forEach((t) => console.log(t));
    console.log("");
    return;
  }

  const resolved = resolveType(requestedType, presentTypes);

  if (!resolved) {
    console.log(chalk.yellow('Tell me a type. Example: "list vm"'));
    return;
  }

  if (typeof resolved === "object" && "ambiguous" in resolved) {
    const options = (resolved.ambiguous ?? []).slice(0, 20);

    if (options.length === 0) {
      console.log(chalk.yellow(`No matching types found for "${requestedType}".`));
      return;
    }

    const pick = await prompts({
      type: "select",
      name: "type",
      message: `Multiple matches for "${requestedType}". Which one?`,
      choices: options.map((t) => ({ title: t, value: t })),
    });

    if (!pick.type) return;
    await execListByType(pick.type, format);
    return;
  }

  await execListByType(resolved as string, format);
}
