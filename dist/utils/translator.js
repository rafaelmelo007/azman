import { z } from "zod";
import { TRANSLATION_RULES } from "./translationRules.js";
const AzCommandSchema = z.object({
    kind: z.literal("az"),
    args: z.array(z.string()).min(1),
    explanation: z.string().optional(),
});
const ClarifySchema = z.object({
    kind: z.literal("clarify"),
    message: z.string(),
});
const ListTypeSchema = z.object({
    kind: z.literal("list_type"),
    requestedType: z.string(), // what user typed after "list"
    format: z.enum(["json", "table"]).optional(),
    explanation: z.string().optional(),
});
const TypesSchema = z.object({
    kind: z.literal("types"),
});
const SubscriptionsSchema = z.object({
    kind: z.literal("subscriptions"),
});
const SwitchSubscriptionSchema = z.object({
    kind: z.literal("switch_subscription"),
    target: z.string().min(1),
});
const TestDnsVmSchema = z.object({
    kind: z.literal("test_dns_vm"),
    vmName: z.string().min(1),
    fqdn: z.string().min(1),
    server: z.string().optional(),
});
const DiagnoseDnsDriftSchema = z.object({
    kind: z.literal("diagnose_dns_drift"),
    fqdn: z.string().min(1),
    vmName: z.string().min(1),
    server: z.string().optional(),
});
const ListVmHostOverridesSchema = z.object({
    kind: z.literal("list_vm_host_overrides"),
    vmName: z.string().min(1),
    pattern: z.string().optional(),
});
const AddVmHostOverrideSchema = z.object({
    kind: z.literal("add_vm_host_override"),
    vmName: z.string().min(1),
    ip: z.string().min(1),
    hostname: z.string().min(1),
});
const RemoveVmHostOverrideSchema = z.object({
    kind: z.literal("remove_vm_host_override"),
    vmName: z.string().min(1),
    hostname: z.string().min(1),
});
const InspectVmWindowsServicesSchema = z.object({
    kind: z.literal("inspect_vm_windows_services"),
    vmName: z.string().min(1),
    names: z.array(z.string()).optional(),
    pattern: z.string().optional(),
    runningOnly: z.boolean().optional(),
});
const StartVmWindowsServiceSchema = z.object({
    kind: z.literal("start_vm_windows_service"),
    vmName: z.string().min(1),
    serviceName: z.string().min(1),
});
const StopVmWindowsServiceSchema = z.object({
    kind: z.literal("stop_vm_windows_service"),
    vmName: z.string().min(1),
    serviceName: z.string().min(1),
});
const TestDnsReverseSchema = z.object({
    kind: z.literal("test_dns_reverse"),
    ip: z.string().min(1),
    server: z.string().optional(),
});
const TestFqdnPortsSchema = z.object({
    kind: z.literal("test_fqdn_ports"),
    fqdn: z.string().min(1),
    ports: z.array(z.number().int().min(1).max(65535)).min(1),
});
const TestDnsRecordSchema = z.object({
    kind: z.literal("test_dns_record"),
    fqdn: z.string().min(1),
    recordType: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"]),
    server: z.string().optional(),
});
const TestDnsSchema = z.object({
    kind: z.literal("test_dns"),
    fqdn: z.string().min(1),
    server: z.string().optional(),
    trace: z.boolean().optional(),
});
const TestPublicIpsSchema = z.object({
    kind: z.literal("test_public_ips"),
    port: z.number().int().min(1).max(65535).optional(),
    ports: z.array(z.number().int().min(1).max(65535)).min(1).optional(),
});
const OutputSchema = z.union([
    AzCommandSchema,
    ClarifySchema,
    ListTypeSchema,
    TypesSchema,
    SubscriptionsSchema,
    SwitchSubscriptionSchema,
    DiagnoseDnsDriftSchema,
    ListVmHostOverridesSchema,
    AddVmHostOverrideSchema,
    RemoveVmHostOverrideSchema,
    InspectVmWindowsServicesSchema,
    StartVmWindowsServiceSchema,
    StopVmWindowsServiceSchema,
    TestDnsVmSchema,
    TestDnsReverseSchema,
    TestFqdnPortsSchema,
    TestDnsRecordSchema,
    TestDnsSchema,
    TestPublicIpsSchema,
]);
export async function translateToAzCommand(userText) {
    const aiText = await callAI(userText);
    let parsed;
    try {
        parsed = JSON.parse(aiText);
    }
    catch {
        return { kind: "clarify", message: 'I could not understand that. Try: "list vm".' };
    }
    const out = OutputSchema.safeParse(parsed);
    if (!out.success) {
        return { kind: "clarify", message: "I could not map that to a command yet." };
    }
    return out.data;
}
function tokenize(text) {
    const cleaned = text.replace(/[^\w\s]/g, " ");
    return new Set(cleaned.split(/\s+/).filter(Boolean));
}
function scoreRule(ctx, words) {
    return words.reduce((score, word) => {
        const normalizedWord = word.trim().toLowerCase();
        if (!normalizedWord)
            return score;
        if (normalizedWord.includes(" ")) {
            return ctx.normalizedText.includes(normalizedWord) ? score + 1 : score;
        }
        return ctx.tokens.has(normalizedWord) ? score + 1 : score;
    }, 0);
}
async function callAI(user) {
    const normalizedText = user.trim().toLowerCase();
    const ctx = {
        normalizedText,
        tokens: tokenize(normalizedText),
        wantsJson: normalizedText.includes("json"),
    };
    const winner = TRANSLATION_RULES
        .map((rule) => {
        const score = scoreRule(ctx, rule.words);
        const minScore = rule.minScore ?? rule.words.length;
        if (score < minScore)
            return null;
        const output = rule.output(ctx);
        if (!output)
            return null;
        return { rule, score, output };
    })
        .filter((candidate) => candidate !== null)
        .sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        return a.rule.priority - b.rule.priority;
    })[0];
    if (winner) {
        return JSON.stringify(winner.output);
    }
    return JSON.stringify({
        kind: "clarify",
        message: 'Try: "list vm", "list resources", "test dns <fqdn>", "subscriptions", or "switch subscription <name>".',
    });
}
