const MASK = "***";

/** Keep field names, but no values from a credential or environment map. */
function maskValues(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(maskValues);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskValues(item)]));
  }
  return MASK;
}

/** Service and sandbox responses include credentials that a status query does not need. */
export function redactServiceDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactServiceDetails);
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      try {
        const url = new URL(value);
        if (url.username || url.password) {
          url.username = MASK;
          url.password = MASK;
          return url.toString();
        }
      } catch { /* Not a URL. */ }
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const name = key.replace(/[_-]/g, "").toLowerCase();
    if (name === "envvars" && typeof item === "string") {
      try { return [key, JSON.stringify(maskValues(JSON.parse(item)))]; }
      catch { return [key, MASK]; }
    }
    if (["envvars", "connection", "credentials", "secrets"].includes(name)) {
      return [key, maskValues(item)];
    }
    if (/password|secret|token|privatekey|accesskey/.test(name) || name === "logsnippet") {
      return [key, item == null ? item : MASK];
    }
    return [key, redactServiceDetails(item)];
  }));
}
