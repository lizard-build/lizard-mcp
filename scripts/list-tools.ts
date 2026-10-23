// Prints every tool this server registers, with its annotations, as JSON.
// Used by the docs and CLI parity checks: `npx tsx scripts/list-tools.ts`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getServer } from "../src/server.js";

export async function listTools() {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = getServer("");
  await server.connect(serverSide);
  const client = new Client({ name: "list-tools", version: "1" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  listTools().then((tools) => {
    console.log(JSON.stringify(tools.map((t) => ({ name: t.name, annotations: t.annotations })), null, 2));
  });
}
