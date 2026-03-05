import chalk from "chalk";
import ora from "ora";
import { Resolver, lookup } from "node:dns/promises";
import { isIP } from "node:net";

type TestDnsReverseInput = {
  ip: string;
  server?: string;
};

async function resolveServerAddress(server: string): Promise<string> {
  const value = server.trim();
  if (isIP(value)) return value;
  const resolved = await lookup(value);
  return resolved.address;
}

async function createResolver(server?: string): Promise<Resolver> {
  const resolver = new Resolver();
  if (server) {
    const address = await resolveServerAddress(server);
    resolver.setServers([address]);
  }
  return resolver;
}

export async function testDnsReverse(input: TestDnsReverseInput): Promise<void> {
  const ip = input.ip.trim();
  if (!isIP(ip)) {
    console.log(chalk.yellow(`"${input.ip}" is not a valid IP address.`));
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

  const spinner = ora(chalk.gray(`Running reverse DNS lookup for ${ip}...`)).start();
  try {
    const names = await resolver.reverse(ip);
    spinner.stop();
    console.log(chalk.bold(`\nReverse DNS for ${ip}`));
    console.log(chalk.gray(`Resolver: ${input.server ?? "system default"}`));
    if (names.length === 0) {
      console.log(chalk.yellow("PTR: no records\n"));
      return;
    }
    console.log(chalk.green(`PTR: ${names.join(", ")}\n`));
  } catch (err) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.bold(`\nReverse DNS for ${ip}`));
    console.log(chalk.gray(`Resolver: ${input.server ?? "system default"}`));
    console.log(chalk.yellow(`PTR: ${message}\n`));
  }
}
