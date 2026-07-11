import { expect, test } from "bun:test";
import {
  describeCommand,
  disambiguate,
  formatPortOption,
  isDevRuntimeEntry,
  isLocalListenerAddress,
  isLoopbackAddress,
  labelEntry,
  mergePortEntries,
  parseLsofOutput,
  parsePowerShellJson,
  parseSsOutput,
  resolveLabelColumns,
  type PortEntry,
} from "./index";

function portEntry(overrides: Partial<PortEntry> & Pick<PortEntry, "port" | "label">): PortEntry {
  return {
    addresses: ["127.0.0.1"],
    canClose: true,
    ...overrides,
  };
}

test("detects loopback addresses only", () => {
  expect(isLoopbackAddress("localhost")).toBe(true);
  expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("127.1.2.3")).toBe(true);
  expect(isLoopbackAddress("[::1]")).toBe(true);
  expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("[::ffff:127.0.0.1]")).toBe(true);
  expect(isLoopbackAddress("0.0.0.0")).toBe(false);
  expect(isLoopbackAddress("192.168.1.10")).toBe(false);
});

test("accepts wildcard binds as local listeners", () => {
  expect(isLocalListenerAddress("0.0.0.0")).toBe(true);
  expect(isLocalListenerAddress("::")).toBe(true);
  expect(isLocalListenerAddress("[::]")).toBe(true);
  expect(isLocalListenerAddress("*")).toBe(true);
  expect(isLocalListenerAddress("127.0.0.1")).toBe(true);
  expect(isLocalListenerAddress("[::1]")).toBe(true);
  expect(isLocalListenerAddress("192.168.1.10")).toBe(false);
});

test("identifies dev runtime processes", () => {
  expect(isDevRuntimeEntry({ processName: "node" })).toBe(true);
  expect(isDevRuntimeEntry({ processName: "node.exe" })).toBe(true);
  expect(isDevRuntimeEntry({ processName: "bun" })).toBe(true);
  expect(isDevRuntimeEntry({ processName: "python3.12" })).toBe(true);
  expect(isDevRuntimeEntry({ command: '"C:\\Program Files\\nodejs\\node.exe" server.js' })).toBe(true);
  expect(isDevRuntimeEntry({ command: "/usr/bin/deno run --allow-net main.ts" })).toBe(true);
  expect(isDevRuntimeEntry({ processName: "postgres" })).toBe(false);
  expect(isDevRuntimeEntry({ processName: "redis-server" })).toBe(false);
  expect(isDevRuntimeEntry({ processName: "svchost" })).toBe(false);
  expect(isDevRuntimeEntry({ processName: "nodepad" })).toBe(false);
  expect(isDevRuntimeEntry({})).toBe(false);
});

test("parses lsof listening ports and filters non-local bindings", () => {
  const output = `
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node     1234 kdang  23u  IPv4 123456      0t0  TCP 127.0.0.1:3000 (LISTEN)
node     1234 kdang  24u  IPv6 123457      0t0  TCP [::1]:3000 (LISTEN)
postgres 4321 kdang  10u  IPv4 123458      0t0  TCP localhost:5432 (LISTEN)
bun      9999 kdang  12u  IPv4 123459      0t0  TCP 0.0.0.0:5173 (LISTEN)
nginx    7777 kdang  11u  IPv4 123460      0t0  TCP 192.168.1.10:8080 (LISTEN)
`;

  expect(parseLsofOutput(output)).toEqual([
    { address: "127.0.0.1", port: 3000, pid: 1234, processName: "node", owner: "kdang" },
    { address: "::1", port: 3000, pid: 1234, processName: "node", owner: "kdang" },
    { address: "localhost", port: 5432, pid: 4321, processName: "postgres", owner: "kdang" },
    { address: "0.0.0.0", port: 5173, pid: 9999, processName: "bun", owner: "kdang" },
  ]);
});

test("parses ss listening ports with optional process ownership", () => {
  const output = `
LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("bun",pid=5678,fd=18))
LISTEN 0 4096 [::1]:6379 [::]:* users:(("redis-server",pid=6379,fd=7))
LISTEN 0 128 127.0.0.1:9229 0.0.0.0:*
LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=8080,fd=18))
LISTEN 0 511 192.168.1.10:8081 0.0.0.0:* users:(("node",pid=8081,fd=18))
`;

  expect(parseSsOutput(output)).toEqual([
    { address: "127.0.0.1", port: 5173, pid: 5678, processName: "bun" },
    { address: "::1", port: 6379, pid: 6379, processName: "redis-server" },
    { address: "127.0.0.1", port: 9229, pid: undefined, processName: undefined },
    { address: "0.0.0.0", port: 8080, pid: 8080, processName: "node" },
  ]);
});

test("parses PowerShell JSON object and array output", () => {
  const single = JSON.stringify({
    LocalAddress: "127.0.0.1",
    LocalPort: 3000,
    OwningProcess: 1234,
    ProcessName: "node",
    CommandLine: "node server.js",
  });

  expect(parsePowerShellJson(single)).toEqual([
    {
      address: "127.0.0.1",
      port: 3000,
      pid: 1234,
      processName: "node",
      command: "node server.js",
    },
  ]);

  const array = JSON.stringify([
    { LocalAddress: "::1", LocalPort: 5173, OwningProcess: 5678, ProcessName: "bun" },
    { LocalAddress: "::", LocalPort: 3000, OwningProcess: 127588, ProcessName: "node" },
    { LocalAddress: "192.168.1.10", LocalPort: 8080, OwningProcess: 8080, ProcessName: "node" },
  ]);

  expect(parsePowerShellJson(array)).toEqual([
    { address: "::1", port: 5173, pid: 5678, processName: "bun", command: undefined },
    { address: "::", port: 3000, pid: 127588, processName: "node", command: undefined },
  ]);
});

test("merges entries by pid and port", () => {
  const entries = mergePortEntries([
    { address: "127.0.0.1", port: 3000, pid: 1234, processName: "node", command: "node server.js" },
    { address: "::1", port: 3000, pid: 1234, processName: "node" },
    { address: "127.0.0.1", port: 3000, pid: 9999, processName: "bun" },
    { address: "127.0.0.1", port: 4321 },
    { address: "127.0.0.1", port: 7265, pid: 109996, processName: "node" },
    { address: "::1", port: 7265, pid: 109996, command: "node C:\\dev\\api\\server.js" },
  ]);

  expect(entries.map((entry) => ({ port: entry.port, pid: entry.pid, addresses: entry.addresses, label: entry.label }))).toEqual([
    { port: 3000, pid: 1234, addresses: ["127.0.0.1", "::1"], label: "Next.js / React" },
    { port: 3000, pid: 9999, addresses: ["127.0.0.1"], label: "Next.js / React" },
    { port: 4321, pid: undefined, addresses: ["127.0.0.1"], label: "Unknown local service" },
    { port: 7265, pid: 109996, addresses: ["127.0.0.1", "::1"], label: "api/server.js" },
  ]);
});

test("labels common development ports", () => {
  expect(labelEntry({ port: 5173 })).toBe("Vite");
  expect(labelEntry({ port: 5432 })).toBe("PostgreSQL service");
  expect(labelEntry({ port: 4321 })).toBe("Unknown local service");
});

test("falls back to command-derived labels for unknown ports", () => {
  expect(labelEntry({ port: 7265, command: "node C:\\dev\\api\\server.js" })).toBe("api/server.js");
  expect(labelEntry({ port: 3000, command: "node server.js" })).toBe("Next.js / React");
  expect(labelEntry({ port: 7265 })).toBe("Unknown local service");
});

test("describes commands by their meaningful arguments", () => {
  expect(describeCommand('"C:\\Program Files\\nodejs\\node.exe" --inspect "C:\\dev\\api\\server.js"')).toBe("api/server.js");
  expect(describeCommand("node /home/kevin/dev/app/node_modules/next/dist/bin/next dev")).toBe("app/next dev");
  expect(describeCommand("node C:\\dev\\app\\node_modules\\.bin\\vite")).toBe("app/vite");
  expect(describeCommand("node C:\\dev\\app\\node_modules\\.pnpm\\next@14.2.3\\node_modules\\next\\dist\\bin\\next dev")).toBe("app/next dev");
  expect(describeCommand("node C:\\dev\\app\\node_modules\\@angular\\cli\\bin\\ng serve")).toBe("app/@angular/cli serve");
  expect(describeCommand("python3 -m http.server 8000")).toBe("http.server 8000");
  expect(describeCommand("bun run dev")).toBe("run dev");
  expect(describeCommand("node")).toBeUndefined();
  expect(describeCommand(undefined)).toBeUndefined();
});

test("keeps the project directory so two projects don't share a label", () => {
  expect(
    describeCommand(
      String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\kevin\Documents\dev\rental-property-management-app\node_modules\.pnpm\next@16.2.6_@babel+core@7.2_9dcdaabc04f205175ee1299c10c02003\node_modules\next\dist\server\lib\start-server.js`,
    ),
  ).toBe("rental-property-management-app/next");
  expect(describeCommand("node C:\\dev\\project-a\\server.js")).not.toBe(describeCommand("node C:\\dev\\project-b\\server.js"));
});

test("disambiguates three-way long-prefix label collisions", () => {
  const base = "rental-property-management-app";
  const entries = [
    portEntry({ port: 3000, pid: 1, label: `${base}/next`, processName: "node" }),
    portEntry({ port: 3001, pid: 2, label: `${base}/api`, processName: "node" }),
    portEntry({ port: 3002, pid: 3, label: `${base}/web`, processName: "node" }),
  ];

  const { displayLabels, ambiguous } = resolveLabelColumns(entries);

  expect(displayLabels).toHaveLength(3);
  expect(new Set(displayLabels).size).toBe(3);
  for (const column of displayLabels) {
    expect(column.length).toBeLessThanOrEqual(22);
  }
  expect(ambiguous).toEqual([true, true, true]);
  expect(displayLabels[0]).toContain("next");
  expect(displayLabels[1]).toContain("api");
  expect(displayLabels[2]).toContain("web");
});

test("duplicate full labels share a column without ambiguity", () => {
  const entries = [
    portEntry({ port: 5173, pid: 1, label: "Vite", processName: "node" }),
    portEntry({ port: 5174, pid: 2, label: "Vite", processName: "node" }),
  ];

  const { displayLabels, ambiguous } = resolveLabelColumns(entries);

  expect(displayLabels[0]).toBe("Vite");
  expect(displayLabels[1]).toBe(displayLabels[0]);
  expect(ambiguous).toEqual([false, false]);
});

test("non-colliding labels pass through plain truncation", () => {
  const entries = [
    portEntry({ port: 3000, pid: 1, label: "Next.js / React", processName: "node" }),
    portEntry({ port: 5173, pid: 2, label: "Vite", processName: "node" }),
    portEntry({ port: 8000, pid: 3, label: "Local web server", processName: "node" }),
  ];

  const { displayLabels, ambiguous } = resolveLabelColumns(entries);

  expect(displayLabels).toEqual(["Next.js / React", "Vite", "Local web server"]);
  expect(ambiguous).toEqual([false, false, false]);
});

test("ordinal fallback keeps pathological collisions pairwise distinct", () => {
  const sharedHead = "AAAAAAAAAAA";
  const sharedTail = "CCCCCCCCCC";
  const labels = [
    `${sharedHead}BBBBBBBBBBB${sharedTail}`,
    `${sharedHead}XXXXXXXXXXX${sharedTail}`,
    `${sharedHead}YYYYYYYYYYY${sharedTail}`,
  ];

  const columns = disambiguate(labels, 22);

  expect(columns).toHaveLength(3);
  expect(new Set(columns).size).toBe(3);
  for (const column of columns) {
    expect(column.length).toBeLessThanOrEqual(22);
  }
});

test("formatPortOption without label column matches prior output", () => {
  const entry = portEntry({
    port: 7265,
    pid: 109996,
    label: "api/server.js",
    processName: "node",
    command: "node C:\\dev\\api\\server.js",
  });

  expect(formatPortOption(entry)).toBe("7265  api/server.js          pid 109996         node");
});
