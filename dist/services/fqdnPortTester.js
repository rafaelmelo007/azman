import chalk from "chalk";
import ora from "ora";
import { lookup } from "node:dns/promises";
import net from "node:net";
async function testTcpPort(host, port, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const done = (ok) => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
        socket.connect(port, host);
    });
}
export async function testFqdnPorts(input) {
    const fqdn = input.fqdn.trim();
    const ports = Array.from(new Set(input.ports)).sort((a, b) => a - b);
    const spinner = ora(chalk.gray(`Resolving ${fqdn}...`)).start();
    let resolvedAddresses = [];
    try {
        const resolved = await lookup(fqdn, { all: true });
        resolvedAddresses = resolved.map((entry) => entry.address);
    }
    catch {
        // Keep going with direct socket checks; DNS/connect errors will appear in checks.
    }
    finally {
        spinner.stop();
    }
    console.log(chalk.bold(`\nService check for ${fqdn}`));
    if (resolvedAddresses.length > 0) {
        console.log(chalk.gray(`Resolved IPs: ${resolvedAddresses.join(", ")}`));
    }
    else {
        console.log(chalk.gray("Resolved IPs: not resolved by lookup"));
    }
    const checks = await Promise.all(ports.map(async (port) => ({ port, ok: await testTcpPort(fqdn, port) })));
    const header = ports.map((port) => `:${port}`).join(" | ");
    console.log(`Target`.padEnd(Math.max(10, fqdn.length)) + ` | ${header}`);
    console.log(`${"-".repeat(Math.max(10, fqdn.length))}-+-${"-".repeat(header.length)}`);
    const statusCells = checks
        .map((check) => check.ok ? chalk.green("OPEN".padEnd(`:${check.port}`.length)) : chalk.red("CLOSED".padEnd(`:${check.port}`.length)))
        .join(" | ");
    console.log(`${fqdn.padEnd(Math.max(10, fqdn.length))} | ${statusCells}\n`);
}
