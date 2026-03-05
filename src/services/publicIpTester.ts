import { execa } from "execa";
import chalk from "chalk";
import ora from "ora";
import net from "node:net";

async function getAssignedPublicIps(): Promise<string[]> {
  const result = await execa(
    "az",
    ["network", "public-ip", "list", "--query", "[?ipAddress!=null].ipAddress", "-o", "tsv"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function testTcpPort(ip: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, ip);
  });
}

export async function testPublicIps(portsInput: number[] = [443]): Promise<void> {
  const ports = Array.from(new Set(portsInput));
  const spinner = ora(chalk.gray("Loading public IPs from Azure...")).start();
  const ips = await getAssignedPublicIps();
  spinner.stop();

  if (ips.length === 0) {
    console.log(chalk.yellow("No assigned public IPs found."));
    return;
  }

  console.log(chalk.bold(`\nTesting ${ips.length} public IP(s) on TCP ports ${ports.join(", ")}:\n`));

  const statusByIp: Array<{ ip: string; byPort: Record<number, boolean> }> = [];
  for (const ip of ips) {
    const checks = await Promise.all(
      ports.map(async (port) => ({ port, ok: await testTcpPort(ip, port) })),
    );
    statusByIp.push({
      ip,
      byPort: Object.fromEntries(checks.map((c) => [c.port, c.ok])),
    });
  }

  const ipWidth = Math.max(15, ...ips.map((ip) => ip.length));
  const portHeader = ports.map((p) => `:${p}`).join(" | ");
  console.log(`${"IP".padEnd(ipWidth)} | ${portHeader}`);
  console.log(`${"-".repeat(ipWidth)}-+-${"-".repeat(portHeader.length)}`);

  for (const row of statusByIp) {
    const cells = ports
      .map((port) =>
        row.byPort[port]
          ? chalk.green("OPEN".padEnd(`:${port}`.length))
          : chalk.red("CLOSED".padEnd(`:${port}`.length)),
      )
      .join(" | ");
    console.log(`${row.ip.padEnd(ipWidth)} | ${cells}`);
  }

  console.log("");
}
