import { describe, it, expect } from "vitest";
import { z } from "zod";
import { serviceScaleShape, validateScaleTargets } from "../../src/tools/services.js";

const schema = z.object(serviceScaleShape);

describe("service.scale input schema", () => {
  it("accepts a valid combination", () => {
    expect(schema.safeParse({ project: "p", service: "s", replicas: 3, cpu: 2, memory: 512 }).success).toBe(true);
  });

  it("rejects replicas outside 1-10", () => {
    expect(schema.safeParse({ project: "p", service: "s", replicas: 0 }).success).toBe(false);
    expect(schema.safeParse({ project: "p", service: "s", replicas: 11 }).success).toBe(false);
  });

  it("rejects a cpu value outside the discrete tier list", () => {
    expect(schema.safeParse({ project: "p", service: "s", cpu: 5 }).success).toBe(false);
  });

  it("rejects a storage value outside the discrete tier list", () => {
    expect(schema.safeParse({ project: "p", service: "s", storage: 999 }).success).toBe(false);
  });

  it("rejects memory outside 128-8192", () => {
    expect(schema.safeParse({ project: "p", service: "s", memory: 64 }).success).toBe(false);
    expect(schema.safeParse({ project: "p", service: "s", memory: 9000 }).success).toBe(false);
  });
});

describe("validateScaleTargets", () => {
  it("throws when no target is given", () => {
    expect(() => validateScaleTargets("app", {})).toThrow(/at least one/);
  });

  it("rejects replicas for addons", () => {
    expect(() => validateScaleTargets("addon", { replicas: 2 })).toThrow(/single VM/);
  });

  it("rejects storage for apps", () => {
    expect(() => validateScaleTargets("app", { storage: 1024 })).toThrow(/only supported for addons/);
  });

  it("allows replicas for apps", () => {
    expect(() => validateScaleTargets("app", { replicas: 2 })).not.toThrow();
  });

  it("allows storage for addons", () => {
    expect(() => validateScaleTargets("addon", { storage: 1024 })).not.toThrow();
  });
});
