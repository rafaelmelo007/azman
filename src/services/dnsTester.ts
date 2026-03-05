import chalk from "chalk";
import ora from "ora";
import { execa } from "execa";
import { Resolver, lookup } from "node:dns/promises";

type TestDnsInput = {
  fqdn: string;
  server?: string;
  trace?: boolean;
};

function isLikelyFqdn(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 253) return false;
  return /^[a-z0-9.-]+$/i.test(v);
}

async function resolveServerAddress(server: string): Promise<string> {
  const value = server.trim();
  const isIpLike = /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(":");
  if (isIpLike) return value;

  const resolved = await lookup(value);
  return resolved.address;
}

async function createResolver(server?: string): Promise<Resolver> {
  const resolver = new Resolver();
  if (server) {
    const serverAddress = await resolveServerAddress(server);
    resolver.setServers([serverAddress]);
  }
  return resolver;
}

async function resolveSafe(fn: () => Promise<string[]>): Promise<{ values: string[]; error?: string }> {
  try {
    const values = await fn();
    return { values };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { values: [], error: message };
  }
}

export async function testDns(input: TestDnsInput): Promise<void> {
  const fqdn = input.fqdn.trim();
  if (!isLikelyFqdn(fqdn)) {
    console.log(chalk.yellow(`"${input.fqdn}" does not look like a valid DNS name.`));
    return;
  }

  let resolver: Resolver;
  try {
    resolver = await createResolver(input.server);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`Invalid DNS server "${input.server}": ${message}`));
    return;
  }
  const spinner = ora(chalk.gray(`Resolving DNS for ${fqdn}...`)).start();

  const [a, aaaa, cname, ns] = await Promise.all([
    resolveSafe(() => resolver.resolve4(fqdn)),
    resolveSafe(() => resolver.resolve6(fqdn)),
    resolveSafe(() => resolver.resolveCname(fqdn)),
    resolveSafe(() => resolver.resolveNs(fqdn)),
  ]);

  spinner.stop();

  console.log(chalk.bold(`\nDNS diagnostics for ${fqdn}`));
  console.log(chalk.gray(`Resolver: ${input.server ?? "system default"}`));

  const show = (label: string, values: string[], error?: string) => {
    if (values.length > 0) {
      console.log(chalk.green(`${label}: ${values.join(", ")}`));
      return;
    }
    if (error) {
      console.log(chalk.yellow(`${label}: ${error}`));
      return;
    }
    console.log(chalk.yellow(`${label}: no records`));
  };

  show("A", a.values, a.error);
  show("AAAA", aaaa.values, aaaa.error);
  show("CNAME", cname.values, cname.error);
  show("NS", ns.values, ns.error);

  if (input.trace) {
    console.log(chalk.bold("\nnslookup debug output:\n"));
    try {
      const args = ["-debug", fqdn];
      if (input.server) args.push(input.server);
      const out = await execa("nslookup", args, { stdio: ["ignore", "pipe", "pipe"] });
      const lines = out.stdout.split("\n").slice(0, 160);
      console.log(lines.join("\n"));
      if (out.stdout.split("\n").length > 160) {
        console.log(chalk.gray("\n...output truncated...\n"));
      } else {
        console.log("");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`Could not run nslookup trace: ${message}\n`));
    }
  } else {
    console.log("");
  }
}
