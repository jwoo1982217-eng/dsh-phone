import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, writeFile, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

// Exercise the shipped adapter and UI functions without sending chats to a cloud service.
const root = fileURLToPath(new URL('../', import.meta.url));
const modules = process.env.DSH_POLICY_MODULES ?? path.join(root, 'runtime/node_modules');
const relative = '@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const source = await readFile(process.env.DSH_POLICY_SOURCE ?? path.join(root, 'runtime/overlays', relative), 'utf8');
const temporaryModule = path.join(modules, path.dirname(relative), `.policy-qa-${randomUUID()}.mjs`);
await writeFile(temporaryModule, source + '\nexport {resolveProfiles, mapStopReason};\n');
let sdk;
try { sdk = await import(pathToFileURL(temporaryModule)); }
finally { await rm(temporaryModule); }
const {createUserMessage} = await import(pathToFileURL(path.join(modules, '@deepseek-ai/dsh-llm/lib/index.js')));

const contentMessage = '请求包含越狱/解除限制类提示词，已拒绝。严禁用于越狱逆向工程！请移除相关指令后重试';
const restrictedMessage = '请求内容已多次触发上游风控，该客户端已被暂时限制调用';
const rawFailure = (code, message, nested = false) => {
  const detail = {message, type: 'gateway_error', code};
  return '403: ' + JSON.stringify(nested ? {error: detail} : detail);
};
const observed = [rawFailure('40304', contentMessage), rawFailure(40304, contentMessage, true)];
if (process.env.DSH_POLICY_OBSERVED_ERRORS) {
  const evidence = JSON.parse(await readFile(process.env.DSH_POLICY_OBSERVED_ERRORS, 'utf8'));
  for (const session of evidence.sessions) for (const event of session.lastEvents) {
    const error = event.data?.reason?.error;
    if (error?.code === 'AUTH' && error.message.includes('40304')) observed.push(error.message);
  }
  assert.ok(observed.length > 2, 'Expected an actual stored failure to replay');
}
const mapped = errorMessage => sdk.mapStopReason({stopReason: 'error', model: 'fixture-model', content: [], errorMessage}, 65536).failure;
for (const errorMessage of observed) {
  assert.deepEqual(mapped(errorMessage), {message: contentMessage, code: 'CONTENT_REJECTED', status: 403});
}
for (const errorMessage of [rawFailure('40303', restrictedMessage), rawFailure(40303, restrictedMessage, true)]) {
  assert.deepEqual(mapped(errorMessage), {message: restrictedMessage, code: 'UPSTREAM_RESTRICTED', status: 403});
}
const authBoundaries = [
  '401: {"message":"invalid API key","type":"gateway_error","code":"40101"}',
  '401: {"type":"gateway_error","code":"40304"}',
  '403: not json',
  '403: {"type":"other_vendor_error","code":"40304"}',
  '403: {"type":"gateway_error","code":"40305"}',
];
for (const raw of authBoundaries) assert.equal(mapped(raw).code, 'AUTH');
assert.equal(mapped('network failed after 40304 bytes').code, 'TRANSPORT');

function extractFunction(text, name) {
  const start = text.indexOf(`\t\tfunction ${name}(`);
  assert.notEqual(start, -1, name);
  const end = text.indexOf('\n\t\t}', start);
  assert.notEqual(end, -1, name);
  return text.slice(start, end + 4);
}
for (const name of ['dsh-client-ui-chat', 'dsh-client-ui-trajectory']) {
  const text = await readFile(path.join(process.env.DSH_POLICY_UI_MODULES ?? path.join(root, 'runtime/overlays'), '@deepseek-ai', name, 'lib/client.js'), 'utf8');
  const displayFailure = vm.runInNewContext(extractFunction(text, 'observedGatewayPolicyFailure') + '\n' + extractFunction(text, 'displayFailure') + '\ndisplayFailure');
  // Historic AUTH rows must render the real rejection without rewriting stored history.
  for (const raw of observed) {
    const visible = displayFailure({code: 'AUTH', message: raw});
    assert.equal(visible.code, 'CONTENT_REJECTED');
    assert.equal(visible.message, contentMessage);
    assert.equal(visible.status, 403);
  }
  for (const raw of authBoundaries) {
    const visible = displayFailure({code: 'AUTH', message: raw});
    assert.equal(visible.code, 'AUTH');
    assert.equal(visible.message, '');
  }
  assert.equal(displayFailure(mapped(observed[0])).message, contentMessage);
  assert.equal(displayFailure(null).message, 'null');
  if (name === 'dsh-client-ui-chat') {
    const failureMessage = vm.runInNewContext(extractFunction(text, 'failureMessage') + '\nfailureMessage');
    assert.equal(failureMessage(contentMessage, 'CONTENT_REJECTED', x => x), contentMessage);
    assert.equal(failureMessage('private upstream detail', 'AUTH', x => x), 'message.failure.auth');
  }
}

let mode = 'content', calls = 0;
const upstream = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  assert.equal(req.headers.authorization, 'Bearer local-fixture-key');
  assert.equal(body.model, 'fixture-model');
  calls++;
  if (mode !== 'ok') {
    const detail = mode === 'content' ? {message: contentMessage, type: 'gateway_error', code: '40304'}
      : mode === 'restricted' ? {message: restrictedMessage, type: 'gateway_error', code: '40303'}
      : {message: 'invalid API key', type: 'gateway_error', code: '40101'};
    res.writeHead(mode === 'auth' ? 401 : 403, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: detail}));
    return;
  }
  res.writeHead(200, {'content-type': 'text/event-stream'});
  const chunk = {id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{index: 0, delta: {role: 'assistant', content: '43'}, finish_reason: null}]};
  res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  res.write('data: ' + JSON.stringify({...chunk, choices: [{index: 0, delta: {}, finish_reason: 'stop'}]}) + '\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const profiles = sdk.resolveProfiles({fixture: {api: 'openai-completions', baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, apiKeyEnv: 'QA_KEY', models: [{id: 'fixture-model'}]}});
const adapter = new sdk.PiAiAdapter({profiles: () => profiles, resolveApiKey: async () => 'local-fixture-key'});
const options = {provider: 'fixture', model: 'fixture-model', messages: [createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'Compute 17 + 26.'}]})], maxTokens: 32};
try {
  for (const [next, code] of [['content', 'CONTENT_REJECTED'], ['restricted', 'UPSTREAM_RESTRICTED'], ['auth', 'AUTH']]) {
    mode = next;
    const before = calls, chunks = [];
    for await (const chunk of adapter.stream({...options, signal: AbortSignal.timeout(10000)})) chunks.push(chunk);
    const failure = chunks.at(-1).reason.failure;
    assert.equal(failure.code, code);
    if (code !== 'AUTH') assert.equal(failure.status, 403);
    assert.equal(calls - before, 1);
    assert.ok(!adapter.providerRetryPolicy('fixture').retryableCodes.includes(code));
  }
  mode = 'ok';
  const chunks = [];
  for await (const chunk of adapter.stream({...options, signal: AbortSignal.timeout(10000)})) chunks.push(chunk);
  assert.equal(chunks.filter(x => x.type === 'text-delta').map(x => x.text).join(''), '43');
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  console.log(JSON.stringify({observed40304Replay: true, historicChatAndTrajectory: true, trueAuthPreserved: true, unknownErrorsNotGuessed: true, loopbackHttpAdapter: true, noPolicyRetries: true, recoveryAfterFailure: true, cloudCalls: 0}));
} finally { await new Promise(resolve => upstream.close(resolve)); }
