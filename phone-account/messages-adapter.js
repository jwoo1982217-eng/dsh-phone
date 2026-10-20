import { offloadRequestImages } from "./vendor/image-offload.js";
import { LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter } from './vendor/adapter.js';
import { serialize } from './vendor/messages/serialize.js';
import { parseSse } from './vendor/messages/sse.js';
import { translate } from './vendor/messages/translate.js';
import { providerError } from './vendor/messages/transport.js';
export { resolveAdapterOptions } from './vendor/adapter.js';

// rc.8 stores tool results inside user blocks; current official Messages uses
// tool-role request messages. Project the request only, leaving durable history intact.
export function projectHistory(messages) {
  const history = [];
  for (const message of messages) {
    if (message.role !== 'user') { history.push({ ...message, source: message.source ?? { kind:'unknown' } }); continue; }
    let content = [];
    const flush = () => { if (content.length) history.push({ ...message, content }); content = []; };
    for (const block of message.content) {
      if (block.type !== 'tool-result') { content.push(block); continue; }
      flush(); history.push({ role:'tool', toolCallId:block.toolCallId, content:block.content, isError:block.isError });
    }
    flush();
  }
  return history;
}

export class AccountMessagesAdapter extends DeepSeekAdapter {
  async *request(options, signal, connection, token, userId, attachments, activity) {
    const history = projectHistory(offloadRequestImages(options.messages, connection.maxRequestImageBytes));
    const images = new Map();
    async function readImages(blocks) {
      for (const block of blocks) {
        if (block.type === 'image' && !images.has(block.attachment.attachmentId)) {
          if (!attachments) throw new LlmError('图片服务尚未就绪', 'UNSUPPORTED_CONTENT');
          const value = await attachments.readImage(block.attachment, signal);
          images.set(block.attachment.attachmentId, { mediaType:value.ref.mediaType, data:value.data });
        }
      }
    }
    for (const message of history) await readImages(message.content);
    const body = serialize(options, connection, history, images, () => undefined);
    const baseURL = new URL(connection.baseURL);
    if (baseURL.origin !== 'https://api.deepseek.com' || baseURL.username || baseURL.password || !['','/','/v1'].includes(baseURL.pathname) || baseURL.search || baseURL.hash) {
      throw new LlmError('账号请求必须发往 DeepSeek 官方服务', 'ACCOUNT_SIGN_IN_REQUIRED');
    }
    // The public Messages API lives under /anthropic, unlike Chat Completions.
    // Keep the account grant restricted to this fixed official destination.
    const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
      method:'POST', redirect:'error', signal, body:JSON.stringify(body),
      headers: {
        ...attributionHeaders(), 'x-dsh-auth-token':token, 'content-type':'application/json',
        accept:'text/event-stream', 'anthropic-version':'2023-06-01',
        'x-deepseek-harness-user-id':String(userId),
        ...(options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id':String(options.sessionId) }),
        ...(options.purpose === 'compaction' ? { 'x-deepseek-harness-compact':'1' } : {}),
      },
    });
    if (!response.ok) {
      let raw;
      try { raw = await response.json(); } catch {}
      const error = providerError(raw, response.status, response.headers);
      if (response.status === 401) {
        try { await this.config.onAuthError?.(token); } catch {}
        throw new LlmError(error.message, 'ACCOUNT_TOKEN_INVALID', { ...error.failure, cause:error });
      }
      throw error;
    }
    if (!response.body) throw new LlmError('DeepSeek 返回了空响应', 'EMPTY_RESPONSE');
    for await (const chunk of translate(parseSse(response.body, activity), options.model)) {
      if (chunk.type === 'usage') { const { totalTokens, ...usage } = chunk.usage; yield { ...chunk, usage }; }
      else yield chunk;
    }
  }
}
