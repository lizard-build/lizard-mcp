# Install Lizard MCP in Cline

Lizard (lizard.build) hosts Lizard MCP at:

```text
https://employ-woman-g1q2.us-east-1.onlizard.com/mcp
```

Use **Streamable HTTP**. Cline calls this transport `streamableHttp`.
Do not use `sse`, or `http` as the JSON `type`. No clone, build or local
server is needed for the hosted connection.

## Credentials

Ask the user for a Lizard API key, or have them set `LIZARD_API_KEY` in the
environment before starting Cline. They can create a key in the dashboard
under **Sandboxes → Get started → New API key**.

Read the key only inside the setup command. Never print it, include it in
chat, commit it, or put it in a sandbox. Do not read other clients' saved
credentials. The setup below uses a bearer header; it does not run OAuth.

## Cline settings

Use Cline's **Configure MCP Servers** action to find the active settings
file. For Cline CLI, the default is
`~/.cline/data/settings/cline_mcp_settings.json`. A custom profile may use a
different data directory; `CLINE_MCP_SETTINGS_PATH` overrides the file path.

Merge this entry into `mcpServers`, preserving all other entries:

```json
{
  "mcpServers": {
    "lizard": {
      "type": "streamableHttp",
      "url": "https://employ-woman-g1q2.us-east-1.onlizard.com/mcp",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_YOUR_LIZARD_API_KEY"
      },
      "disabled": false,
      "autoApprove": [],
      "timeout": 180
    }
  }
}
```

For a CLI session with `LIZARD_API_KEY` already set, this command saves the
entry without displaying the key. Set `CLINE_MCP_SETTINGS_PATH` first when
using a custom profile.

```sh
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const key = process.env.LIZARD_API_KEY;
if (!key) throw new Error('Set LIZARD_API_KEY before running setup.');
const path = process.env.CLINE_MCP_SETTINGS_PATH
  || join(homedir(), '.cline', 'data', 'settings', 'cline_mcp_settings.json');

let settings = {};
try {
  settings = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
  throw new Error('MCP settings must be a JSON object.');
}
if (settings.mcpServers !== undefined
    && (!settings.mcpServers || typeof settings.mcpServers !== 'object'
        || Array.isArray(settings.mcpServers))) {
  throw new Error('mcpServers must be a JSON object.');
}
settings.mcpServers = {
  ...settings.mcpServers,
  lizard: {
    type: 'streamableHttp',
    url: 'https://employ-woman-g1q2.us-east-1.onlizard.com/mcp',
    headers: { Authorization: `Bearer ${key}` },
    disabled: false,
    autoApprove: [],
    timeout: 180,
  },
};
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
chmodSync(path, 0o600);
console.log('Lizard MCP settings saved. Restart Cline to connect.');
NODE
```

Do not display the settings file after saving it: it now contains a key.
Restart Cline or reconnect the server so it loads the entry.

## Verify the connection

After reconnecting, use Cline's MCP tools to discover the server and call
`whoami` with no arguments. Report only whether it succeeded. This check
does not create a sandbox or incur sandbox compute usage.

Do not substitute a shell HTTP request for this client check. A `401`
means the credential needs attention. If the server does not connect,
check the settings path and the exact `streamableHttp` type first.

## Use Sandboxes

A Lizard account and project are required. See the current
[billing and trial terms](https://lizard.build/docs/platform/billing/).
Creating and running Sandboxes uses billed resources.

Once the user approves a sandbox task, follow the
[README sandbox workflow](README.md#sandbox-workflow): choose a project,
create a sandbox with a finite lifetime, run the approved code, read its
results and delete the sandbox when finished. Keep automatic approval off.
The server's `confirm` argument records the user's approval; it does not
show a confirmation dialog.
