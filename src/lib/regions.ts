/**
 * Where a new service, addon or volume goes when the caller names no region, like
 * sandbox_create and the CLI. Left to the platform, it used to be the region of whichever
 * server answered, and DNS sends European callers to the EU one.
 */
export const DEFAULT_REGION = "us-east-1";
