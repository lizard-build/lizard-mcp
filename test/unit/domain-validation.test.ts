import { describe, it, expect } from "vitest";
import { buildDomainAttachBody, buildDomainDeletePath } from "../../src/tools/domains.js";

describe("buildDomainAttachBody", () => {
  it("requests generation when no hostname is given", () => {
    expect(buildDomainAttachBody()).toEqual({ generate: true });
  });

  it("attaches a custom hostname when given", () => {
    expect(buildDomainAttachBody("app.example.com", 8080, true)).toEqual({
      hostname: "app.example.com",
      port: 8080,
      force: true,
    });
  });

  it("attaches a custom hostname with no port/force", () => {
    expect(buildDomainAttachBody("app.example.com")).toEqual({
      hostname: "app.example.com",
      port: undefined,
      force: undefined,
    });
  });
});

describe("buildDomainDeletePath", () => {
  it("URL-encodes the hostname segment", () => {
    expect(buildDomainDeletePath("app1", "sub.example.com")).toBe("/api/apps/app1/domains/sub.example.com");
  });

  it("encodes characters that would otherwise break the path", () => {
    // Not a realistic hostname, but proves special characters are escaped
    // rather than passed through raw into the URL path.
    expect(buildDomainDeletePath("app1", "a b/c")).toBe("/api/apps/app1/domains/a%20b%2Fc");
  });
});
