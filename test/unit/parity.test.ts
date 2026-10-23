import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { listTools } from "../../scripts/list-tools.js";
import { INSTRUCTIONS } from "../../src/server.js";

// Keeps every place that names the tools in step with the code, so a new tool can't
// ship missing from the docs, the ChatGPT manifest or the Lizard CLI map.

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
let tools: Awaited<ReturnType<typeof listTools>>;
let names: Set<string>;
beforeAll(async () => {
  tools = await listTools();
  names = new Set(tools.map((t) => t.name));
});

/** snake_case words in backticks (or bare in the instructions) that look like tool names. */
const PREFIX = /^(whoami|workspace|project|region|billing|service|addon|deploy|template|logs|metrics|secrets|domain|volume|git|repo|pr|ci|ssh|sandbox|config)(_[a-z]+)*$/;
function namedTools(text: string, bare = false): string[] {
  const words = bare ? text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [] : [...text.matchAll(/`([a-z_*]+)`/g)].map((m) => m[1]);
  return words.filter((w) => w.includes("_") && PREFIX.test(w.replace(/_\*$/, "")));
}

describe("docs name only real tools, and README names them all", () => {
  it("README's tool table lists every tool, once", () => {
    const table = read("README.md").split("## Tools")[1].split("\n\n")[1];
    const listed = [...table.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...names].sort());
  });
  it.each(["README.md", "skills/core/SKILL.md"])("%s names no tool that does not exist", (file) => {
    for (const word of namedTools(read(file))) {
      if (word.endsWith("_*")) expect([...names].some((n) => n.startsWith(word.slice(0, -1))), word).toBe(true);
      else expect(names.has(word) || /^[a-z]+_[a-z]+_$/.test(word), word).toBe(true);
    }
  });
  it("the server instructions name no tool that does not exist", () => {
    const words = namedTools(INSTRUCTIONS, true).filter((w) => !["git_push", "lizard_git"].includes(w));
    for (const word of words) expect(names.has(word), word).toBe(true);
  });
  it("no doc states a tool count, which goes stale", () => {
    for (const file of ["README.md", "skills/core/SKILL.md", ".codex-plugin/plugin.json"]) {
      expect(read(file), file).not.toMatch(/\b\d+ tools\b/);
    }
  });
});

describe("ChatGPT submission manifest", () => {
  it("has every tool, with the annotations the code declares", () => {
    const manifest = JSON.parse(read("chatgpt-app-submission.json")) as { tools: Record<string, { annotations: Record<string, boolean>; justifications: Record<string, string> }> };
    expect(Object.keys(manifest.tools).sort()).toEqual([...names].sort());
    for (const tool of tools) {
      const entry = manifest.tools[tool.name];
      for (const hint of ["readOnlyHint", "openWorldHint", "destructiveHint"] as const) {
        expect(entry.annotations[hint], `${tool.name}.${hint}`).toBe(tool.annotations?.[hint]);
      }
      expect(Object.values(entry.justifications).every((j) => j.length > 0), tool.name).toBe(true);
    }
  });
});

describe("Lizard CLI coverage map", () => {
  const map = JSON.parse(read("test/parity/cli-coverage.json")) as {
    mcpOnly: Record<string, string>;
    commands: Record<string, { mcp: string[]; why?: string }>;
  };
  it("maps commands only to tools that exist, and says why when there is none", () => {
    for (const [command, row] of Object.entries(map.commands)) {
      for (const tool of row.mcp) expect(names.has(tool), `${command} -> ${tool}`).toBe(true);
      if (!row.mcp.length) expect(row.why, command).toBeTruthy();
    }
  });
  it("accounts for every tool: a CLI command covers it, or mcpOnly says why not", () => {
    const covered = new Set(Object.values(map.commands).flatMap((row) => row.mcp));
    const orphans = [...names].filter((n) => !covered.has(n) && !map.mcpOnly[n]);
    expect(orphans).toEqual([]);
    for (const n of Object.keys(map.mcpOnly)) expect(names.has(n), n).toBe(true);
  });
});
