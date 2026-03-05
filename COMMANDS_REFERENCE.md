# AzMan Command Reference

This file lists the currently supported natural-language commands and their accepted variants.

## Session Commands

- `exit`
- `quit`
- `bye`

## Types Catalog

- `types`
- `list types`
- `show types`

Behavior:
- Shows resource types present in the current subscription.

## List Resources (All)

- Any phrase containing both `list` and `resource`/`resources`
- Example: `list resources`
- Example: `please list all resources`

Behavior:
- Runs `az resource list --output table` (or `json` when `json` is present in the text).

## Show Account Context

- Any phrase containing one of:
- `account`
- `subscription`
- `who am i`

Examples:
- `show account`
- `subscription`
- `who am i`

Behavior:
- Runs `az account show --output table` (or `json` when `json` is present in the text).

## Subscriptions

- `subscriptions`
- `list subscriptions`
- `show subscriptions`

Behavior:
- Lists all subscriptions available to the logged-in identity.
- Marks the current/default subscription.

## Switch Subscription

- `switch subscription <name or id>`
- `use <name or id>`
- `use <name or id> subscription`
- `change subscription <name or id>`
- `use subscription <name or id>`
- `set subscription <name or id>`
- `switch to <name or id> subscription`

Behavior:
- Switches active Azure context to the matched subscription.
- If multiple subscriptions match, AzMan asks you to choose one.
- `use <name>` defaults to subscription switch.

## Public IPs (Actual IP Address Field)

- `public ips`
- `public ip`
- `list public ips`
- `list public ip`
- `real ips`
- `real ip`
- `show real ips`
- `show real ip`

Behavior:
- Runs:
- `az network public-ip list --query "[].{Name:name,ResourceGroup:resourceGroup,IpAddress:ipAddress,Location:location,ProvisioningState:provisioningState}" --output table`
- Uses `--output json` if `json` is present in the text.

## Test Public IPs (TCP Reachability Matrix)

- `test public ips`
- `test public ip`
- `test public ips port 443`
- `test public ips ports 80 443 25`
- `test public ips ports 80,443,25`

Behavior:
- Default port: `443` when no port is provided.
- Builds an IP x Port matrix and prints `OPEN` or `CLOSED`.
- Port validation: each port must be `1-65535`.

## DNS Diagnostics

- `test dns <fqdn>`
- `check dns <fqdn>`
- `diagnose dns <fqdn>`
- `test dns <fqdn> server <dns-server-ip>`
- `test dns <fqdn> trace`
- `test dns <fqdn> server <dns-server-ip> trace`

Behavior:
- Runs DNS diagnostics from a dedicated command service.
- Shows A, AAAA, CNAME, and NS lookup results.
- `server <ip>` uses a specific DNS server for the lookup.
- `trace` appends `nslookup -debug` output (truncated for readability).

## Reverse DNS (PTR)

- `test reverse dns <ip>`
- `check ptr <ip>`
- `reverse dns <ip> server <dns-server>`

Behavior:
- Resolves IP to hostname(s) via PTR lookup.
- Optional custom resolver with `server <dns-server>`.

## DNS Record Type Lookup

- `test dns record <fqdn> A`
- `test dns record <fqdn> AAAA`
- `test dns record <fqdn> CNAME`
- `test dns record <fqdn> MX`
- `test dns record <fqdn> TXT`
- `test dns record <fqdn> NS`
- `test dns record <fqdn> SRV`
- `test dns record <fqdn> MX server <dns-server>`

Behavior:
- Queries one specific record type for focused troubleshooting.

## Service Connectivity By FQDN

- `test service <fqdn>`
- `test service <fqdn> port 443`
- `test service <fqdn> ports 22 443 8443`
- `test fqdn <fqdn> ports 80,443`

Behavior:
- Resolves the FQDN and tests TCP reachability to selected ports.
- Shows `OPEN`/`CLOSED` matrix for the target FQDN.

## DNS Diagnostics From Inside a VM

- `test dns on vm <vm-name> <fqdn>`
- `check dns on vm <vm-name> <fqdn>`
- `diagnose dns from vm <vm-name> <fqdn>`
- `test dns on vm <vm-name> <fqdn> server <dns-server>`

Behavior:
- Runs DNS test inside the Azure VM using `az vm run-command invoke`.
- Automatically uses PowerShell script for Windows VMs and shell script for Linux VMs.
- Useful to validate DNS resolution from the VM network context.

## DNS Drift Diagnosis (Interpreted Verdict)

- `diagnose dns drift <fqdn> vm <vm-name>`
- `diagnose dns <fqdn> vm <vm-name>`
- `check dns <fqdn> vm <vm-name> server <dns-server>`

Behavior:
- Compares external/default A record resolution vs VM-side resolution.
- Prints an interpreted verdict:
- `No DNS drift detected`
- `MISMATCH DETECTED` with likely causes and next steps.

## VM Hosts Overrides

- `list hosts overrides in vm <vm-name>`
- `show hosts entries vm <vm-name>`
- `check hosts overrides on vm <vm-name> for <hostname>`
- `add hosts override on vm <vm-name> <ip> <hostname>`
- `remove hosts override on vm <vm-name> <hostname>`

Behavior:
- Reads non-comment hosts file entries inside the VM via `az vm run-command invoke`.
- Optional `for <hostname>` filters to matching entries only.
- `add` inserts a new `<ip> <hostname>` mapping if it does not already exist.
- `remove` deletes mappings for the hostname.

## Windows Services In VM

- `check services on vm <vm-name>`
- `show services on vm <vm-name> for <pattern>`
- `check services on vm <vm-name> names Spooler W32Time`
- `check running services on vm <vm-name>`

Behavior:
- Runs `Get-Service` inside Windows VM via `az vm run-command invoke`.
- Default mode lists only non-running services.
- If command includes `running`, it filters to running services only.
- Optional `names ...` and `for ...` are applied as additional filters.
- Shows `Name`, `Status`, and `DisplayName`.

## Start Windows Service In VM

- `start service <service-name> on vm <vm-name>`
- `start windows service <service-name> on vm <vm-name>`

Behavior:
- Runs `Start-Service` inside Windows VM via `az vm run-command invoke`.
- Service name matching is case-insensitive and checks both service `Name` and `DisplayName`.
- Reports whether service was started, already running, or not found.

## Stop Windows Service In VM

- `stop service <service-name> on vm <vm-name>`
- `stop windows service <service-name> on vm <vm-name>`

Behavior:
- Runs `Stop-Service -Force` inside Windows VM via `az vm run-command invoke`.
- Service name matching is case-insensitive and checks both service `Name` and `DisplayName`.
- Reports whether service was stopped, already stopped, or not found.

## List by Resource Type (Generic)

Pattern:
- `list <type>`

Examples:
- `list vm`
- `list virtual machines`
- `list nsg`
- `list vnet`
- `list keyvault`
- `list microsoft.compute/virtualmachines`
- `list vm as json`

Behavior:
- Resolves aliases/exact/contains match against resource types present in the subscription.
- Lists only matched type resources.
- If multiple matches exist, prompts you to choose one.
- Supports `as json` suffix for JSON output.

Current aliases:
- `vm`, `vms`, `virtual machine`, `virtual machines` -> `Microsoft.Compute/virtualMachines`
- `public ip`, `public ips`, `publicip`, `publicips` -> `Microsoft.Network/publicIPAddresses`
- `nsg` -> `Microsoft.Network/networkSecurityGroups`
- `vnet` -> `Microsoft.Network/virtualNetworks`
- `kv`, `keyvault` -> `Microsoft.KeyVault/vaults`

## Fallback

If text does not match any supported command, AzMan returns a clarification message with examples.

## Command History Log

- AzMan writes command history to `logs/azman-history.jsonl`.
- Each line is a JSON object with:
- `timestamp` (ISO datetime)
- `subscription`
- `command`
- `response` and `responseLines`
