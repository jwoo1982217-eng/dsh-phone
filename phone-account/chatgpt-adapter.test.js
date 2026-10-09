import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGptAdapter, CHATGPT_PROVIDER, serializeChatGptRequest, translateChatGptResponse } from './chatgpt-adapter.js';
import { RESOURCE, responseEvents, upstreamError } from './chatgpt-protocol.js';
import { connected, completed, textOutput, frames, collect } from './chatgpt-fixtures.js';
import { createOpenAiGateway } from '../vendor/dsh-codearts-auth/lib/openai-gateway/server.js';

const request = { provider: CHATGPT_PROVIDER, model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }], maxTokens: 32, temperature: 0.5 };
const profile = { id: 'fixture-connection' }, model = { id: 'fixture-model', inputModalities: ['text'] };
const translate = events => translateChatGptResponse(responseEvents(new Response(frames(events)).body), { toolNames: new Map([['inspect', 'inspect']]), profile, model: model.id });
const rejects = code => error => error.code === code;

test('upstream request uses OAuth public Responses with attribution and never forbidden SIWC fields', async t => {
  const { account, calls } = await connected(); t.after(() => account.dispose()); const adapter = new ChatGptAdapter(account);
  const chunks = await collect(adapter.stream({ ...request, system: '遵循用户授权', previousResponseId: 'never-send', metadata: { ignored: true } }));
  assert.equal(chunks.at(-1).reason.kind, 'stop'); assert.equal(chunks.find(c => c.type === 'text-delta').text, '你好');
  const call = calls.find(c => c.url === `${RESOURCE}/responses`), body = JSON.parse(call.init.body);
  assert.equal(call.init.headers.authorization, 'Bearer fixture-access'); assert.ok(call.init.headers['User-Agent'] || call.init.headers['user-agent']);
  assert.equal(call.init.redirect, 'error'); assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.instructions, '遵循用户授权');
  for (const field of ['temperature', 'top_p', 'max_output_tokens', 'max_tool_calls', 'metadata', 'previous_response_id', 'conversation', 'background', 'user', 'safety_identifier']) assert.equal(body[field], undefined);
  assert.ok(!call.init.body.includes('fixture-access'));
  await assert.rejects(collect(adapter.stream({ ...request, model: 'not-entitled' })), rejects('MODEL_NOT_AVAILABLE'));
});

test('DSH tool schema/history projects into namespace tools and preserves call correlation', async () => {
  const options = { ...request, tools: [{ name: '工具.读取', description: '读取', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], messages: [
    { role: 'system', content: [{ type: 'text', text: '系统指令' }] }, ...request.messages,
    { role: 'assistant', content: [{ type: 'text', text: '先读取' }, { type: 'tool-call', id: 'call-fixture', name: '工具.读取', arguments: '{"path":"example"}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-fixture', isError: true, content: [{ type: 'text', text: '不存在' }] }] },
  ] };
  const original = structuredClone(options), { body, toolNames } = await serializeChatGptRequest(options, profile, model);
  assert.deepEqual(options, original); assert.equal(body.input[0].role, 'developer'); assert.ok(!body.input.some(item => item.role === 'system'));
  assert.equal(body.tools[0].type, 'namespace'); assert.equal(body.tools[0].name, 'dsh');
  const fn = body.tools[0].tools[0]; assert.equal(fn.type, 'function'); assert.equal(toolNames.get(fn.name), '工具.读取'); assert.match(fn.name, /^[\w-]{1,64}$/);
  const invocation = body.input.find(item => item.type === 'function_call'); assert.equal(invocation.namespace, 'dsh'); assert.equal(invocation.name, fn.name); assert.equal(invocation.call_id, 'call-fixture');
  const result = body.input.at(-1); assert.equal(result.type, 'function_call_output'); assert.equal(result.call_id, invocation.call_id); assert.equal(result.output.at(-1).text, '不存在');
});

test('native V4 tool results preserve call correlation and source history', async () => {
  const options = { ...request, messages: [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-v4', name: 'inspect', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call-v4', isError: true, content: [{ type: 'text', text: '文件不存在' }] },
  ] };
  const before = structuredClone(options);
  const { body } = await serializeChatGptRequest(options, profile, model);
  assert.equal(body.input.at(-1).type, 'function_call_output');
  assert.equal(body.input.at(-1).call_id, 'call-v4');
  assert.equal(body.input.at(-1).output.at(-1).text, '文件不存在');
  assert.deepEqual(options, before);
});

test('upstream 401 rejects the captured account session and returns the original inference error', async t => {
  const { account } = await connected({ fetcher: async url => url === `${RESOURCE}/responses` ? new Response('{"error":{"code":"invalid_grant"}}', { status: 401 }) : undefined });
  t.after(() => account.dispose());
  await assert.rejects(collect(new ChatGptAdapter(account).stream(request)), rejects('ACCOUNT_TOKEN_INVALID'));
  assert.equal((await account.status()).signedIn, false);
});

test('reasoning and parallel tools stream into DSH with cached usage and stateless replay', async () => {
  const reasoning = { id: 'reason-fixture', type: 'reasoning', summary: [{ type: 'summary_text', text: '检查' }], encrypted_content: 'fixture-encrypted-reasoning' };
  const tool = { id: 'fc-fixture', type: 'function_call', namespace: 'dsh', call_id: 'call-fixture', name: 'inspect', arguments: '{"path":"a"}', status: 'completed' };
  const chunks = await collect(translate([
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '检查' },
    { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"a"}' },
    { type: 'response.output_item.done', output_index: 1, item: tool },
    completed([reasoning, tool], { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 6 } }),
  ]));
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.deepEqual(chunks.find(c => c.type === 'usage').usage, { inputTokens: 15, outputTokens: 10, cacheReadTokens: 5, reasoningTokens: 6 });
  const invocation = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block;
  assert.equal(invocation.id, 'call-fixture'); assert.equal(invocation.arguments, tool.arguments);
  const messages = [...request.messages, { role: 'assistant', source: { replayState: chunks.at(-1).replayState }, content: [invocation] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: invocation.id, content: [{ type: 'text', text: '读取完成' }] }] }];
  const options = { ...request, messages, tools: [{ name: 'inspect', parameters: { type: 'object' } }] };
  const { body } = await serializeChatGptRequest(options, profile, model);
  assert.equal(body.input[1].encrypted_content, reasoning.encrypted_content); assert.equal(body.input[2].call_id, invocation.id); assert.equal(body.input.at(-1).call_id, invocation.id);
  const switched = await serializeChatGptRequest(options, { id: 'another-connection' }, model);
  assert.ok(!JSON.stringify(switched.body).includes(reasoning.encrypted_content)); assert.equal(switched.body.input.find(item => item.type === 'function_call').call_id, invocation.id);
});

test('real streaming exposes text before response.completed, with no duplicate final content', async () => {
  let controller; const stream = new ReadableStream({ start(value) { controller = value; } });
  const iterator = translateChatGptResponse(responseEvents(stream), { toolNames: new Map(), profile, model: model.id })[Symbol.asyncIterator]();
  const encoder = new TextEncoder(); controller.enqueue(encoder.encode(frames([{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '你' }])));
  assert.equal((await iterator.next()).value.type, 'block-start'); assert.equal((await iterator.next()).value.text, '你');
  controller.enqueue(encoder.encode(frames([{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '好' }, completed()]))); controller.close();
  const rest = await collect(iterator); assert.equal(rest.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '好'); assert.equal(rest.at(-1).reason.kind, 'stop');
});

test('item-done output survives an empty completed envelope and a second tool step', async () => {
  const reasoning = { id: 'reason-fixture', type: 'reasoning', summary: [], encrypted_content: 'fixture-encrypted-reasoning' };
  const tool = { id: 'fc-fixture', type: 'function_call', namespace: 'dsh', call_id: 'call-fixture', name: 'inspect', arguments: '{}', status: 'completed' };
  const chunks = await collect(translate([
    { type: 'response.output_item.done', output_index: 1, item: tool },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    completed([]),
  ]));
  const finish = chunks.at(-1);
  assert.equal(finish.reason.kind, 'tool-calls');
  assert.deepEqual(finish.replayState.response.output, [reasoning, tool]);
  const invocation = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block;
  const { body } = await serializeChatGptRequest({ ...request, messages: [...request.messages,
    { role: 'assistant', content: [invocation], source: { replayState: finish.replayState } },
    { role: 'tool', toolCallId: invocation.id, content: [{ type: 'text', text: 'OK' }] },
  ] }, profile, model);
  assert.equal(body.input[1].encrypted_content, reasoning.encrypted_content);
  assert.equal(body.input[2].call_id, body.input[3].call_id);
  const text = await collect(translate([
    { type: 'response.output_item.done', output_index: 0, item: textOutput('OK') }, completed([]),
  ]));
  assert.equal(text.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'OK');
  assert.deepEqual(text.at(-1).replayState.response.output, [textOutput('OK')]);
  await assert.rejects(collect(translate([{ type: 'response.output_item.done', output_index: 0, item: tool }])), rejects('STREAM_CLOSED'));
});

test('old empty replay records rebuild visible text and tool calls without changing history', async () => {
  const messages = [...request.messages,
    { role: 'assistant', content: [{ type: 'text', text: '先读取' }, { type: 'tool-call', id: 'call-fixture', name: 'inspect', arguments: '{}' }],
      source: { replayState: { response: { kind: CHATGPT_PROVIDER, version: 1, connectionId: profile.id, model: model.id, output: [] } } } },
    { role: 'tool', toolCallId: 'call-fixture', content: [{ type: 'text', text: 'OK' }] },
  ];
  const before = structuredClone(messages);
  const { body } = await serializeChatGptRequest({ ...request, messages }, profile, model);
  assert.deepEqual(body.input.map(item => item.type), ['message', 'message', 'function_call', 'function_call_output']);
  assert.equal(body.input[1].content[0].text, '先读取');
  assert.equal(body.input[2].call_id, body.input[3].call_id);
  assert.deepEqual(messages, before);
});

test('late quota errors, incomplete/empty/malformed output and EOF never become successful replies', async () => {
  const delta = { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '半截' };
  await assert.rejects(collect(translate([delta, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'fixture-private-provider-text' } } }])), rejects('QUOTA_EXCEEDED'));
  await assert.rejects(collect(translate([delta])), rejects('STREAM_CLOSED'));
  await assert.rejects(collect(translate([{ type: 'response.incomplete' }])), rejects('RESPONSE_INCOMPLETE'));
  await assert.rejects(collect(translate([completed([])])), rejects('EMPTY_RESPONSE'));
  await assert.rejects(collect(translate([delta, completed([textOutput('不一致')])])), rejects('MALFORMED_RESPONSE'));
  await assert.rejects(collect(translate([completed(undefined, { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 11 } })])), rejects('MALFORMED_RESPONSE'));
  for (const tool of [{ type: 'function_call', call_id: 'call', name: 'unknown', arguments: '{}' }, { type: 'function_call', call_id: 'call', name: 'inspect', arguments: '{broken' }, { type: 'web_search_call' }]) {
    await assert.rejects(collect(translate([completed([tool])])), error => ['MALFORMED_RESPONSE', 'UNSUPPORTED_CONTENT'].includes(error.code));
  }
  const error = upstreamError({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'fixture-private-provider-text' } }, 400, 'request-fixture');
  assert.equal(error.failure.status, 429); assert.equal(error.failure.requestId, 'request-fixture'); assert.ok(!error.message.includes('fixture-private-provider-text'));
});

test('SSE tolerates split Unicode, CRLF, comments and multiline data while rejecting malformed JSON', async () => {
  const event = completed(), bytes = new TextEncoder().encode(': heartbeat\r\nevent: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":' + JSON.stringify(event.response) + '}\r\n\r\ndata: [DONE]\r\n\r\n');
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close(); } });
  assert.deepEqual(await collect(responseEvents(stream)), [event]);
  await assert.rejects(collect(responseEvents(new Response('data: not-json\n\n').body)), rejects('MALFORMED_RESPONSE'));
});

test('caller cancellation cancels a stalled upstream reader', async () => {
  let cancelled = false; const stream = new ReadableStream({ cancel() { cancelled = true; } }); const controller = new AbortController();
  const pending = collect(responseEvents(stream, controller.signal)); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(cancelled, true);
});

test('images and reasoning require declared capability; unsupported options fail explicitly', async () => {
  const attachment = { attachmentId: 'fixture-image', mediaType: 'image/png' }, options = { ...request, messages: [{ role: 'user', content: [{ type: 'image', attachment }] }] };
  const attachments = { readImage: async () => ({ ref: attachment, data: new Uint8Array([1, 2, 3]) }) };
  await assert.rejects(serializeChatGptRequest(options, profile, model, attachments), rejects('UNSUPPORTED_CONTENT'));
  const result = await serializeChatGptRequest(options, profile, { ...model, inputModalities: ['text', 'image'] }, attachments);
  assert.equal(result.body.input[0].content[0].image_url, 'data:image/png;base64,AQID'); assert.equal(attachment.attachmentId, 'fixture-image');
  await assert.rejects(serializeChatGptRequest({ ...request, reasoningEffort: 'high' }, profile, model), rejects('UNSUPPORTED_CONTENT'));
  await assert.rejects(serializeChatGptRequest({ ...request, stop: ['stop'] }, profile, model), rejects('UNSUPPORTED_CONTENT'));
});

test('actual DSH runtime and existing gateway expose account models, SSE, completion, tool calls and late errors', async t => {
  let output = [textOutput('网关完成')], fail = false;
  const { account } = await connected({ fetcher: async url => url === `${RESOURCE}/responses` ? new Response(frames(fail
    ? [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }] : [completed(output)])) : undefined });
  t.after(() => account.dispose());
  const ctx = new Context(); await ctx.plugin(LlmRuntime); const adapter = new ChatGptAdapter(account); const registration = ctx.llm.registerAdapter([CHATGPT_PROVIDER], adapter);
  t.after(async () => { registration(); await ctx.fiber.dispose(); });
  assert.equal((await ctx.llm.listModels(CHATGPT_PROVIDER))[0].provider, CHATGPT_PROVIDER);
  assert.equal((await ctx.llm.resolveModelInfo(CHATGPT_PROVIDER, 'fixture-model')).name, '测试模型 · ChatGPT 会员');
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const home = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-gateway-test-')); t.after(() => rm(home, { recursive: true, force: true }));
  const gateway = createOpenAiGateway({ llm: ctx.llm, home, env: { DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'fixture-gateway-key' }, logger: { info() {}, warn() {}, error() {} } });
  await gateway.start(); t.after(() => gateway.close()); const base = `http://127.0.0.1:${port}/v1`, headers = { authorization: 'Bearer fixture-gateway-key', 'content-type': 'application/json' };
  const catalog = await (await fetch(`${base}/models`, { headers })).json(); assert.equal(catalog.data[0].id, 'chatgpt-plan/fixture-model');
  const body = { model: catalog.data[0].id, messages: [{ role: 'user', content: '请回复' }] };
  const completion = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(completion.status, 200); assert.equal((await completion.json()).choices[0].message.content, '网关完成');
  const stream = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
  const sse = await stream.text(); assert.ok(sse.includes('网关完成')); assert.ok(sse.includes('[DONE]'));
  output = [{ id: 'fc-fixture', type: 'function_call', name: 'inspect', namespace: 'dsh', call_id: 'call-fixture', arguments: '{}' }];
  const toolBody = { ...body, tools: [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }] };
  const tools = await (await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(toolBody) })).json();
  assert.equal(tools.choices[0].finish_reason, 'tool_calls'); assert.equal(tools.choices[0].message.tool_calls[0].id, 'call-fixture');
  fail = true; const failed = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(failed.status, 429); assert.equal((await failed.json()).error.code, 'QUOTA_EXCEEDED');
});
