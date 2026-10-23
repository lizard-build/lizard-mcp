import { describe, expect, it } from "vitest";
import { normalizeRepoUrl } from "../../src/tools/services.js";
import { applyDnsChange, recordsToReplace, relativeName, type DnsRecord } from "../../src/tools/domains.js";
import { volumeRef } from "../../src/tools/sandboxes.js";
import { tail } from "../../src/tools/repos.js";
import { repoPath, segs } from "../../src/lib/lizard-git.js";

describe("normalizeRepoUrl", () => {
  it("maps the three repo forms lizard-cli accepts", () => {
    expect(normalizeRepoUrl("https://github.com/a/b")).toBe("https://github.com/a/b");
    expect(normalizeRepoUrl("a/b")).toBe("https://github.com/a/b");
    expect(normalizeRepoUrl("lizard:a/b")).toBe("https://lizard.build/git/a/b");
  });
  it("refuses anything else", () => {
    expect(() => normalizeRepoUrl("just-a-name")).toThrow("repoUrl must be");
  });
});

describe("bought-domain DNS", () => {
  const records: DnsRecord[] = [
    { name: "@", type: "URL", value: "http://www.example.com", ttl: 1800 },
    { name: "@", type: "A", value: "1.2.3.4", ttl: 1800 },
    { name: "www", type: "CNAME", value: "old.onlizard.com", ttl: 1800 },
    { name: "@", type: "TXT", value: "v=spf1", ttl: 1800 },
  ];
  it("names records relative to the domain", () => {
    expect(relativeName("example.com", "example.com")).toBe("@");
    expect(relativeName("API.example.com.", "example.com")).toBe("api");
    expect(relativeName("api", "example.com")).toBe("api");
  });
  it("only counts records that point elsewhere as replaced", () => {
    expect(recordsToReplace(records, ["@", "www"])).toEqual([{ name: "@", type: "A", value: "1.2.3.4", ttl: 1800 }]);
  });
  it("set replaces the name and type, add keeps them, remove needs a match", () => {
    expect(applyDnsChange(records, { action: "set", name: "@", type: "A", value: "5.6.7.8" }).records.filter((r) => r.type === "A")).toEqual([
      { name: "@", type: "A", value: "5.6.7.8", ttl: 1800 },
    ]);
    expect(applyDnsChange(records, { action: "add", name: "@", type: "TXT", value: "x" }).records).toHaveLength(5);
    expect(applyDnsChange(records, { action: "remove", name: "@", type: "TXT" }).removed).toHaveLength(1);
    expect(() => applyDnsChange(records, { action: "remove", name: "nope" })).toThrow("No record matches");
    expect(() => applyDnsChange(records, { action: "set", name: "@" })).toThrow("needs type and value");
  });
});

describe("volumeRef", () => {
  it("sends ids as volumeId and names as volumeName", () => {
    expect(volumeRef("fcv-123")).toEqual({ volumeId: "fcv-123" });
    expect(volumeRef("V1StGXR8_Z5jdHi6B-myT")).toEqual({ volumeId: "V1StGXR8_Z5jdHi6B-myT" });
    expect(volumeRef("data")).toEqual({ volumeName: "data" });
  });
});

describe("Lizard Git paths", () => {
  it("refuses . and .. so a value can't reach another API path", () => {
    expect(() => repoPath("../x")).toThrow();
    expect(() => repoPath("a/..")).toThrow();
    expect(() => segs("main/../../user/tokens")).toThrow();
    expect(repoPath("me/app.git")).toBe("/api/repos/me/app");
    expect(segs("feature/a b")).toBe("feature/a%20b");
  });
  it("keeps the end of a long log", () => {
    const out = tail("a".repeat(10) + "end", 5);
    expect(out).toEqual({ text: "a" + "end".padStart(4, "a"), truncated: true });
    expect(tail("short")).toEqual({ text: "short", truncated: false });
  });
});
