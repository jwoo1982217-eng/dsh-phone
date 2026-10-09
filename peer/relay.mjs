import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { MAX_FRAME } from './protocol.mjs';

// The relay forwards opaque, authenticated ciphertext. It has no model keys,
// file access, or DSH execution API. Put it behind an HTTPS/WebSocket proxy.
export function createRelay({ maxRooms = 100, maxConnections = 250 } = {}) {
  const rooms = new Map();
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'text/plain' });
    res.end(req.url === '/health' ? 'DSH relay ready' : 'Not found');
  });
  const sockets = new WebSocketServer({ server, path: '/relay', maxPayload: MAX_FRAME, perMessageDeflate: false });
  sockets.on('connection', ws => {
    if (sockets.clients.size > maxConnections) { ws.close(1013, 'capacity'); return; }
    let room, role, joined = false, alive = true;
    const deadline = setTimeout(() => ws.close(1008, 'join required'), 5000); deadline.unref();
    ws.on('pong', () => { alive = true; });
    ws.on('error', () => {});
    ws.on('message', (bytes, binary) => {
      if (!joined) {
        try {
          if (binary || bytes.length > 2048) throw Error();
          const j = JSON.parse(bytes.toString());
          if (j.type !== 'join' || !/^[a-f0-9]{32}$/.test(j.room) || !/^[a-f0-9]{64}$/.test(j.proof) || !['phone', 'computer'].includes(j.role)) throw Error();
          room = rooms.get(j.room);
          if (!room) {
            if (rooms.size >= maxRooms) throw Error();
            room = { id: j.room, proof: j.proof, phone: null, computer: null }; rooms.set(j.room, room);
          }
          if (!timingSafeEqual(Buffer.from(room.proof, 'hex'), Buffer.from(j.proof, 'hex')) || room[j.role]) throw Error();
          role = j.role; room[role] = ws; joined = true; clearTimeout(deadline);
          ws.send(JSON.stringify({ type: 'joined' }));
          const other = room[role === 'phone' ? 'computer' : 'phone'];
          if (other?.readyState === WebSocket.OPEN) {
            other.send(JSON.stringify({ type: 'peer-online' })); ws.send(JSON.stringify({ type: 'peer-online' }));
          }
        } catch { ws.close(1008, 'join denied'); }
        return;
      }
      const other = room[role === 'phone' ? 'computer' : 'phone'];
      if (other?.readyState !== WebSocket.OPEN) return;
      if (other.bufferedAmount > MAX_FRAME * 4) { ws.close(1013, 'slow peer'); return; }
      other.send(bytes, { binary });
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      if (room?.[role] !== ws) return;
      room[role] = null;
      const other = room[role === 'phone' ? 'computer' : 'phone'];
      if (other?.readyState === WebSocket.OPEN) other.send(JSON.stringify({ type: 'peer-offline' }));
      if (!room.phone && !room.computer) rooms.delete(room.id);
    });
    ws.isAlive = () => alive; ws.setAlive = value => { alive = value; };
  });
  const heartbeat = setInterval(() => { for (const ws of sockets.clients) { if (!ws.isAlive?.()) ws.terminate(); else { ws.setAlive(false); ws.ping(); } } }, 20000); heartbeat.unref();
  return { server, rooms, async close() { clearInterval(heartbeat); for (const ws of sockets.clients) ws.terminate(); await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createRelay();
  const port = Number(process.env.DSH_RELAY_PORT ?? 8789), host = process.env.DSH_RELAY_HOST ?? '127.0.0.1';
  relay.server.listen(port, host, () => process.stdout.write(`DSH relay listening on ${host}:${port}; publish /relay through TLS\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void relay.close(); });
}
