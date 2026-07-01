import { expect, test } from "bun:test";
import {
  isLoopbackAddress,
  labelPort,
  mergePortEntries,
  parseLsofOutput,
  parsePowerShellJson,
  parseSsOutput,
} from "./index";

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

test("parses lsof listening ports and filters non-loopback bindings", () => {
  const output = `
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node     1234 kdang  23u  IPv4 123456      0t0  TCP 127.0.0.1:3000 (LISTEN)
node     1234 kdang  24u  IPv6 123457      0t0  TCP [::1]:3000 (LISTEN)
postgres 4321 kdang  10u  IPv4 123458      0t0  TCP localhost:5432 (LISTEN)
bun      9999 kdang  12u  IPv4 123459      0t0  TCP 0.0.0.0:5173 (LISTEN)
`;

  expect(parseLsofOutput(output)).toEqual([
    { address: "127.0.0.1", port: 3000, pid: 1234, processName: "node", owner: "kdang" },
    { address: "::1", port: 3000, pid: 1234, processName: "node", owner: "kdang" },
    { address: "localhost", port: 5432, pid: 4321, processName: "postgres", owner: "kdang" },
  ]);
});

test("parses ss listening ports with optional process ownership", () => {
  const output = `
LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("bun",pid=5678,fd=18))
LISTEN 0 4096 [::1]:6379 [::]:* users:(("redis-server",pid=6379,fd=7))
LISTEN 0 128 127.0.0.1:9229 0.0.0.0:*
LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=8080,fd=18))
`;

  expect(parseSsOutput(output)).toEqual([
    { address: "127.0.0.1", port: 5173, pid: 5678, processName: "bun" },
    { address: "::1", port: 6379, pid: 6379, processName: "redis-server" },
    { address: "127.0.0.1", port: 9229, pid: undefined, processName: undefined },
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
    { LocalAddress: "0.0.0.0", LocalPort: 8080, OwningProcess: 8080, ProcessName: "node" },
  ]);

  expect(parsePowerShellJson(array)).toEqual([
    { address: "::1", port: 5173, pid: 5678, processName: "bun", command: undefined },
  ]);
});

test("merges entries by pid and port", () => {
  const entries = mergePortEntries([
    { address: "127.0.0.1", port: 3000, pid: 1234, processName: "node", command: "node server.js" },
    { address: "::1", port: 3000, pid: 1234, processName: "node" },
    { address: "127.0.0.1", port: 3000, pid: 9999, processName: "bun" },
    { address: "127.0.0.1", port: 4321 },
  ]);

  expect(entries.map((entry) => ({ port: entry.port, pid: entry.pid, addresses: entry.addresses, label: entry.label }))).toEqual([
    { port: 3000, pid: 1234, addresses: ["127.0.0.1", "::1"], label: "Next.js / React" },
    { port: 3000, pid: 9999, addresses: ["127.0.0.1"], label: "Next.js / React" },
    { port: 4321, pid: undefined, addresses: ["127.0.0.1"], label: "Unknown local service" },
  ]);
});

test("labels common development ports", () => {
  expect(labelPort(5173)).toBe("Vite");
  expect(labelPort(5432)).toBe("PostgreSQL service");
  expect(labelPort(4321)).toBe("Unknown local service");
});
