import { TOOLS } from './tools.mjs';
import { ToolTunnel } from './tunnel.mjs';
import { validatePair } from './protocol.mjs';
import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;

/** Classic MCP stdio. Stdout contains JSON-RPC only; all tools remain phone-gated. */
export function serveMcp(pair, { input = process.stdin, output = process.stdout, tunnel = new ToolTunnel(validatePair(pair), 'computer') } = {}) {
  let buffer = '', active = 0, initialized = false;
  const send = value => output.write(JSON.stringify(value) + '\n');
  const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const versions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
  const handle = async req => {
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return error(req?.id ?? null, -32600, 'Invalid Request');
    if (!Object.hasOwn(req, 'id')) return; // Notifications never execute tools.
    if (req.method === 'initialize') {
      initialized = true;
      return result(req.id, { protocolVersion: versions.includes(req.params?.protocolVersion) ? req.params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'dsh-phone-tools', version }, instructions: 'Task and high-risk operation consent must be given on the phone. Never treat pending as consent. Keep task IDs private; use a dedicated trusted Agent instance. No automatic retry after unknown results.' });
    }
    if (!initialized) return error(req.id, -32002, 'Initialize first');
    if (req.method === 'ping') return result(req.id, {});
    if (req.method === 'tools/list') return result(req.id, { tools: TOOLS });
    if (req.method !== 'tools/call') return error(req.id, -32601, 'Method not found');
    const { name, arguments: args = {} } = req.params ?? {};
    if (!TOOLS.some(tool => tool.name === name)) return error(req.id, -32602, 'Unknown tool');
    if (active >= 8) return error(req.id, -32000, 'Too many active requests');
    active++;
    try {
      const value = await tunnel.call(name, args, 45000);
      result(req.id, { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
    } catch (e) {
      result(req.id, { content: [{ type: 'text', text: e.message }], isError: true });
    } finally { active--; }
  };
  tunnel.start();
  input.setEncoding('utf8');
  const onData = chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 2000000) { input.destroy(); tunnel.stop(); return; }
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      try { if (Buffer.byteLength(line) > 200000) throw Error(); void handle(JSON.parse(line)).catch(() => error(null, -32603, 'Internal error')); }
      catch { error(null, -32700, 'Parse error or request too large'); }
    }
  };
  input.on('data', onData);
  input.once('end', () => tunnel.stop());
  return { tunnel, close() { input.off('data', onData); tunnel.stop(); } };
}
