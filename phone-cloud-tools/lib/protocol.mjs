import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export const MAX_FRAME = 1024 * 1024;
export const MAX_BODY = 16 * 1024 * 1024;
export function relayUrl(value) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || !['wss:', 'ws:'].includes(u.protocol)) throw Error('请输入 wss:// 中继地址');
  if (u.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('外网中继必须使用 wss:// 加密连接');
  return u.href;
}
export function validatePair(pair) {
  if (!pair || pair.version !== 1 || !/^[a-f0-9]{32}$/.test(pair.room) || !/^[a-f0-9]{64}$/.test(pair.secret)) throw Error('配对码格式无效');
  return { version: 1, relay: relayUrl(pair.relay), room: pair.room, secret: pair.secret };
}
export function newPair(relay) { return validatePair({ version: 1, relay, room: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('hex') }); }
export function pairCode(pair) { return 'dsh-tools:1:' + Buffer.from(JSON.stringify(validatePair(pair))).toString('base64url'); }
export function connectionLink(pair) { return 'dsh-phone://tools/connect#' + pairCode(pair); }
export function parsePair(code) {
  if (typeof code !== 'string' || code.length > 2048) throw Error('请粘贴手机生成的完整连接链接');
  let value = code.trim();
  if (value.startsWith('dsh-phone://')) {
    const url = new URL(value);
    if (url.host !== 'tools' || url.pathname !== '/connect' || url.username || url.password || url.search) throw Error('连接链接格式无效');
    value = url.hash.slice(1);
  }
  if (!value.startsWith('dsh-tools:1:')) throw Error('请粘贴手机生成的完整连接链接');
  const encoded = value.slice('dsh-tools:1:'.length);
  if (!/^[a-zA-Z0-9_-]+$/.test(encoded)) throw Error('连接链接格式无效');
  return validatePair(JSON.parse(Buffer.from(encoded, 'base64url').toString()));
}
export function relayProof(pair) { return createHash('sha256').update('dsh-tools-relay-v1\0' + pair.secret).digest('hex'); }
export function makeCipher(pair, role, session = '') {
  if (!['phone', 'computer'].includes(role)) throw Error('Invalid peer role');
  const other = role === 'phone' ? 'computer' : 'phone';
  const key = direction => Buffer.from(hkdfSync('sha256', Buffer.from(pair.secret, 'hex'), Buffer.from(pair.room, 'hex'), 'dsh-tools-v1/' + direction + '/' + session, 32));
  const writeKey = key(role), readKey = key(other), epoch = randomBytes(16).toString('hex');
  let sequence = 0;
  const seen = new Map();
  return {
    seal(message) {
      const seq = ++sequence, nonce = randomBytes(12), aad = `${pair.room}/${role}/${epoch}/${seq}`;
      const cipher = createCipheriv('aes-256-gcm', writeKey, nonce); cipher.setAAD(Buffer.from(aad));
      const body = Buffer.concat([cipher.update(JSON.stringify(message)), cipher.final()]);
      const frame = JSON.stringify({ v: 1, epoch, seq, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') });
      if (Buffer.byteLength(frame) > MAX_FRAME - 128) throw Error('Frame too large');
      return frame;
    },
    open(raw) {
      if (Buffer.byteLength(raw) > MAX_FRAME) throw Error('Frame too large');
      const p = JSON.parse(String(raw));
      if (p.v !== 1 || !/^[a-f0-9]{32}$/.test(p.epoch) || !Number.isSafeInteger(p.seq) || p.seq < 1 || p.seq <= (seen.get(p.epoch) ?? 0)) throw Error('Invalid or replayed packet');
      const nonce = Buffer.from(p.nonce, 'base64'), tag = Buffer.from(p.tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16) throw Error('Invalid cipher frame');
      const cipher = createDecipheriv('aes-256-gcm', readKey, nonce); cipher.setAAD(Buffer.from(`${pair.room}/${other}/${p.epoch}/${p.seq}`)); cipher.setAuthTag(tag);
      const message = JSON.parse(Buffer.concat([cipher.update(Buffer.from(p.body, 'base64')), cipher.final()]).toString());
      seen.set(p.epoch, p.seq);
      // Remember old epochs so reconnect cannot make captured packets valid again.
      if (seen.size > 256) throw Error('Reconnect limit reached; reconnect the paired device');
      return message;
    },
  };
}
