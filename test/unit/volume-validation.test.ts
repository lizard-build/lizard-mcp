import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  buildVolumeListPath,
  buildVolumeResizeBody,
  buildVolumeResizePath,
  volumeResizeShape,
} from "../../src/tools/volumes.js";

describe("buildVolumeListPath", () => {
  it("builds the project volumes collection path", () => {
    expect(buildVolumeListPath("proj1")).toBe("/api/projects/proj1/volumes");
  });
});

describe("buildVolumeResizePath", () => {
  it("passes a plain id or name through", () => {
    expect(buildVolumeResizePath("proj1", "data")).toBe("/api/projects/proj1/volumes/data");
  });

  it("URL-encodes the volume segment", () => {
    expect(buildVolumeResizePath("proj1", "my vol/1")).toBe("/api/projects/proj1/volumes/my%20vol%2F1");
  });
});

describe("buildVolumeResizeBody", () => {
  it("sends only sizeGb", () => {
    expect(buildVolumeResizeBody(20)).toEqual({ sizeGb: 20 });
  });
});

describe("volume_resize input schema", () => {
  const schema = z.object(volumeResizeShape);

  it("accepts a valid resize", () => {
    expect(schema.safeParse({ project: "p", volume: "v", sizeGb: 10 }).success).toBe(true);
  });

  it("accepts the minimum size of 1", () => {
    expect(schema.safeParse({ project: "p", volume: "v", sizeGb: 1 }).success).toBe(true);
  });

  it("does not impose a client-side maximum", () => {
    expect(schema.safeParse({ project: "p", volume: "v", sizeGb: 100000 }).success).toBe(true);
  });

  it("rejects zero and negative sizes", () => {
    expect(schema.safeParse({ project: "p", volume: "v", sizeGb: 0 }).success).toBe(false);
    expect(schema.safeParse({ project: "p", volume: "v", sizeGb: -5 }).success).toBe(false);
  });

  it("rejects fractional sizes", () => {
    expect(schema.safeParse({ project: "p", volume: "v", sizeGb: 1.5 }).success).toBe(false);
  });

  it("rejects a string size", () => {
    expect(schema.safeParse({ project: "p", volume: "v", sizeGb: "10" }).success).toBe(false);
  });

  it("rejects an empty volume or project", () => {
    expect(schema.safeParse({ project: "p", volume: "", sizeGb: 10 }).success).toBe(false);
    expect(schema.safeParse({ project: "", volume: "v", sizeGb: 10 }).success).toBe(false);
  });
});
