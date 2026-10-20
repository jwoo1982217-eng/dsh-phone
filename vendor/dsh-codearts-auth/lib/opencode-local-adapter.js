import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, LlmError, ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { OpencodeHarnessMcp } from './opencode-local-mcp.js';
import { nativeShellForTools, captureNativeTool } from './opencode-local-handoff.js';
import { collectImages, serializeMessages, httpErrorCode } from './openai-compat.js';
import { normalizeHarnessMessages } from './message-shape.js';
// 原生工具始终 ask，权限请求只用作意图捕获，绝不批准原生执行。
// 目录访问也先挂起，交由 DSH 按实际文件/命令参数执行权限检查。
const toolPermission = { '*': 'deny', bash: 'ask', read: 'ask', external_directory: 'ask', 'dsh_*': 'allow' };
const permission = Object.entries(toolPermission).map(([permission, action]) => ({ permission, pattern: '*', action }));
function waitForPoll(signal) {
    return new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 750);
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted)
            finish();
    });
}
export function nativeOpencodeFailure(error) {
    const status = Number(error?.data?.statusCode ?? error?.status);
    const message = String(error?.data?.message ?? error?.message ?? 'OpenCode 未返回有效响应');
    const validStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
    let upstreamType = '';
    try {
        upstreamType = JSON.parse(error?.data?.responseBody ?? '{}')?.error?.type ?? '';
    }
    catch { }
    const code = upstreamType === 'FreeTierError' ? 'OPENCODE_CLIENT_REQUIRED'
        : validStatus === 403 ? 'FORBIDDEN'
            : error?.name === 'ContextOverflowError' ? 'CONTEXT_WINDOW_EXCEEDED'
                : error?.name === 'MessageAbortedError' ? 'CANCELLED'
                    : validStatus === undefined ? 'SERVER' : httpErrorCode(validStatus);
    return new LlmError(`OpenCode：${message.slice(0, 1600)}`, code, validStatus === undefined ? {} : { status: validStatus });
}
/** 本地 API 管会话，DSH 管工具执行；不会把 native 工具的已执行结果再执行一次。 */
export class OpencodeLocalAdapter extends LlmAdapter {
    service;
    options;
    constructor(service, options = {}) {
        super();
        this.service = service;
        this.options = options;
    }
    providerInfo(provider) { return { id: provider, name: 'OpenCode 免费模型（本地服务）' }; }
    listAllModels() { return this.service.cachedModels().map(model => ({ id: model.id, name: model.name, isFree: true })); }
    async listModels(provider) {
        this.service.warm();
        const disabled = this.options.disabledModels?.() ?? new Set();
        return this.service.cachedModels().filter(model => !disabled.has(model.id)).map(model => ({ provider, id: model.id, name: model.name, inputModalities: model.inputModalities }));
    }
    async resolveModel(provider, id) {
        const model = (await this.service.catalog()).find(model => model.id === id);
        if (!model)
            throw new LlmError(`OpenCode 本地目录没有模型 ${id}，请在 JetHub 刷新模型列表`, 'MODEL_NOT_FOUND');
        return { provider, id, name: model.name, inputModalities: model.inputModalities,
            ...(model.contextWindow ? { context: { contextWindow: model.contextWindow } } : {}),
            ...(model.variants.length ? { reasoning: { efforts: model.variants.map(id => ({ id: ReasoningEffortId(id), name: id })) } } : {}),
        };
    }
    handleRpc(method, payload) { return this.service.handleRpc(method, payload); }
    async parts(options, model) {
        const normalized = normalizeHarnessMessages(options.messages.map(message => ({ ...message })));
        const refs = new Map();
        for (const message of normalized)
            if (Array.isArray(message.content))
                collectImages(message.content, refs);
        const urls = new Map(), images = [];
        for (const [id, ref] of refs) {
            if (!model.inputModalities.includes('image'))
                throw new LlmError('所选 OpenCode 模型不接受图片，请换用目录中支持图片的模型', 'UNSUPPORTED_CONTENT');
            const image = await this.options.readImage?.(ref);
            if (!image || image.data.length === 0 || !/^image\//.test(image.mediaType))
                throw new LlmError('无法读取图片原始字节，请重新上传', 'UNSUPPORTED_CONTENT');
            const filename = `dsh-image-${images.length + 1}`;
            urls.set(id, filename);
            images.push({ type: 'file', mime: image.mediaType, filename, url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` });
        }
        const messages = serializeMessages(options.messages, refs.size ? urls : undefined);
        const system = [options.system, ...messages.filter(message => message.role === 'system').map(message => String(message.content ?? '')),
            '你是 DSH 的模型。下方 JSON 保留了此前对话的角色、工具调用和工具结果。按这些历史继续处理最后的用户要求。需要工具时调用 dsh_ 开头的 DSH 工具，DSH 会执行并在下一轮提供结果。优先调用 dsh_ 开头的工具；原生 bash/read 的请求也会暂停并交回 DSH，只有 DSH 返回结果才代表执行。原生工作目录是内部传输目录，实际工作区以 DSH 对话提供的路径为准。',
        ].filter(Boolean).join('\n\n');
        return { system, parts: [{ type: 'text', text: `DSH 对话历史：\n${JSON.stringify(messages.filter(message => message.role !== 'system'))}` }, ...images] };
    }
    async *stream(options) {
        options.signal?.throwIfAborted();
        const release = this.service.beginCall();
        const controller = new AbortController();
        const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 120000);
        const signal = options.signal ? AbortSignal.any([controller.signal, timeout, options.signal]) : AbortSignal.any([controller.signal, timeout]);
        const bridge = new OpencodeHarnessMcp(options.tools ?? []);
        const directory = join(this.service.root, 'requests', randomUUID());
        let sessionId;
        let reply;
        let nativePending = false;
        const abortNative = async () => {
            if (sessionId && nativePending)
                await this.service.request(`/session/${sessionId}/abort`, {}, { directory, timeout: 4000 }).catch(() => { });
        };
        try {
            await this.service.ensure();
            const model = (await this.service.catalog()).find(model => model.id === options.model);
            if (!model)
                throw new LlmError(`OpenCode 本地目录没有模型 ${options.model}，请刷新模型列表`, 'MODEL_NOT_FOUND');
            if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0 || !model.contextWindow))
                throw new LlmError('本地 OpenCode 缺少有效模型窗口或输出上限无效，无法应用本次输出预算', 'INVALID_REQUEST');
            if (options.reasoningEffort && !model.variants.includes(String(options.reasoningEffort)))
                throw new LlmError('本地 OpenCode 未声明这个思考档位，请重新选择模型档位', 'INVALID_REQUEST');
            const input = await this.parts(options, model);
            const nativeShell = nativeShellForTools(options.tools ?? []);
            await bridge.start();
            await mkdir(directory, { recursive: true, mode: 0o700 });
            // 每次调用使用独立配置；不修改服务的全局模型、账号或其他会话参数。
            const limit = Number.isSafeInteger(options.maxTokens) && (options.maxTokens ?? 0) > 0 && model.contextWindow
                ? { provider: { opencode: { models: { [model.id]: { limit: { context: model.contextWindow, output: Math.min(options.maxTokens, model.outputLimit ?? options.maxTokens) } } } } } } : {};
            await writeFile(join(directory, 'opencode.json'), JSON.stringify({
                ...limit, ...(nativeShell ? { shell: nativeShell.path } : {}), small_model: `opencode/${model.id}`,
                mcp: { dsh: { type: 'remote', url: bridge.url, enabled: true, oauth: false } },
                agent: { dsh: { mode: 'primary', description: 'DSH 模型连接', permission: toolPermission, ...(options.temperature === undefined ? {} : { temperature: options.temperature }) } },
            }), { mode: 0o600 });
            const session = await this.service.request('/session', { title: 'DSH 模型请求', permission }, { directory, signal, timeout: 20000 });
            if (typeof session?.id !== 'string' || !/^ses[a-zA-Z0-9_-]+$/.test(session.id))
                throw new LlmError('OpenCode 未返回有效的会话标识', 'SERVER');
            sessionId = session.id;
            nativePending = true;
            const response = this.service.request(`/session/${sessionId}/message`, {
                agent: 'dsh', model: { providerID: 'opencode', modelID: model.id }, ...input,
                ...(options.reasoningEffort ? { variant: String(options.reasoningEffort) } : {}),
            }, { directory, signal, timeout: this.options.timeoutMs ?? 120000 }).then(reply => ({ kind: 'reply', reply }), error => ({ kind: 'error', error }));
            const watching = new AbortController();
            const watch = (async () => {
                while (!watching.signal.aborted && !signal.aborted) {
                    try {
                        const requests = await this.service.request('/permission', undefined, { directory, signal: AbortSignal.any([signal, watching.signal]), timeout: 2500 });
                        if (Array.isArray(requests)) {
                            const owned = requests.filter(request => request.sessionID === sessionId);
                            if (owned.length)
                                return { kind: 'native-tool', requests: owned };
                        }
                        const statuses = await this.service.request('/session/status', undefined, { directory, signal: AbortSignal.any([signal, watching.signal]), timeout: 2500 });
                        const status = statuses?.[sessionId];
                        if (status?.type === 'retry' && typeof status.message === 'string')
                            return { kind: 'retry', message: status.message };
                    }
                    catch { }
                    await waitForPoll(watching.signal);
                }
                return { kind: 'watch-ended' };
            })();
            const first = await Promise.race([response, bridge.called.then(() => ({ kind: 'calls' })), watch]);
            watching.abort();
            await watch;
            if (first.kind === 'native-tool' || first.kind === 'calls') {
                const pending = first.kind === 'native-tool' ? first.requests : await this.service.request('/permission', undefined, { directory, signal, timeout: 2500 });
                const captured = new Set();
                for (const request of Array.isArray(pending) ? pending : []) {
                    if (request.sessionID !== sessionId)
                        continue;
                    const reference = request.tool;
                    if (typeof reference?.messageID !== 'string' || !/^msg[a-zA-Z0-9_-]+$/.test(reference.messageID) || typeof reference.callID !== 'string')
                        throw new LlmError('OpenCode 工具请求缺少可核对的调用信息，已停止原生会话', 'INVALID_REQUEST');
                    const key = `${reference.messageID}:${reference.callID}`;
                    if (captured.has(key))
                        continue;
                    const message = await this.service.request(`/session/${sessionId}/message/${reference.messageID}`, undefined, { directory, signal, timeout: 4000 });
                    const call = captureNativeTool(request, message, sessionId, options.tools ?? [], nativeShell);
                    if (!call)
                        throw new LlmError('OpenCode 工具无法对应当前 DSH 工具或参数，已停止原生执行；请改用当前 DSH 工具', 'INVALID_REQUEST');
                    if (bridge.calls.length >= 32)
                        throw new LlmError('OpenCode 单轮工具调用过多，已停止原生会话', 'INVALID_REQUEST');
                    captured.add(key);
                    bridge.calls.push(call);
                }
                // 同一轮并发调用可一起交给 DSH；未返回任何已执行成功的结果。
                await new Promise(resolve => setTimeout(resolve, 15));
                await abortNative();
                controller.abort();
                const completed = await response;
                if (completed.kind === 'reply')
                    reply = completed.reply;
            }
            else if (first.kind === 'retry') {
                // 上游重试期间 message 请求仍挂起；及时交回真实原因，不让界面空等到超时。
                const code = /rate limit|too many requests|限流|请求过于频繁/i.test(first.message) ? 'RATE_LIMIT' : 'SERVER';
                throw new LlmError(`OpenCode 上游：${first.message.slice(0, 1600)}`, code);
            }
            else if (first.kind === 'error')
                throw first.error;
            else if (first.kind === 'reply') {
                reply = first.reply;
                nativePending = false;
            }
            else {
                signal.throwIfAborted();
                throw new LlmError('OpenCode 请求未完成', 'SERVER');
            }
            options.signal?.throwIfAborted();
            if (!bridge.calls.length && reply?.info?.error)
                throw nativeOpencodeFailure(reply.info.error);
            let index = 0;
            if (bridge.calls.length) {
                for (const call of bridge.calls) {
                    const id = ToolCallId(`opencode_${randomUUID()}`), argumentsJson = JSON.stringify(call.arguments);
                    yield { type: 'block-start', index, blockType: 'tool-call' };
                    // Chat 网关消费 delta，Harness/Responses 同时保留权威收尾块。
                    yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: argumentsJson };
                    yield { type: 'block-end', index: index++, block: { type: 'tool-call', id, name: call.name, arguments: argumentsJson } };
                }
            }
            else {
                for (const part of reply?.parts ?? []) {
                    if (!['text', 'reasoning'].includes(part.type) || typeof part.text !== 'string' || !part.text)
                        continue;
                    let text = part.text;
                    if (part.type === 'text')
                        for (const stop of options.stop ?? []) {
                            if (!stop)
                                continue;
                            const at = text.indexOf(stop);
                            if (at >= 0)
                                text = text.slice(0, at);
                        }
                    if (!text)
                        continue;
                    const type = part.type;
                    yield { type: 'block-start', index, blockType: type };
                    if (type === 'text')
                        yield { type: 'text-delta', index, text };
                    else
                        yield { type: 'reasoning-delta', index, text };
                    yield { type: 'block-end', index: index++, block: { type, text } };
                }
                if (index === 0)
                    throw new LlmError('OpenCode 未返回正文或工具调用', 'EMPTY_RESPONSE');
            }
            const tokens = reply?.info?.tokens;
            if (tokens && typeof tokens.input === 'number' && typeof tokens.output === 'number')
                yield { type: 'usage', usage: { inputTokens: tokens.input, outputTokens: tokens.output, ...(tokens.reasoning > 0 ? { reasoningTokens: tokens.reasoning } : {}), ...(tokens.cache?.read > 0 ? { cacheReadTokens: tokens.cache.read } : {}), ...(tokens.cache?.write > 0 ? { cacheWriteTokens: tokens.cache.write } : {}) } };
            const reason = bridge.calls.length ? 'tool-calls' : reply?.info?.finish === 'length' ? 'max-tokens' : 'stop';
            yield { type: 'finish', reason: { kind: reason } };
        }
        catch (error) {
            options.signal?.throwIfAborted();
            if (timeout.aborted)
                throw new LlmError('OpenCode 模型请求超时，已取消原生会话', 'TIMEOUT');
            if (error instanceof LlmError)
                throw error;
            throw nativeOpencodeFailure(error);
        }
        finally {
            await abortNative();
            controller.abort();
            await bridge.close();
            try {
                if (sessionId) {
                    await this.service.request(`/session/${sessionId}`, undefined, { method: 'DELETE', directory, timeout: 4000 }).catch(() => { });
                    await this.service.request('/instance/dispose', {}, { directory, timeout: 4000 }).catch(() => { });
                }
                await rm(directory, { recursive: true, force: true });
            }
            finally {
                release();
            }
        }
    }
}
//# sourceMappingURL=opencode-local-adapter.js.map