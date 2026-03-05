import type { TranslatorOutput } from "./translator.js";

export type MatchContext = {
  normalizedText: string;
  tokens: Set<string>;
  wantsJson: boolean;
};

export type TranslationRule = {
  id: string;
  priority: number; // lower number = higher priority
  words: string[];
  minScore?: number;
  output: (ctx: MatchContext) => TranslatorOutput | null;
};

function normalizeListType(raw: string): string {
  return raw.replace(/\s+as\s+json$/i, "").trim();
}

function wantsRunningOnly(normalizedText: string): boolean {
  if (/\bnot\s+running\b/i.test(normalizedText)) return false;
  return /\bonly\s+running\b|\brunning\s+only\b|\brunning\s+services?\b|\srunning$/i.test(
    normalizedText,
  );
}

function hasExplicitStateFilter(normalizedText: string): boolean {
  return /\bnot\s+running\b|\bonly\s+running\b|\brunning\s+only\b|\brunning\s+services?\b|\srunning$/i.test(
    normalizedText,
  );
}

export const TRANSLATION_RULES: TranslationRule[] = [
  {
    id: "types",
    priority: 1,
    words: ["types"],
    minScore: 1,
    output: ({ normalizedText }) => {
      if (
        normalizedText === "types" ||
        normalizedText === "list types" ||
        normalizedText === "show types"
      ) {
        return { kind: "types" };
      }
      return null;
    },
  },
  {
    id: "public_ips_shortcut",
    priority: 1,
    words: ["public", "ips"],
    minScore: 2,
    output: ({ normalizedText, wantsJson }) => {
      const isShortcut =
        normalizedText === "public ips" ||
        normalizedText === "public ip" ||
        normalizedText === "list public ips" ||
        normalizedText === "list public ip";

      if (!isShortcut) return null;

      return {
        kind: "az",
        args: [
          "network",
          "public-ip",
          "list",
          "--query",
          "[].{Name:name,ResourceGroup:resourceGroup,IpAddress:ipAddress,Location:location,ProvisioningState:provisioningState}",
          "--output",
          wantsJson ? "json" : "table",
        ],
        explanation: "Listing actual public IP addresses (ipAddress field).",
      };
    },
  },
  {
    id: "real_ips_shortcut",
    priority: 1,
    words: ["real", "ips"],
    minScore: 2,
    output: ({ normalizedText, wantsJson }) => {
      const isShortcut =
        normalizedText === "real ips" ||
        normalizedText === "real ip" ||
        normalizedText === "show real ips" ||
        normalizedText === "show real ip";

      if (!isShortcut) return null;

      return {
        kind: "az",
        args: [
          "network",
          "public-ip",
          "list",
          "--query",
          "[].{Name:name,ResourceGroup:resourceGroup,IpAddress:ipAddress,Location:location,ProvisioningState:provisioningState}",
          "--output",
          wantsJson ? "json" : "table",
        ],
        explanation: "Listing actual public IP addresses (ipAddress field).",
      };
    },
  },
  {
    id: "test_public_ips",
    priority: 1,
    words: ["test", "public", "ip"],
    minScore: 2,
    output: ({ normalizedText }) => {
      const match = normalizedText.match(/^test\s+public\s+ips?(?:\s+ports?\s+(.+))?$/i);
      if (!match) return null;

      const rawPorts = match[1];
      const ports = rawPorts
        ? rawPorts
            .replace(/,/g, " ")
            .split(/\s+/)
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => Number(p))
        : [443];

      const hasInvalidPort = ports.some(
        (port) => !Number.isInteger(port) || port < 1 || port > 65535,
      );
      if (ports.length === 0 || hasInvalidPort) {
        return {
          kind: "clarify",
          message:
            "Ports must be numbers between 1 and 65535. Example: test public ips ports 80 443",
        };
      }

      return {
        kind: "test_public_ips",
        ports: Array.from(new Set(ports)),
      };
    },
  },
  {
    id: "test_dns",
    priority: 1,
    words: ["dns", "test"],
    minScore: 1,
    output: ({ normalizedText }) => {
      const lead = normalizedText.match(/^(?:test|check|diagnose)\s+dns\s+(.+)$/i);
      if (!lead) return null;

      let rest = lead[1].trim();
      let trace = false;
      if (/\s+trace$/i.test(rest)) {
        trace = true;
        rest = rest.replace(/\s+trace$/i, "").trim();
      }

      let server: string | undefined;
      const withServer = rest.match(/^(.*?)\s+server\s+(\S+)$/i);
      if (withServer) {
        rest = withServer[1].trim();
        server = withServer[2].trim();
      }

      const fqdn = rest.trim();
      if (!fqdn) {
        return {
          kind: "clarify",
          message:
            "Try: test dns <fqdn> | test dns <fqdn> server <dns-ip> | test dns <fqdn> trace",
        };
      }

      return {
        kind: "test_dns",
        fqdn,
        server,
        trace,
      };
    },
  },
  {
    id: "test_dns_vm",
    priority: 0,
    words: ["dns", "vm", "test"],
    minScore: 2,
    output: ({ normalizedText }) => {
      const lead = normalizedText.match(
        /^(?:test|check|diagnose)\s+dns\s+(?:on|from)\s+vm\s+(\S+)\s+(?:for\s+)?(.+)$/i,
      );
      if (!lead) return null;

      const vmName = lead[1].trim();
      let rest = lead[2].trim();

      let server: string | undefined;
      const withServer = rest.match(/^(.*?)\s+server\s+(\S+)$/i);
      if (withServer) {
        rest = withServer[1].trim();
        server = withServer[2].trim();
      }

      const fqdn = rest.trim();
      if (!vmName || !fqdn) {
        return {
          kind: "clarify",
          message:
            "Try: test dns on vm <vm-name> <fqdn> | test dns on vm <vm-name> <fqdn> server <dns>",
        };
      }

      return {
        kind: "test_dns_vm",
        vmName,
        fqdn,
        server,
      };
    },
  },
  {
    id: "diagnose_dns_drift",
    priority: 0,
    words: ["diagnose", "dns", "drift", "vm"],
    minScore: 2,
    output: ({ normalizedText }) => {
      const match = normalizedText.match(
        /^(?:diagnose|analyze|check)\s+dns(?:\s+drift)?\s+(\S+)\s+vm\s+(\S+)(?:\s+server\s+(\S+))?$/i,
      );
      if (!match) return null;

      return {
        kind: "diagnose_dns_drift",
        fqdn: match[1].trim(),
        vmName: match[2].trim(),
        server: match[3]?.trim(),
      };
    },
  },
  {
    id: "list_vm_host_overrides",
    priority: 0,
    words: ["hosts", "vm", "override"],
    minScore: 1,
    output: ({ normalizedText }) => {
      const withPattern =
        normalizedText.match(
          /^(?:list|show|check)\s+(?:host|hosts)\s+(?:overrides?|entries)\s+(?:on|in)\s+vm\s+(\S+)\s+for\s+(.+)$/i,
        ) ||
        normalizedText.match(
          /^(?:list|show|check)\s+(?:host|hosts)\s+(?:overrides?|entries)\s+vm\s+(\S+)\s+for\s+(.+)$/i,
        );
      if (withPattern) {
        return {
          kind: "list_vm_host_overrides",
          vmName: withPattern[1].trim(),
          pattern: withPattern[2].trim(),
        };
      }

      const basic =
        normalizedText.match(
          /^(?:list|show|check)\s+(?:host|hosts)\s+(?:overrides?|entries)\s+(?:on|in)\s+vm\s+(\S+)$/i,
        ) ||
        normalizedText.match(
          /^(?:list|show|check)\s+(?:host|hosts)\s+(?:overrides?|entries)\s+vm\s+(\S+)$/i,
        );
      if (!basic) return null;

      return {
        kind: "list_vm_host_overrides",
        vmName: basic[1].trim(),
      };
    },
  },
  {
    id: "add_vm_host_override",
    priority: 0,
    words: ["add", "host", "vm"],
    minScore: 2,
    output: ({ normalizedText }) => {
      const vmThenEntry = normalizedText.match(
        /^(?:add|set|create)\s+(?:host|hosts)\s+(?:override|entry)?\s*(?:on|in)\s+vm\s+(\S+)\s+(\S+)\s+(\S+)$/i,
      );
      if (vmThenEntry) {
        const vmName = vmThenEntry[1].trim();
        const ip = vmThenEntry[2].trim();
        const hostname = vmThenEntry[3].trim();
        if (!vmName || !ip || !hostname) {
          return {
            kind: "clarify",
            message: "Try: add hosts override on vm <vm-name> <ip> <hostname>",
          };
        }
        return {
          kind: "add_vm_host_override",
          vmName,
          ip,
          hostname,
        };
      }

      const entryThenVm = normalizedText.match(
        /^(?:add|set|create)\s+(?:host|hosts)\s+(?:override|entry)?\s+(\S+)\s+(\S+)\s+(?:on|in)\s+vm\s+(\S+)$/i,
      );
      if (!entryThenVm) return null;

      const ip = entryThenVm[1].trim();
      const hostname = entryThenVm[2].trim();
      const vmName = entryThenVm[3].trim();
      if (!vmName || !ip || !hostname) {
        return {
          kind: "clarify",
          message: "Try: add hosts override on vm <vm-name> <ip> <hostname>",
        };
      }

      return {
        kind: "add_vm_host_override",
        vmName,
        ip,
        hostname,
      };
    },
  },
  {
    id: "remove_vm_host_override",
    priority: 0,
    words: ["remove", "host", "vm"],
    minScore: 2,
    output: ({ normalizedText }) => {
      const vmThenHost = normalizedText.match(
        /^(?:remove|delete)\s+(?:host|hosts)\s+(?:override|entry)?\s*(?:on|in)\s+vm\s+(\S+)\s+(\S+)$/i,
      );
      if (vmThenHost) {
        const vmName = vmThenHost[1].trim();
        const hostname = vmThenHost[2].trim();
        if (!vmName || !hostname) {
          return {
            kind: "clarify",
            message: "Try: remove hosts override on vm <vm-name> <hostname>",
          };
        }
        return {
          kind: "remove_vm_host_override",
          vmName,
          hostname,
        };
      }

      const hostThenVm = normalizedText.match(
        /^(?:remove|delete)\s+(?:host|hosts)\s+(?:override|entry)?\s+(\S+)\s+(?:on|in)\s+vm\s+(\S+)$/i,
      );
      if (!hostThenVm) return null;

      const hostname = hostThenVm[1].trim();
      const vmName = hostThenVm[2].trim();
      if (!vmName || !hostname) {
        return {
          kind: "clarify",
          message: "Try: remove hosts override on vm <vm-name> <hostname>",
        };
      }

      return {
        kind: "remove_vm_host_override",
        vmName,
        hostname,
      };
    },
  },
  {
    id: "start_vm_windows_service",
    priority: 0,
    words: ["start", "service", "vm"],
    minScore: 2,
    output: ({ normalizedText }) => {
      const serviceThenVm = normalizedText.match(
        /^(?:start|run)\s+(?:windows\s+)?services?\s+(.+?)\s+(?:on|in)\s+vm\s+(\S+)$/i,
      );
      if (serviceThenVm) {
        const serviceName = serviceThenVm[1].trim();
        const vmName = serviceThenVm[2].trim();
        if (!vmName || !serviceName) {
          return {
            kind: "clarify",
            message: "Try: start service <service-name> on vm <vm-name>",
          };
        }
        return {
          kind: "start_vm_windows_service",
          vmName,
          serviceName,
        };
      }

      const vmThenName = normalizedText.match(
        /^(?:start|run)\s+services?\s+(?:on|in)\s+vm\s+(\S+)\s+name\s+(.+)$/i,
      );
      if (!vmThenName) return null;

      const vmName = vmThenName[1].trim();
      const serviceName = vmThenName[2].trim();
      if (!vmName || !serviceName) {
        return {
          kind: "clarify",
          message: "Try: start service <service-name> on vm <vm-name>",
        };
      }

      return {
        kind: "start_vm_windows_service",
        vmName,
        serviceName,
      };
    },
  },
  {
    id: "stop_vm_windows_service",
    priority: 0,
    words: ["stop", "service", "vm"],
    minScore: 2,
    output: ({ normalizedText }) => {
      const serviceThenVm = normalizedText.match(
        /^(?:stop)\s+(?:windows\s+)?services?\s+(.+?)\s+(?:on|in)\s+vm\s+(\S+)$/i,
      );
      if (serviceThenVm) {
        const serviceName = serviceThenVm[1].trim();
        const vmName = serviceThenVm[2].trim();
        if (!vmName || !serviceName) {
          return {
            kind: "clarify",
            message: "Try: stop service <service-name> on vm <vm-name>",
          };
        }
        return {
          kind: "stop_vm_windows_service",
          vmName,
          serviceName,
        };
      }

      const vmThenName = normalizedText.match(
        /^(?:stop)\s+services?\s+(?:on|in)\s+vm\s+(\S+)\s+name\s+(.+)$/i,
      );
      if (!vmThenName) return null;

      const vmName = vmThenName[1].trim();
      const serviceName = vmThenName[2].trim();
      if (!vmName || !serviceName) {
        return {
          kind: "clarify",
          message: "Try: stop service <service-name> on vm <vm-name>",
        };
      }
      return {
        kind: "stop_vm_windows_service",
        vmName,
        serviceName,
      };
    },
  },
  {
    id: "inspect_vm_windows_services",
    priority: 0,
    words: ["service", "vm", "check"],
    minScore: 1,
    output: ({ normalizedText }) => {
      const runningOnly = wantsRunningOnly(normalizedText);
      const singleService =
        normalizedText.match(
          /^(?:check|show|list)\s+services?\s+(.+?)\s+(?:on|in)\s+vm\s+(\S+)(?:\s+(?:running|running\s+only|only\s+running|not\s+running))?$/i,
        ) ||
        normalizedText.match(
          /^(?:check|show|list)\s+service\s+(.+?)\s+vm\s+(\S+)$/i,
        );
      if (singleService) {
        const serviceName = singleService[1].trim();
        const vmName = singleService[2].trim();
        if (!serviceName || !vmName) {
          return {
            kind: "clarify",
            message: "Try: list service <service-name> on vm <vm-name>",
          };
        }
        return {
          kind: "inspect_vm_windows_services",
          vmName,
          names: [serviceName],
          ...(hasExplicitStateFilter(normalizedText) ? { runningOnly } : {}),
        };
      }

      const byNames =
        normalizedText.match(
          /^(?:check|show|list)\s+services?\s+(?:on|in)\s+vm\s+(\S+)\s+names?\s+(.+)$/i,
        ) ||
        normalizedText.match(
          /^(?:check|show|list)\s+services?\s+vm\s+(\S+)\s+names?\s+(.+)$/i,
        );
      if (byNames) {
        const names = byNames[2]
          .split(/[,\s]+/)
          .map((n) => n.trim())
          .filter(Boolean);
        if (names.length === 0) {
          return {
            kind: "clarify",
            message: "Try: check services on vm <vm-name> names Spooler W32Time",
          };
        }
        return {
          kind: "inspect_vm_windows_services",
          vmName: byNames[1].trim(),
          names: Array.from(new Set(names)),
          ...(hasExplicitStateFilter(normalizedText) ? { runningOnly } : {}),
        };
      }

      const byPattern =
        normalizedText.match(
          /^(?:check|show|list)\s+services?\s+(?:on|in)\s+vm\s+(\S+)\s+for\s+(.+)$/i,
        ) ||
        normalizedText.match(
          /^(?:check|show|list)\s+services?\s+vm\s+(\S+)\s+for\s+(.+)$/i,
        );
      if (byPattern) {
        return {
          kind: "inspect_vm_windows_services",
          vmName: byPattern[1].trim(),
          pattern: byPattern[2].trim(),
          ...(hasExplicitStateFilter(normalizedText) ? { runningOnly } : {}),
        };
      }

      const basic =
        normalizedText.match(
          /^(?:check|show|list)\s+services?\s+(?:on|in)\s+vm\s+(\S+)$/i,
        ) ||
        normalizedText.match(
          /^(?:check|show|list)\s+services?\s+vm\s+(\S+)$/i,
        );
      if (!basic) return null;

      return {
        kind: "inspect_vm_windows_services",
        vmName: basic[1].trim(),
        ...(hasExplicitStateFilter(normalizedText) ? { runningOnly } : {}),
      };
    },
  },
  {
    id: "test_dns_reverse",
    priority: 0,
    words: ["dns", "reverse", "ptr"],
    minScore: 1,
    output: ({ normalizedText }) => {
      const match =
        normalizedText.match(/^(?:test|check)\s+(?:dns\s+)?(?:reverse|ptr)\s+(\S+)(?:\s+server\s+(\S+))?$/i) ||
        normalizedText.match(/^(?:reverse|ptr)\s+dns\s+(\S+)(?:\s+server\s+(\S+))?$/i);
      if (!match) return null;

      return {
        kind: "test_dns_reverse",
        ip: match[1].trim(),
        server: match[2]?.trim(),
      };
    },
  },
  {
    id: "test_dns_record",
    priority: 0,
    words: ["dns", "record", "test"],
    minScore: 2,
    output: ({ normalizedText }) => {
      const match = normalizedText.match(
        /^(?:test|check)\s+dns\s+record\s+(\S+)\s+(a|aaaa|cname|mx|txt|ns|srv)(?:\s+server\s+(\S+))?$/i,
      );
      if (!match) return null;
      const recordType = match[2].toUpperCase() as "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV";

      return {
        kind: "test_dns_record",
        fqdn: match[1].trim(),
        recordType,
        server: match[3]?.trim(),
      };
    },
  },
  {
    id: "test_fqdn_ports",
    priority: 0,
    words: ["test", "service", "fqdn", "port"],
    minScore: 2,
    output: ({ normalizedText }) => {
      const match =
        normalizedText.match(/^(?:test|check)\s+(?:service|fqdn)\s+(\S+)(?:\s+ports?\s+(.+))?$/i) ||
        normalizedText.match(/^test\s+ports?\s+on\s+(\S+)(?:\s+ports?\s+(.+))?$/i);
      if (!match) return null;

      const fqdn = match[1].trim();
      const rawPorts = match[2];
      const ports = rawPorts
        ? rawPorts
            .replace(/,/g, " ")
            .split(/\s+/)
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => Number(p))
        : [443];

      const hasInvalidPort = ports.some(
        (port) => !Number.isInteger(port) || port < 1 || port > 65535,
      );
      if (!fqdn || ports.length === 0 || hasInvalidPort) {
        return {
          kind: "clarify",
          message:
            "Try: test service <fqdn> ports 443 8443 (ports must be 1-65535)",
        };
      }

      return {
        kind: "test_fqdn_ports",
        fqdn,
        ports: Array.from(new Set(ports)),
      };
    },
  },
  {
    id: "list_resources",
    priority: 1,
    words: ["list", "resources"],
    minScore: 2,
    output: ({ wantsJson }) => ({
      kind: "az",
      args: ["resource", "list", "--output", wantsJson ? "json" : "table"],
      explanation: "Listing all resources in the current subscription.",
    }),
  },
  {
    id: "list_subscriptions",
    priority: 1,
    words: ["subscriptions"],
    minScore: 1,
    output: ({ normalizedText }) => {
      if (
        normalizedText === "subscriptions" ||
        normalizedText === "list subscriptions" ||
        normalizedText === "show subscriptions"
      ) {
        return { kind: "subscriptions" };
      }
      return null;
    },
  },
  {
    id: "switch_subscription",
    priority: 1,
    words: ["subscription", "use"],
    minScore: 1,
    output: ({ normalizedText }) => {
      const match =
        normalizedText.match(/^(?:switch|change|use|set)\s+subscription\s+(.+)$/i) ||
        normalizedText.match(/^(?:switch|change|use|set)\s+(.+?)\s+subscription$/i) ||
        normalizedText.match(/^(?:switch|change|set)\s+to\s+(.+?)\s+subscription$/i) ||
        normalizedText.match(/^use\s+(.+)$/i);
      if (!match) return null;

      const target = match[1].trim();
      if (!target) {
        return {
          kind: "clarify",
          message: 'Try: switch subscription "<name or id>"',
        };
      }

      return {
        kind: "switch_subscription",
        target,
      };
    },
  },
  {
    id: "show_account",
    priority: 1,
    words: ["account", "who am i"],
    minScore: 1,
    output: ({ normalizedText, wantsJson }) => {
      const isShowAccount =
        normalizedText === "show account" ||
        normalizedText === "account" ||
        normalizedText === "current account" ||
        normalizedText === "who am i" ||
        normalizedText === "show current account";

      if (!isShowAccount) return null;

      return {
        kind: "az",
        args: ["account", "show", "--output", wantsJson ? "json" : "table"],
        explanation: "Showing current Azure account context.",
      };
    },
  },
  {
    id: "list_type",
    priority: 2,
    words: ["list"],
    minScore: 1,
    output: ({ normalizedText, wantsJson }) => {
      const match = normalizedText.match(/^list\s+(.+)$/i);
      if (!match) return null;

      const requestedType = normalizeListType(match[1]);
      if (!requestedType || requestedType === "resource" || requestedType === "resources") {
        return null;
      }
      if (requestedType === "types") return null;

      return {
        kind: "list_type",
        requestedType,
        format: wantsJson ? "json" : "table",
        explanation: `Listing resources matching "${requestedType}".`,
      };
    },
  },
];
