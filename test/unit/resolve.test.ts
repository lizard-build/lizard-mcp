import { describe, it, expect, vi } from "vitest";
import { resolveProject, resolveService } from "../../src/lib/resolve.js";
import type { ApiClient } from "../../src/lib/api.js";

function mockApi(getImpl: (path: string) => unknown): ApiClient {
  return {
    get: vi.fn(async (path: string) => getImpl(path)),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as ApiClient;
}

describe("resolveProject", () => {
  const projects = [
    { id: "p1", name: "my-app", slug: "my-app", workspaceId: "ws1" },
    { id: "p2", name: "Other", slug: "other", workspaceId: "ws1" },
    { id: "p3", name: "my-app", slug: "my-app-2", workspaceId: "ws2" }, // duplicate name, different workspace
  ];

  it("resolves by exact ID", async () => {
    const api = mockApi(() => projects);
    const result = await resolveProject(api, "p2");
    expect(result.name).toBe("Other");
  });

  it("resolves by case-insensitive name", async () => {
    const api = mockApi(() => projects);
    const result = await resolveProject(api, "OTHER");
    expect(result.id).toBe("p2");
  });

  it("resolves by case-insensitive slug", async () => {
    const api = mockApi(() => projects);
    const result = await resolveProject(api, "MY-APP-2");
    expect(result.id).toBe("p3");
  });

  it("throws with the available list when not found", async () => {
    const api = mockApi(() => projects);
    await expect(resolveProject(api, "nonexistent")).rejects.toThrow(/not found.*Other/s);
  });

  it("throws listing every candidate when a name matches more than one project", async () => {
    const api = mockApi(() => projects);
    await expect(resolveProject(api, "my-app")).rejects.toThrow(/matches 2 projects.*p1.*p3/s);
  });
});

describe("resolveService", () => {
  const services = {
    apps: [
      { id: "a1", name: "web", status: "running" },
      { id: "a2", name: "worker", status: "running" },
    ],
    addons: [
      { id: "d1", name: "db", addonType: "postgres", status: "running" },
      { id: "d2", name: "web", addonType: "redis", status: "running" }, // same name as app "web"
    ],
  };

  it("resolves an app by exact ID", async () => {
    const api = mockApi(() => services);
    const result = await resolveService(api, "proj1", "a1");
    expect(result).toEqual({ id: "a1", name: "web", kind: "app" });
  });

  it("resolves an addon by addonType", async () => {
    const api = mockApi(() => services);
    const result = await resolveService(api, "proj1", "postgres");
    expect(result).toEqual({ id: "d1", name: "db", kind: "addon" });
  });

  it("throws with available services when not found", async () => {
    const api = mockApi(() => services);
    await expect(resolveService(api, "proj1", "nonexistent")).rejects.toThrow(/not found.*Available/s);
  });

  it("throws listing every candidate when a name matches both an app and an addon", async () => {
    const api = mockApi(() => services);
    await expect(resolveService(api, "proj1", "web")).rejects.toThrow(/matches 2 services.*a1.*d2/s);
  });
});
