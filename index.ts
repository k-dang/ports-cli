#!/usr/bin/env bun

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

export function labelPort(port: number): string {
  return COMMON_PORT_LABELS.get(port) ?? "Unknown local service";
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
    if (!endpoint || !isLoopbackAddress(endpoint.address)) continue;

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
    if (!endpoint || !isLoopbackAddress(endpoint.address)) continue;

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
    if (!Number.isInteger(port) || !isLoopbackAddress(address)) continue;

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
  const merged = new Map<string, Omit<PortEntry, "canClose" | "disabledReason">>();

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
      label: labelPort(entry.port),
    });
  }

  return Array.from(merged.values())
    .map((entry) => ({ ...entry, ...closeability(entry) }))
    .sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

export function formatPortOption(entry: PortEntry): string {
  const pid = entry.pid ? `pid ${entry.pid}` : "owner unavailable";
  const processName = entry.processName ?? commandName(entry.command) ?? "unknown";
  return `${String(entry.port).padEnd(5)} ${entry.label.padEnd(22)} ${pid.padEnd(18)} ${processName}`.trimEnd();
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
  const first = command.trim().split(/\s+/)[0];
  if (!first) return undefined;
  return first.split(/[\\/]/).at(-1);
}

async function runCommand(command: string[]): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
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
    (entry) => entry.disabledReason !== "requires elevated permissions",
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
  log.message(entries.map(formatPortOption).join("\n"), { symbol: "" });
}

async function runCli(): Promise<void> {
  intro("ports");

  const scan = spinner();
  scan.start("Scanning localhost ports");
  const ports = await detectPorts();
  scan.stop(`Found ${ports.length} open localhost port${ports.length === 1 ? "" : "s"}`);

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

  const selected = await multiselect<PortEntry>({
    message: "Select ports to close",
    required: false,
    options: ports.map((entry) => ({
      value: entry,
      label: formatPortOption(entry),
      hint: entry.disabledReason,
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
  await Bun.sleep(800);

  let remaining = remainingSelectedEntries(selected, await detectPorts());
  if (remaining.length > 0) {
    const remainingPids = uniquePids(remaining);
    const force = await confirm({
      message: `${remaining.length} selected port${remaining.length === 1 ? " is" : "s are"} still listening. Force kill ${remainingPids.length} process${remainingPids.length === 1 ? "" : "es"}?`,
      initialValue: false,
    });

    if (!isCancel(force) && force) {
      await Promise.all(remainingPids.map((pid) => terminatePid(pid, true)));
      await Bun.sleep(500);
      remaining = remainingSelectedEntries(selected, await detectPorts());
    }
  }

  if (remaining.length === 0) {
    outro("Selected ports closed.");
    return;
  }

  log.warn(`Still listening:\n${remaining.map(formatPortOption).join("\n")}`);
  outro("Some selected ports could not be closed.");
}

if (import.meta.main) {
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
