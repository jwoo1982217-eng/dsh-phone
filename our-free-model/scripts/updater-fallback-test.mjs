import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { advertisedRevision, downloadManifest, signManifest, parseManifest } from '../src/updater.js';
const sha = 'a'.repeat(40), other = 'b'.repeat(40);
const pkt = value => (Buffer.byteLength(value) + 4).toString(16).padStart(4, '0') + value;
const refs = rows => pkt('# service=git-upload-pack\n') + '0000' + rows.map(([sha, ref]) => pkt(sha + ' ' + ref + '\n')).join('') + '0000';
const advertisement = refs([[other, 'refs/heads/main-other'], [sha, 'refs/heads/main']]);
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const verifyKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const manifest = { version: '2.1.0', base: '../', files: [{ path: 'package.json', size: 10, sha256: 'a'.repeat(64) }] };
manifest.signature = signManifest(parseManifest(manifest), privateKey);
const raw = 'https://raw.githubusercontent.com/Ebony-Vinyl/dsh-our-free-model/main/feed/manifest.json';
const cdn = 'https://cdn.jsdelivr.net/gh/Ebony-Vinyl/dsh-our-free-model@main/feed/manifest.json';
for (const status of [403, 429]) test('REST ' + status + ' uses exact Git ref and pinned signed CDN snapshot', async () => {
  const calls = [];
  const result = await downloadManifest([raw, cdn], { verifyKey, fetchImpl: async url => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) return new Response('{}', { status });
    if (url.includes('info/refs?service=git-upload-pack')) return new Response(advertisement);
    if (url.startsWith('https://cdn.jsdelivr.net/gh/') && url.includes('@' + sha + '/feed/manifest.json')) return Response.json(manifest);
    return new Response('', { status: 404 });
  } });
  assert.equal(result.signed, true); assert.ok(result.source.includes('@' + sha + '/'));
  assert.equal(calls.filter(url => url.includes('api.github.com')).length, 1);
  assert.equal(calls.filter(url => url.includes('info/refs')).length, 1);
  assert.ok(calls.every(url => !url.includes('/main/feed/') && !url.includes('@main/feed/')));
});
test('exact branches, peeled annotated tags, missing refs and malformed packets', () => {
  assert.equal(advertisedRevision(Buffer.from(advertisement), 'main'), sha);
  assert.equal(advertisedRevision(Buffer.from(refs([[other, 'refs/tags/v2.1.0'], [sha, 'refs/tags/v2.1.0^{}']])), 'v2.1.0'), sha);
  assert.throws(() => advertisedRevision(Buffer.from(advertisement), 'master'), /does not contain/);
  assert.throws(() => advertisedRevision(Buffer.from(advertisement.slice(0, -3)), 'main'), /invalid|truncated/);
  assert.throws(() => advertisedRevision(Buffer.from(refs([[sha, 'refs/heads/main'], [other, 'refs/heads/main']])), 'main'), /conflicting/);
});
test('Git fallback cannot authorize a forged release; valid next check recovers', async () => {
  let forged = true;
  const fetchImpl = async url => {
    if (url.startsWith('https://api.github.com/')) return new Response('{}', { status: 403 });
    if (url.includes('info/refs')) return new Response(advertisement);
    return Response.json(forged ? { ...manifest, version: '9.9.9' } : manifest);
  };
  await assert.rejects(downloadManifest([raw], { verifyKey, fetchImpl }), /signature/);
  forged = false; assert.equal((await downloadManifest([raw], { verifyKey, fetchImpl })).signed, true);
});
