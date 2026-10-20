import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './journal.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-improvement-test-'));
  const store = path.join(root, 'store');
  const write = (name, value) => { const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const call = (command, ...args) => run(['--store', store, command, ...args]);
  const evidence = write('actual-task.json', { result: 'delivered', oldVersionPreserved: true, boundary: true });
  const episode = call('record', write('episode.json', { task: 'actual fixture task', outcome: 'completed', result: 'delivered', errors: ['reproduced error'], evidence: [evidence] }));
  const propose = action => call('propose', write('candidate.json', { episodeId: episode.id, key: 'fixture-method', trigger: 'same condition', action, exclusions: 'other condition', change: action }));
  const cases = (expected = 'delivered') => write('cases.json', { cases: [
    { name: 'task result', kind: 'normal', evidence, checks: [{ type: 'json-equals', pointer: '/result', expected }] },
    { name: 'boundary', kind: 'boundary', evidence, checks: [{ type: 'json-equals', pointer: '/boundary', expected: true }] },
    { name: 'failure recovery', kind: 'failure', evidence, checks: [{ type: 'json-equals', pointer: '/oldVersionPreserved', expected: true }] },
  ] });
  const approve = action => { const c = propose(action); assert.equal(call('validate', c.id, cases()).passed, true); call('promote', c.id); return c; };
  return { root, store, write, call, evidence, episode, propose, cases, approve, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function isolated(name, fn) { test(name, () => { const f = fixture(); try { fn(f); } finally { f.cleanup(); } }); }

isolated('successful validation persists across fresh reads and only approved methods are recalled', f => {
  const proposed = f.propose('first method'); assert.deepEqual(f.call('search'), []);
  f.call('validate', proposed.id, f.cases()); assert.deepEqual(f.call('search'), []);
  f.call('promote', proposed.id); assert.equal(f.call('search', 'first')[0].id, proposed.id);
  assert.equal(fs.statSync(path.join(f.store, 'state.json')).mode & 0o777, 0o600);
});
isolated('failed validation records error and preserves approved baseline', f => {
  const old = f.approve('good method'), c = f.propose('bad method');
  assert.equal(f.call('validate', c.id, f.cases('wrong')).passed, false);
  assert.throws(() => f.call('promote', c.id), /not passed/);
  assert.equal(f.call('show', c.id).status, 'rejected'); assert.equal(f.call('search')[0].id, old.id);
});
isolated('no evidence, missing case kind and simulated-only task evidence are rejected', f => {
  const c = f.propose('candidate');
  assert.equal(f.call('validate', c.id, f.write('empty.json', { cases: [] })).passed, false);
  const payload = JSON.parse(fs.readFileSync(f.cases())); payload.cases[2].kind = 'normal';
  assert.equal(f.call('validate', c.id, f.write('missing.json', payload)).passed, false);
  payload.cases[2].kind = 'failure'; const other = f.write('unrelated.json', { result: 'delivered', boundary: true, oldVersionPreserved: true });
  payload.cases.forEach(c => { c.evidence = other; });
  assert.equal(f.call('validate', c.id, f.write('simulated.json', payload)).passed, false);
});
isolated('evidence changed after validation cannot be promoted', f => {
  const c = f.propose('candidate'); f.call('validate', c.id, f.cases());
  fs.writeFileSync(f.evidence, JSON.stringify({ result: 'delivered', boundary: true, oldVersionPreserved: true, changed: true }));
  assert.throws(() => f.call('promote', c.id), /evidence changed/i); assert.deepEqual(f.call('search'), []);
});
isolated('concurrent baseline changes reject stale candidates without overwriting new method', f => {
  const a = f.propose('first'), b = f.propose('second'); f.call('validate', a.id, f.cases()); f.call('validate', b.id, f.cases());
  f.call('promote', a.id); assert.throws(() => f.call('promote', b.id), /Baseline changed/);
  assert.equal(f.call('search')[0].id, a.id);
});
isolated('rollback restores last approved version and repeated rollback clears initial version', f => {
  const first = f.approve('first'), second = f.approve('second');
  assert.equal(f.call('rollback', 'fixture-method', 'actual regression').restored, first.id);
  assert.equal(f.call('search')[0].id, first.id); assert.equal(f.call('show', second.id).status, 'rolled-back');
  f.call('rollback', 'fixture-method', 'remove initial method'); assert.deepEqual(f.call('search'), []);
});
isolated('lock conflict and failed mutation preserve state bytes', f => {
  const file = path.join(f.store, 'state.json'), before = fs.readFileSync(file);
  fs.mkdirSync(path.join(f.store, '.lock')); assert.throws(() => f.propose('busy'), /busy/);
  assert.deepEqual(fs.readFileSync(file), before); fs.rmdirSync(path.join(f.store, '.lock'));
  assert.throws(() => f.call('propose', f.write('bad.json', { episodeId: 'missing' })), /Episode not found/);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(path.join(f.store, '.lock')), false);
});
isolated('symlinked evidence cannot be read as a validation source', f => {
  const link = path.join(f.root, 'link.json'); fs.symlinkSync(f.evidence, link);
  assert.throws(() => f.call('record', f.write('linked-record.json', { task: 'linked', outcome: 'completed', result: 'done', errors: [], evidence: [link] })), /ELOOP/);
});
