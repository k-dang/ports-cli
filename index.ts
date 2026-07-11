#!/usr/bin/env node

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  outro,
  spinner,
} from "@clack/prompts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type RawPortEntry = {
  address: string;
  port: number;
  pid?: number;
  processName?: string;
  command?: string;
  owner?: string;
};

export type PortEntry = {
  addresses: string[];
  port: number;
  pid?: number;
  processName?: string;
  command?: string;
  owner?: string;
  label: string;
  canClose: boolean;
  disabledReason?: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const COMMON_PORT_LABELS = new Map<number, string>([
  [3000, "Next.js / React"],
  [3001, "Next.js / React"],
  [4200, "Angular"],
  [5000, "Flask / local API"],
  [5001, "Flask / local API"],
  [5173, "Vite"],
  [5174, "Vite"],
  [5432, "PostgreSQL service"],
  [6379, "Redis service"],
  [8000, "Local web server"],
  [8080, "Local web server"],
  [8787, "Cloudflare Workers"],
  [9229, "Node inspector"],
  [3306, "MySQL service"],
  [27017, "MongoDB service"],
]);

export function labelEntry(entry: { port: number; command?: string }): string {
  return COMMON_PORT_LABELS.get(entry.port) ?? describeCommand(entry.command) ?? "Unknown local service";
}

// Summarizes a command line as its first two non-flag arguments, e.g.
// "node --inspect …\api\server.js" -> "server.js",
// "node …\node_modules\next\dist\bin\next dev" -> "next dev".
export function describeCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;

  const words: string[] = [];
  for (const part of splitCommandLine(command).slice(1)) {
    if (part.startsWith("-")) continue;
    words.push(shortenPathArg(part));
    if (words.length === 2) break;
  }

  return words.length > 0 ? words.join(" ") : undefined;
}

function splitCommandLine(command: string): string[] {
  return (command.trim().match(/"[^"]*"|\S+/g) ?? []).map((part) => part.replace(/^"|"$/g, ""));
}

// "…/node_modules/.bin/vite" -> "vite", "…/node_modules/@angular/cli/bin/ng" -> "@angular/cli",
// any other path -> its basename. The leading greedy .* anchors to the LAST node_modules,
// so pnpm's nested "node_modules/.pnpm/…/node_modules/pkg" resolves to "pkg". Prefixed with the
// project directory (the folder right before the FIRST node_modules) so that two projects
// running the same tool don't collapse to the same label.
function shortenPathArg(arg: string): string {
  const packageMatch = /.*node_modules[\\/](?:\.bin[\\/])?((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(arg);
  if (packageMatch) {
    const pkg = packageMatch[1]!.replace(/\\/g, "/");
    const projectDir = /^(.*?)[\\/]node_modules[\\/]/.exec(arg)?.[1];
    const projectName = projectDir ? projectDir.split(/[\\/]/).filter(Boolean).at(-1) : undefined;
    return projectName ? `${projectName}/${pkg}` : pkg;
  }

  const segments = arg.split(/[\\/]/).filter(Boolean);
  return segments.length > 1 ? segments.slice(-2).join("/") : (segments.at(-1) ?? arg);
}

const LABEL_WIDTH = 22;
const COMPACT_HINT_WIDTH = 56;

export type LabelColumns = {
  displayLabels: string[];
  ambiguous: boolean[];
};

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function truncateMiddle(text: string, width: number): string {
  if (text.length <= width) return text;
  const ellipsis = "…";
  const budget = width - ellipsis.length;
  const headLen = Math.ceil(budget / 2);
  const tailLen = Math.floor(budget / 2);
  return `${text.slice(0, headLen)}${ellipsis}${text.slice(text.length - tailLen)}`;
}

function appendOrdinalToDuplicates(columns: string[], width: number): string[] {
  const occurrence = new Map<string, number>();
  return columns.map((column) => {
    const index = (occurrence.get(column) ?? 0) + 1;
    occurrence.set(column, index);
    if (index === 1) return column;
    const suffix = ` #${index}`;
    const maxBase = width - suffix.length;
    const base = column.length <= maxBase ? column : truncate(column, maxBase);
    return (base + suffix).slice(0, width);
  });
}

export function disambiguate(labels: string[], width: number): string[] {
  let columns = labels.map((label) => truncateMiddle(label, width));
  if (new Set(columns).size < columns.length) {
    columns = appendOrdinalToDuplicates(columns, width);
  }
  return columns;
}

export function resolveLabelColumns(entries: PortEntry[]): LabelColumns {
  // Middle-truncate by default so long project prefixes don't hide the tool/script suffix
  // (e.g. "rental-property-management-app/wrangler dev" → "rental-prop…angler dev").
  const displayLabels = entries.map((entry) => truncateMiddle(entry.label, LABEL_WIDTH));
  const ambiguous = Array.from({ length: entries.length }, () => false);
  const groups = new Map<string, number[]>();

  for (let i = 0; i < entries.length; i++) {
    const naive = displayLabels[i]!;
    const indices = groups.get(naive) ?? [];
    indices.push(i);
    groups.set(naive, indices);
  }

  for (const indices of groups.values()) {
    if (indices.length <= 1) continue;
    const labels = indices.map((i) => entries[i]!.label);
    const distinct = new Set(labels).size > 1;

    if (distinct) {
      const disambiguated = disambiguate(labels, LABEL_WIDTH);
      for (let j = 0; j < indices.length; j++) {
        const index = indices[j]!;
        displayLabels[index] = disambiguated[j]!;
        ambiguous[index] = true;
      }
      continue;
    }

    // Same label on many ports (one wrangler, many listeners): escalate the focus hint.
    if (labels[0]!.length > LABEL_WIDTH) {
      for (const index of indices) ambiguous[index] = true;
    }
  }

  return { displayLabels, ambiguous };
}

// Matches runtime names with optional version suffixes, e.g. "python3.12", "ruby3.2".
const DEV_RUNTIME_PATTERN = /^(node|bun|deno|python|py|ruby|php|java|dotnet)[\d.]*$/;

export function isDevRuntimeEntry(entry: { processName?: string; command?: string }): boolean {
  const name = entry.processName ?? commandName(entry.command);
  if (!name) return false;
  return DEV_RUNTIME_PATTERN.test(name.toLowerCase().replace(/\.exe$/, ""));
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.")
  );
}

// Wildcard binds (how most dev servers listen) accept loopback connections too.
export function isLocalListenerAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "*" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "0:0:0:0:0:0:0:0" ||
    isLoopbackAddress(address)
  );
}

function parseEndpoint(endpoint: string): { address: string; port: number } | undefined {
  const trimmed = endpoint.trim();

  const bracketMatch = /^\[([^\]]+)]:(\d+)$/.exec(trimmed);
  if (bracketMatch) {
    return { address: bracketMatch[1]!, port: Number(bracketMatch[2]) };
  }

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) return undefined;

  const address = trimmed.slice(0, lastColon);
  const port = Number(trimmed.slice(lastColon + 1));
  if (!Number.isInteger(port)) return undefined;

  return { address, port };
}

export function parseLsofOutput(output: string): RawPortEntry[] {
  const entries: RawPortEntry[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("COMMAND")) continue;

    const parts = trimmed.split(/\s+/);
    const pid = Number(parts[1]);
    const tcpIndex = parts.indexOf("TCP");
    if (!Number.isInteger(pid) || tcpIndex === -1) continue;

    const endpoint = parseEndpoint(parts[tcpIndex + 1] ?? "");
    if (!endpoint || !isLocalListenerAddress(endpoint.address)) continue;

    entries.push({
      address: endpoint.address,
      port: endpoint.port,
      pid,
      processName: parts[0],
      owner: parts[2],
    });
  }

  return entries;
}

export function parseSsOutput(output: string): RawPortEntry[] {
  const entries: RawPortEntry[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("State")) continue;

    const parts = trimmed.split(/\s+/);
    if (parts[0] !== "LISTEN") continue;

    const endpoint = parseEndpoint(parts[3] ?? "");
    if (!endpoint || !isLocalListenerAddress(endpoint.address)) continue;

    const pidMatch = /pid=(\d+)/.exec(trimmed);
    const processMatch = /"([^"]+)"/.exec(trimmed);

    entries.push({
      address: endpoint.address,
      port: endpoint.port,
      pid: pidMatch ? Number(pidMatch[1]) : undefined,
      processName: processMatch?.[1],
    });
  }

  return entries;
}

export function parsePowerShellJson(output: string): RawPortEntry[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const parsed = JSON.parse(trimmed) as unknown;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const entries: RawPortEntry[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const address = String(record.LocalAddress ?? "");
    const port = Number(record.LocalPort);
    const pid = Number(record.OwningProcess);
    if (!Number.isInteger(port) || !isLocalListenerAddress(address)) continue;

    entries.push({
      address,
      port,
      pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
      processName: stringValue(record.ProcessName),
      command: stringValue(record.CommandLine) ?? stringValue(record.Path),
    });
  }

  return entries;
}

export function mergePortEntries(rawEntries: RawPortEntry[]): PortEntry[] {
  const merged = new Map<string, Omit<PortEntry, "label" | "canClose" | "disabledReason">>();

  for (const entry of rawEntries) {
    const key = entryKey(entry);
    const existing = merged.get(key);

    if (existing) {
      if (!existing.addresses.includes(entry.address)) existing.addresses.push(entry.address);
      existing.processName ??= entry.processName;
      existing.command ??= entry.command;
      existing.owner ??= entry.owner;
      continue;
    }

    merged.set(key, {
      addresses: [entry.address],
      port: entry.port,
      pid: entry.pid,
      processName: entry.processName,
      command: entry.command,
      owner: entry.owner,
    });
  }

  return Array.from(merged.values())
    .map((entry) => ({ ...entry, label: labelEntry(entry), ...closeability(entry) }))
    .sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

export function formatPortOption(
  entry: PortEntry,
  labelColumn: string = truncateMiddle(entry.label, LABEL_WIDTH),
): string {
  const pid = entry.pid ? `pid ${entry.pid}` : "owner unavailable";
  const processName = entry.processName ?? commandName(entry.command) ?? "unknown";
  return `${String(entry.port).padEnd(5)} ${labelColumn.padEnd(LABEL_WIDTH)} ${pid.padEnd(18)} ${processName}`.trimEnd();
}

/** Focus hint for the multiselect. Prefer a short summary; never dump full argv. */
export function portOptionHint(entry: PortEntry, ambiguous: boolean): string | undefined {
  if (entry.disabledReason) return entry.disabledReason;

  const summary = describeCommand(entry.command);
  if (summary && summary !== entry.label) return summary;
  if (ambiguous && entry.command) return truncate(entry.command, COMPACT_HINT_WIDTH);
  return undefined;
}

function entryKey(entry: { pid?: number; port: number }): string {
  return `${entry.pid ?? "unknown"}:${entry.port}`;
}

function uniquePids(entries: { pid?: number }[]): number[] {
  return Array.from(new Set(entries.map((entry) => entry.pid).filter((pid): pid is number => Boolean(pid))));
}

function closeability(entry: { pid?: number }): Pick<PortEntry, "canClose" | "disabledReason"> {
  if (!entry.pid) return { canClose: false, disabledReason: "owner unavailable" };
  if (entry.pid === process.pid) return { canClose: false, disabledReason: "current process" };
  if (!canSignalProcess(entry.pid)) return { canClose: false, disabledReason: "requires elevated permissions" };
  return { canClose: true };
}

function canSignalProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function commandName(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const first = splitCommandLine(command)[0];
  if (!first) return undefined;
  return first.split(/[\\/]/).at(-1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(command: string[]): Promise<CommandResult> {
  const [file, ...args] = command;
  try {
    const child = spawn(file!, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 0));
    });

    return { exitCode, stdout, stderr };
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function detectRawPorts(): Promise<RawPortEntry[]> {
  if (process.platform === "win32") return detectWindowsPorts();
  return detectUnixPorts();
}

async function detectUnixPorts(): Promise<RawPortEntry[]> {
  const lsof = await runCommand(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]);
  let entries = lsof.exitCode === 0 ? parseLsofOutput(lsof.stdout) : [];
  if (entries.length === 0) {
    const ss = await runCommand(["ss", "-H", "-ltnp"]);
    entries = ss.exitCode === 0 ? parseSsOutput(ss.stdout) : [];
  }
  await hydrateUnixCommands(entries);
  return entries;
}

async function detectWindowsPorts(): Promise<RawPortEntry[]> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$connections = @(Get-NetTCPConnection -State Listen)
$owningPids = @($connections | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)

$processes = @{}
Get-Process -Id $owningPids | ForEach-Object { $processes[[int]$_.Id] = $_ }

$commandLines = @{}
if ($owningPids.Count -gt 0) {
  $filter = ($owningPids | ForEach-Object { "ProcessId = $_" }) -join ' OR '
  Get-CimInstance Win32_Process -Filter $filter | ForEach-Object { $commandLines[[int]$_.ProcessId] = $_.CommandLine }
}

$connections |
  ForEach-Object {
    $process = $processes[[int]$_.OwningProcess]
    [pscustomobject]@{
      LocalAddress = $_.LocalAddress
      LocalPort = $_.LocalPort
      OwningProcess = $_.OwningProcess
      ProcessName = $process.ProcessName
      Path = $process.Path
      CommandLine = $commandLines[[int]$_.OwningProcess]
    }
  } |
  ConvertTo-Json -Compress
`;

  const powershell = await runCommand(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
  const result = powershell.exitCode === 0 ? powershell : await runCommand(["pwsh", "-NoProfile", "-Command", script]);
  return result.exitCode === 0 ? parsePowerShellJson(result.stdout) : [];
}

async function hydrateUnixCommands(entries: RawPortEntry[]): Promise<void> {
  const pids = uniquePids(entries);
  if (pids.length === 0) return;

  const result = await runCommand(["ps", "-p", pids.join(","), "-o", "pid=", "-o", "command="]);
  if (result.exitCode !== 0) return;

  const commands = new Map<number, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]!.trim());
  }

  for (const entry of entries) {
    if (entry.pid) entry.command = commands.get(entry.pid) ?? entry.command;
  }
}

async function detectPorts(): Promise<PortEntry[]> {
  return mergePortEntries(await detectRawPorts()).filter(
    (entry) => isDevRuntimeEntry(entry) && entry.disabledReason !== "requires elevated permissions",
  );
}

async function terminatePid(pid: number, force: boolean): Promise<boolean> {
  if (process.platform === "win32") {
    const command = force ? ["taskkill", "/F", "/PID", String(pid)] : ["taskkill", "/PID", String(pid)];
    return (await runCommand(command)).exitCode === 0;
  }

  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function remainingSelectedEntries(before: PortEntry[], after: PortEntry[]): PortEntry[] {
  const selected = new Set(before.map(entryKey));
  return after.filter((entry) => selected.has(entryKey(entry)));
}

function printDetectedPorts(entries: PortEntry[]): void {
  log.message(entries.map((entry) => formatPortOption(entry)).join("\n"), { symbol: "" });
}

async function runCli(): Promise<void> {
  intro("ports");

  const scan = spinner();
  scan.start("Scanning localhost ports");
  const ports = await detectPorts();
  scan.stop(`Found ${ports.length} open localhost dev port${ports.length === 1 ? "" : "s"}`);

  if (ports.length === 0) {
    outro("No open localhost dev ports found.");
    return;
  }

  const closable = ports.filter((entry) => entry.canClose);
  if (closable.length === 0) {
    printDetectedPorts(ports);
    outro("Open ports found, but none can be closed.");
    return;
  }

  const { displayLabels, ambiguous } = resolveLabelColumns(ports);
  const selected = await multiselect<PortEntry>({
    message: "Select ports to close",
    required: false,
    options: ports.map((entry, i) => ({
      value: entry,
      label: formatPortOption(entry, displayLabels[i]!),
      hint: portOptionHint(entry, ambiguous[i]!),
      disabled: !entry.canClose,
    })),
  });

  if (isCancel(selected)) {
    cancel("No ports closed.");
    return;
  }

  if (selected.length === 0) {
    outro("No ports selected. Nothing closed.");
    return;
  }

  const pids = uniquePids(selected);
  await Promise.all(pids.map((pid) => terminatePid(pid, false)));
  await sleep(800);

  let remaining = remainingSelectedEntries(selected, await detectPorts());
  if (remaining.length > 0) {
    const remainingPids = uniquePids(remaining);
    const force = await confirm({
      message: `${remaining.length} selected port${remaining.length === 1 ? " is" : "s are"} still listening. Force kill ${remainingPids.length} process${remainingPids.length === 1 ? "" : "es"}?`,
      initialValue: false,
    });

    if (!isCancel(force) && force) {
      await Promise.all(remainingPids.map((pid) => terminatePid(pid, true)));
      await sleep(500);
      remaining = remainingSelectedEntries(selected, await detectPorts());
    }
  }

  if (remaining.length === 0) {
    outro("Selected ports closed.");
    return;
  }

  log.warn(`Still listening:\n${remaining.map((entry) => formatPortOption(entry)).join("\n")}`);
  outro("Some selected ports could not be closed.");
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    await runCli();
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      cancel("No ports closed.");
      process.exit(0);
    }

    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
