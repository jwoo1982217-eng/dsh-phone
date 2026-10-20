import { createHash } from 'node:crypto';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { RESOURCE, accountError, responseEvents, upstreamError } from './chatgpt-protocol.js';

export const CHATGPT_PROVIDER = 'chatgpt-plan';
const wireName = name => /^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name : `tool_${createHash('sha256').update(name).digest('hex').slice(0, 32)}`;
const badResponse = () => accountError('MALFORMED_RESPONSE', 'OpenAI 返回的工具或流式内容格式不正确。', 502);

/** Project immutable DSH history into the stateless SIWC Responses contract. */
export async function serializeChatGptRequest(options, profile, model, attachments) {
  options.signal?.throwIfAborted();
  if (options.stop?.length) throw accountError('UNSUPPORTED_CONTENT', 'ChatGPT 会员接口不支持 stop 参数，请使用默认设置。');
  const toolNames = new Map();
  const functions = (options.tools ?? []).map(tool => {
    if (typeof tool.name !== 'string' || !tool.name || !tool.parameters || typeof tool.parameters !== 'object') throw accountError('UNSUPPORTED_CONTENT', 'DSH 工具定义不完整。');
    const name = wireName(tool.name);
    if (toolNames.has(name)) throw accountError('UNSUPPORTED_CONTENT', 'DSH 工具名称重复。');
    toolNames.set(name, tool.name);
    return { type: 'function', name, description: tool.description ?? '', parameters: structuredClone(tool.parameters), strict: false };
  });
  const content = async (blocks, assistant = false) => {
    const output = [];
    for (const block of blocks) {
      if (block.type === 'text') output.push(assistant ? { type: 'output_text', text: block.text, annotations: [] } : { type: 'input_text', text: block.text });
      else if (block.type === 'image') {
        if (assistant || !model.inputModalities.includes('image') || !attachments) throw accountError('UNSUPPORTED_CONTENT', '当前会员模型或图片服务不支持这张图片，请选择可看图的模型。');
        const image = await attachments.readImage(block.attachment, options.signal);
        output.push({ type: 'input_image', image_url: `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}` });
      } else if (block.type !== 'reasoning') throw accountError('UNSUPPORTED_CONTENT', '此消息内容尚未被会员接口适配。');
    }
    return output;
  };
  const input = [];
  for (const message of options.messages) {
    options.signal?.throwIfAborted();
    const replay = message.source?.replayState?.response;
    if (message.role === 'assistant' && replay?.kind === CHATGPT_PROVIDER && replay.version === 1
      && replay.connectionId === profile.id && replay.model === options.model && Array.isArray(replay.output) && replay.output.length) {
      input.push(...structuredClone(replay.output));
      continue;
    }
    if (message.role === 'tool') {
      const output = await content(message.content);
      if (message.isError) output.unshift({ type: 'input_text', text: '工具执行失败，以下为错误结果。' });
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: output.length ? output : '' });
      continue;
    }
    const role = message.role === 'system' ? 'developer' : message.role;
    if (!['developer', 'user', 'assistant'].includes(role)) throw accountError('UNSUPPORTED_CONTENT', '此消息角色尚未被会员接口适配。');
    let pending = [];
    const flush = async () => {
      if (!pending.length) return;
      const value = await content(pending, role === 'assistant'); pending = [];
      if (value.length) input.push({ type: 'message', role, content: value });
    };
    for (const block of message.content) {
      if (block.type === 'tool-call') {
        if (role !== 'assistant') throw accountError('UNSUPPORTED_CONTENT', '工具调用必须来自助手消息。');
        await flush();
        input.push({ type: 'function_call', namespace: 'dsh', call_id: block.id, name: wireName(block.name), arguments: block.arguments });
      } else if (block.type === 'tool-result') {
        await flush();
        const output = await content(block.content);
        if (block.isError) output.unshift({ type: 'input_text', text: '工具执行失败，以下为错误结果。' });
        input.push({ type: 'function_call_output', call_id: block.toolCallId, output: output.length ? output : '' });
      } else pending.push(block);
    }
    await flush();
  }
  const body = {
    model: options.model, input, store: false, stream: true, include: ['reasoning.encrypted_content'],
    ...(options.system ? { instructions: options.system } : {}),
    ...(functions.length ? { tools: [{ type: 'namespace', name: 'dsh', description: 'Tools executed by the local DSH application.', tools: functions }] } : {}),
  };
  if (options.reasoningEffort !== undefined) {
    if (!model.reasoning?.efforts.some(row => row.id === options.reasoningEffort)) {
      throw accountError('UNSUPPORTED_CONTENT', '官方目录未声明此思考强度，请使用模型默认强度。');
    }
    body.reasoning = { effort: options.reasoningEffort };
  }
  // Temperature, max output and conversation IDs are not supported by SIWC HTTP.
  return { body, toolNames };
}

/** Translate provider events into DSH blocks; only response.completed is success. */
export async function* translateChatGptResponse(events, { toolNames, profile, model, requestId }) {
  const blocks = new Map(), completedItems = new Map(); let next = 0;
  function* text(key, type, value, final = false) {
    let block = blocks.get(key);
    if (!block) {
      block = { index: next++, type, value: '', closed: false }; blocks.set(key, block);
      yield { type: 'block-start', index: block.index, blockType: type };
    }
    if (block.closed) {
      if (final && value === block.value) return;
      throw badResponse();
    }
    if (typeof value !== 'string') throw badResponse();
    const delta = final ? value.startsWith(block.value) ? value.slice(block.value.length) : null : value;
    if (delta === null) throw badResponse();
    if (delta) { block.value += delta; yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: delta }; }
    if (final) {
      block.closed = true;
      yield { type: 'block-end', index: block.index, block: { type, text: block.value } };
    }
  }
  function* tool(key, item, final = false) {
    let block = blocks.get(key);
    if (!block) {
      if (!item || typeof item.call_id !== 'string' || !item.call_id || !toolNames.has(item.name) || (item.namespace && item.namespace !== 'dsh')) throw badResponse();
      block = { index: next++, type: 'tool-call', id: item.call_id, name: toolNames.get(item.name), wire: item.name, value: '', closed: false };
      blocks.set(key, block); yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
    }
    if (item?.call_id !== block.id || item?.name !== block.wire || (item.namespace && item.namespace !== 'dsh')) throw badResponse();
    const value = item.arguments ?? '';
    if (block.closed) { if (final && value === block.value) return; throw badResponse(); }
    if (typeof value !== 'string' || !value.startsWith(block.value)) throw badResponse();
    const delta = value.slice(block.value.length); block.value = value;
    if (delta) yield { type: 'tool-call-delta', index: block.index, id: block.id, name: block.name, argumentsDelta: delta };
    if (final) {
      let argumentsObject;
      try { argumentsObject = JSON.parse(block.value); } catch { throw badResponse(); }
      if (!argumentsObject || typeof argumentsObject !== 'object' || Array.isArray(argumentsObject)) throw badResponse();
      block.closed = true;
      yield { type: 'block-end', index: block.index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.value } };
    }
  }
  function* completeItem(item, outputIndex) {
    if (item.type === 'message') {
      if (!Array.isArray(item.content)) throw badResponse();
      for (const [i, part] of item.content.entries()) {
        if (part.type === 'output_text') yield* text(`text:${outputIndex}:${i}`, 'text', part.text, true);
        else if (part.type === 'refusal') yield* text(`text:${outputIndex}:${i}`, 'text', part.refusal, true);
        else throw badResponse();
      }
    } else if (item.type === 'function_call') yield* tool(`tool:${outputIndex}`, item, true);
    else if (item.type === 'reasoning') {
      for (const [i, part] of (item.summary ?? []).entries()) yield* text(`reasoning:${outputIndex}:${i}`, 'reasoning', part.text, true);
    } else throw accountError('UNSUPPORTED_CONTENT', 'OpenAI 返回了此会员适配器尚未支持的输出。', 502);
  }
  for await (const event of events) {
    const type = event?.type;
    if (type === 'error' || type === 'response.failed') {
      throw upstreamError(event.error ?? event.response ?? event, 502, requestId);
    }
    if (type === 'response.incomplete') throw accountError('RESPONSE_INCOMPLETE', 'OpenAI 未完整生成回答，请重试。', 502);
    if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      yield* tool(`tool:${event.output_index}`, event.item);
    } else if (type === 'response.function_call_arguments.delta') {
      const block = blocks.get(`tool:${event.output_index}`);
      if (!block || block.closed || typeof event.delta !== 'string') throw badResponse();
      block.value += event.delta;
      yield { type: 'tool-call-delta', index: block.index, id: block.id, name: block.name, argumentsDelta: event.delta };
    } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      yield* text(`text:${event.output_index}:${event.content_index}`, 'text', event.delta);
    } else if (type === 'response.reasoning_summary_text.delta') {
      yield* text(`reasoning:${event.output_index}:${event.summary_index}`, 'reasoning', event.delta);
    } else if (type === 'response.output_item.done') {
      if (!Number.isSafeInteger(event.output_index) || event.output_index < 0 || !event.item) throw badResponse();
      yield* completeItem(event.item, event.output_index);
      completedItems.set(event.output_index, structuredClone(event.item));
    }
    else if (type === 'response.completed') {
      const response = event.response;
      if (response?.status !== 'completed' || !Array.isArray(response.output)) throw badResponse();
      for (const [i, item] of response.output.entries()) {
        yield* completeItem(item, i);
        completedItems.set(i, structuredClone(item));
      }
      // The plan stream can finish with output: [] after delivering complete
      // items individually. Keep those items for the next stateless tool step.
      const output = [...completedItems].sort(([a], [b]) => a - b).map(([, item]) => item);
      if ([...blocks.values()].some(block => !block.closed)) throw badResponse();
      if (![...blocks.values()].some(block => block.type === 'tool-call' || (block.type === 'text' && block.value))) {
        throw accountError('EMPTY_RESPONSE', 'OpenAI 未返回回答或工具调用，请重试。', 502);
      }
      const usage = response.usage;
      if (usage) {
        if ([usage.input_tokens, usage.output_tokens, usage.input_tokens_details?.cached_tokens ?? 0,
          usage.output_tokens_details?.reasoning_tokens ?? 0].some(value => !Number.isSafeInteger(value) || value < 0)
          || (usage.input_tokens_details?.cached_tokens ?? 0) > usage.input_tokens
          || (usage.output_tokens_details?.reasoning_tokens ?? 0) > usage.output_tokens) throw badResponse();
        const cached = Math.max(0, usage.input_tokens_details?.cached_tokens ?? 0);
        yield { type: 'usage', usage: { inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached), outputTokens: usage.output_tokens ?? 0,
          ...(cached ? { cacheReadTokens: cached } : {}), ...(usage.output_tokens_details?.reasoning_tokens ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens } : {}) } };
      }
      yield { type: 'finish', reason: { kind: output.some(item => item.type === 'function_call') ? 'tool-calls' : 'stop' },
        replayState: { response: { kind: CHATGPT_PROVIDER, version: 1, connectionId: profile.id, model, output } } };
      return;
    }
  }
  throw accountError('STREAM_CLOSED', 'OpenAI 连接在回答完成前中断，没有把半截回答当作成功。', 502);
}

export class ChatGptAdapter extends LlmAdapter {
  constructor(account, { attachments = () => undefined } = {}) { super(); this.account = account; this.attachments = attachments; }
  providerInfo(provider) { return { id: provider, name: 'ChatGPT 会员' }; }
  async listModels(provider = CHATGPT_PROVIDER) {
    try { return (await this.account.models()).map(model => ({ ...model, provider, name: `${model.name} · ChatGPT 会员` })); }
    catch (error) { if (['ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SCOPE_REQUIRED'].includes(error.code)) return []; throw error; }
  }
  async resolveModel(provider, model, signal) {
    const found = (await this.account.models(undefined, { signal })).find(row => row.id === model);
    if (!found) throw accountError('MODEL_NOT_AVAILABLE', '此模型未出现在当前会员账号的官方目录中，请刷新并重新选择。');
    return { ...found, provider, name: `${found.name} · ChatGPT 会员` };
  }
  async *stream(options) {
    const tried = new Set();
    let lastError;
    for (;;) {
      options.signal?.throwIfAborted();
      let selected;
      try { selected = await this.account.nextSession(options.model, { signal: options.signal, exclude: tried }); }
      catch (error) { throw lastError ?? error; }
      const { profile, model } = selected;
      tried.add(profile.id);
      let token, delivered = false;
      try {
        const { body, toolNames } = await serializeChatGptRequest(options, profile, model, this.attachments());
        token = await this.account.access(profile.id, options.signal);
        const response = await this.account.network.open(`${RESOURCE}/responses`, { data: body, token, signal: options.signal, timeoutMs: 3600000 });
        for await (const chunk of translateChatGptResponse(responseEvents(response.body, options.signal), { toolNames, profile, model: options.model, requestId: response.headers.get('x-request-id') })) {
          delivered = true; yield chunk;
        }
        return;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error?.code === 'ACCOUNT_TOKEN_INVALID' && token) await this.account.rejectAccess(profile.id, token).catch(() => {});
        if (['RATE_LIMITED', 'QUOTA_EXCEEDED'].includes(error?.code)) this.account.coolDown(profile.id, options.model);
        // 已开始交付的流不能重放；只在明确账号失败且尚未交付时换号。
        if (delivered || !['ACCOUNT_TOKEN_INVALID', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SCOPE_REQUIRED', 'RATE_LIMITED', 'QUOTA_EXCEEDED'].includes(error?.code)) throw error;
        lastError = error;
      }
    }
  }
}
