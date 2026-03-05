import chalk from "chalk";
import ora from "ora";
import { Resolver, lookup } from "node:dns/promises";
import { isIP } from "node:net";
async function resolveServerAddress(server) {
    const value = server.trim();
    if (isIP(value))
        return value;
    const resolved = await lookup(value);
    return resolved.address;
}
async function createResolver(server) {
    const resolver = new Resolver();
    if (server) {
        const address = await resolveServerAddress(server);
        resolver.setServers([address]);
    }
    return resolver;
}
function formatValues(type, values) {
    if (type === "TXT") {
        return values.map((parts) => parts.join(""));
    }
    if (type === "MX") {
        return values.map((v) => `${v.exchange} (priority ${v.priority})`);
    }
    if (type === "SRV") {
        const srvValues = values;
        return srvValues.map((v) => `${v.name}:${v.port} (priority ${v.priority}, weight ${v.weight})`);
    }
    return values.map((v) => String(v));
}
async function resolveByType(resolver, fqdn, recordType) {
    switch (recordType) {
        case "A":
            return resolver.resolve4(fqdn);
        case "AAAA":
            return resolver.resolve6(fqdn);
        case "CNAME":
            return resolver.resolveCname(fqdn);
        case "MX":
            return resolver.resolveMx(fqdn);
        case "TXT":
            return resolver.resolveTxt(fqdn);
        case "NS":
            return resolver.resolveNs(fqdn);
        case "SRV":
            return resolver.resolveSrv(fqdn);
        default:
            return [];
    }
}
export async function testDnsRecord(input) {
    let resolver;
    try {
        resolver = await createResolver(input.server);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.yellow(`Invalid DNS server "${input.server}": ${message}`));
        return;
    }
    const spinner = ora(chalk.gray(`Resolving ${input.recordType} for ${input.fqdn}...`)).start();
    try {
        const values = await resolveByType(resolver, input.fqdn, input.recordType);
        spinner.stop();
        const formatted = formatValues(input.recordType, values);
        console.log(chalk.bold(`\nDNS ${input.recordType} for ${input.fqdn}`));
        console.log(chalk.gray(`Resolver: ${input.server ?? "system default"}`));
        if (formatted.length === 0) {
            console.log(chalk.yellow(`${input.recordType}: no records\n`));
            return;
        }
        console.log(chalk.green(`${input.recordType}: ${formatted.join(", ")}\n`));
    }
    catch (err) {
        spinner.stop();
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.bold(`\nDNS ${input.recordType} for ${input.fqdn}`));
        console.log(chalk.gray(`Resolver: ${input.server ?? "system default"}`));
        console.log(chalk.yellow(`${input.recordType}: ${message}\n`));
    }
}
