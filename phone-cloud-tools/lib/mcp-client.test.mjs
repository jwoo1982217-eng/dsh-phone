import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRelay } from './relay.mjs';
import { ToolTunnel } from './tunnel.mjs';
import { newPair } from './protocol.mjs';

test('official MCP client discovers real stdio tools and calls through encrypted relay', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phone-mcp-client-')); t.after(() => rm(root, { recursive: true, force: true }));
  const relay = createRelay(); await new Promise(r => relay.server.listen(0, '127.0.0.1', r)); t.after(() => relay.close());
  const pair = newPair(`ws://127.0.0.1:${relay.server.address().port}/relay`), file = path.join(root, 'pair.json'); await writeFile(file, JSON.stringify(pair), { mode: 0o600 });
  const phone = new ToolTunnel(pair, 'phone'); phone.handler = (name, args) => ({ called: name, echo: args }); phone.start(); t.after(() => phone.stop());
  const client = new Client({ name: 'dsh-official-client-verification', version: '1.0.0' }, { capabilities: {} }); t.after(() => client.close());
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url)), '--pair-file', file], stderr: 'pipe' });
  const online = once(phone, 'online'); await client.connect(transport); await online;
  const listed = await client.listTools(); assert.equal(listed.tools.length, 15); assert.equal(listed.tools.find(t => t.name === 'phone_local_run').annotations.readOnlyHint, false);
  const result = await client.callTool({ name: 'phone_status', arguments: {} }); assert.equal(result.isError, false); assert.equal(JSON.parse(result.content[0].text).called, 'phone_status');
  await client.close();
});
