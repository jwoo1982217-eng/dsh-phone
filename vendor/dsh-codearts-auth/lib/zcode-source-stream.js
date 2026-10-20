import { LlmError } from '@deepseek-ai/dsh-llm';
import { serializeMessages, consumeOpenAiSse } from './openai-compat.js';
import { accountQuotaError } from './account-failover.js';
/** Keep business failures visible without returning credential-bearing bodies. */
export function organizationFailure(status, body) {
    let error;
    try {
        const value = JSON.parse(body);
        error = value.error ?? value;
    }
    catch { /* Never classify HTML as a billing response. */ }
    const business = String(error?.code ?? '');
    const detail = typeof error?.message === 'string' ? error.message : typeof error?.msg === 'string' ? error.msg : '';
    const concurrency = status === 429 && /concurren|并发|请求过于频繁|速率限制/i.test(detail);
    const quota = !concurrency && ![401, 403].includes(status) && (status === 402 || accountQuotaError(error));
    const code = quota ? 'QUOTA_EXCEEDED' : concurrency || status === 429 ? 'RATE_LIMIT' : status === 401 ? 'AUTH' : status === 403 ? 'PERMISSION' : status >= 500 ? 'SERVER' : 'INVALID_REQUEST';
    const reason = quota ? '余额不足或没有适用于当前模型的资源包；不会改扣本账号的其他 Plan' : business === '1305' ? '模型当前访问量过大，请稍后再试' : code === 'RATE_LIMIT' ? '请求被限流，请等待后重试' : code === 'AUTH' ? '机构凭据失效，请刷新来源或重新登录' : code === 'PERMISSION' ? '该机构项目没有此请求权限' : business === '1210' && /思考|thinking|reasoning/i.test(detail) ? '模型不支持当前思考档位，请按模型目录选择' : '上游拒绝了当前机构模型请求';
    return { code, message: `ZCode 机构流量：${reason}（HTTP ${status}${/^\d{3,6}$/.test(business) ? '，业务码 ' + business : ''}）` };
}
/** Ordinary API billing uses the selected organization's own key and scope. */
export async function* streamZcodeOrganization(options, credential, images, fetchImpl) {
    const source = credential.source_selection;
    const messages = serializeMessages(options.messages, images);
    const effort = options.reasoningEffort;
    const thinking = effort ? { thinking: { type: ['disabled', 'off', 'none'].includes(effort) ? 'disabled' : 'enabled' }, ...!['disabled', 'off', 'none'].includes(effort) ? { reasoning_effort: effort === 'enabled' ? 'high' : effort } : {} } : {};
    const body = { model: options.model.trim().toLowerCase(), stream: true, messages: [...(options.system ? [{ role: 'system', content: options.system }] : []), ...messages],
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}), ...(options.temperature !== undefined ? { temperature: options.temperature } : {}), ...thinking,
        ...(options.tools?.length ? { tools: options.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
        ...(options.stop?.length ? { stop: options.stop } : {}) };
    const response = await fetchImpl(source.url, { method: 'POST', body: JSON.stringify(body), headers: { Authorization: `Bearer ${source.key}`, 'Content-Type': 'application/json', 'bigmodel-organization': source.organizationId, 'bigmodel-project': source.projectId }, signal: options.signal, redirect: 'error' });
    if (!response.ok) {
        const failure = organizationFailure(response.status, (await response.text()).slice(0, 8192));
        throw new LlmError(failure.message, failure.code);
    }
    yield* consumeOpenAiSse(response, { signal: options.signal }, { label: 'zcode', firstTokenTimeoutMs: 120_000, chunkTimeoutMs: 120_000 });
}
//# sourceMappingURL=zcode-source-stream.js.map