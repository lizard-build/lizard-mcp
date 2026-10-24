// Checks test/parity/cli-coverage.json against an installed Lizard CLI:
// every command it has must be mapped, every mapped command must still exist,
// and every tool named must be one this server registers.
//
//   npx tsx scripts/audit-cli.ts [--cli path/to/lizard] [--latest]
//
// Exit 1 on any gap. --latest skips the version check (the scheduled CI job runs the
// newest CLI to catch new commands); without it the CLI must match cliVersion.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { listTools } from "./list-tools.js";

interface Cmd { name: string; subcommands?: Cmd[] }
const args = process.argv.slice(2);
const cli = args.includes("--cli") ? args[args.indexOf("--cli") + 1] : "lizard";
const latest = args.includes("--latest");

const map = JSON.parse(readFileSync(new URL("../test/parity/cli-coverage.json", import.meta.url), "utf8")) as {
  cliVersion: string;
  mcpOnly: Record<string, string>;
  commands: Record<string, { mcp: string[]; why?: string }>;
};
const schema = JSON.parse(execFileSync(cli, ["--help", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) as { version: string; command: Cmd };

const found: string[] = [];
const walk = (c: Cmd, prefix: string[]) => {
  for (const sub of c.subcommands ?? []) {
    const path = [...prefix, sub.name];
    found.push(path.join(" "));
    walk(sub, path);
  }
};
walk(schema.command, []);

const tools = new Set((await listTools()).map((t) => t.name));
const mapped = new Set(Object.keys(map.commands));
const unmapped = found.filter((c) => !mapped.has(c));
const removed = [...mapped].filter((c) => !found.includes(c));
const unknownTools = Object.entries(map.commands).flatMap(([c, r]) => r.mcp.filter((t) => !tools.has(t)).map((t) => `${c} -> ${t}`));
const noReason = Object.entries(map.commands).filter(([, r]) => !r.mcp.length && !r.why).map(([c]) => c);
const versionOff = !latest && schema.version !== map.cliVersion;

console.log(`Lizard CLI ${schema.version}: ${found.length} commands, ${found.length - unmapped.length} mapped, ${tools.size} MCP tools`);
for (const [label, list] of [["Not in the map (add them)", unmapped], ["In the map but gone from the CLI", removed], ["Mapped to a tool that does not exist", unknownTools], ["No tools and no reason", noReason]] as const) {
  if (list.length) console.log(`\n${label}:\n  ${list.join("\n  ")}`);
}
if (versionOff) console.log(`\nThe map is for CLI ${map.cliVersion}; this is ${schema.version}. Update cliVersion after checking the new commands.`);
process.exit(unmapped.length || removed.length || unknownTools.length || noReason.length || versionOff ? 1 : 0);
