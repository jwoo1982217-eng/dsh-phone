/** AutoClaw 账号管理和模型适配，复用 Jet Hub 的账号池与凭据存储。 */
import { randomUUID } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { providerCatalogVisible } from './account-pool.js';
import { AUTOCLAW, AutoclawApi, autoclawHeaders, autoclawExpiry, parseAutoclawCredential } from './autoclaw-api.js';
import { registerAdapterIdempotent } from './llm-register-compat.js';
import { collectImages, consumeOpenAiSse, serializeMessages } from './openai-compat.js';
import { consumeAnthropicSse, toAnthropicMessages, toAnthropicTools } from './zcode-anthropic.js';
// AutoClaw 对话接口要求客户端身份和 Tooling 段；缺少时实机会返回 HTTP 406。
// 仅补充协议前缀，调用方的提示词、工具和消息保持原文。
export const AUTOCLAW_SYSTEM_PREFIX = 'You are a personal assistant running inside OpenClaw.\n\n## Tooling\nAvailable tools are policy-filtered. Names are case-sensitive; call exactly as listed.\n';
export function autoclawSystem(system) {
    return system?.startsWith(AUTOCLAW_SYSTEM_PREFIX) ? system : AUTOCLAW_SYSTEM_PREFIX + (system ? `\n${system}` : '');
}
export class AutoclawIntegration {
    ctx;
    pool;
    api;
    adapter;
    pending = new Map();
    refreshing = new Map();
    constructor(ctx, pool, api = new AutoclawApi(), readImage) {
        this.ctx = ctx;
        this.pool = pool;
        this.api = api;
        this.adapter = new AutoclawAdapter(this, readImage);
    }
    async credential(ref) {
        const raw = await this.ctx.credentials.resolve(credentialRef(ref));
        const c = raw && parseAutoclawCredential(raw.value);
        if (!c)
            throw new Error('请先在 Jet Hub 登录 AutoClaw 账号');
        const expiry = autoclawExpiry(c);
        return expiry !== undefined && expiry < Date.now() + 60_000 ? this.refresh(ref, c) : c;
    }
    async refresh(ref, credential) {
        const existing = this.refreshing.get(ref);
        if (existing)
            return existing;
        const task = (async () => {
            const raw = credential ?? parseAutoclawCredential((await this.ctx.credentials.resolve(credentialRef(ref)))?.value ?? '');
            if (!raw)
                throw new Error('AutoClaw 凭据不可用，请重新登录');
            const next = await this.api.refresh(raw);
            await this.ctx.credentials.set(credentialRef(ref), JSON.stringify(next));
            for (const a of this.pool.listAccountsByProvider(AUTOCLAW.id)) {
                if (a.credentialRef === ref)
                    await this.pool.updateAccount(a.id, { expiresAt: autoclawExpiry(next), refreshable: true });
            }
            return next;
        })().finally(() => this.refreshing.delete(ref));
        this.refreshing.set(ref, task);
        return task;
    }
    prune() {
        for (const [id, p] of this.pending)
            if (p.expires < Date.now())
                this.pending.delete(id);
    }
    /** 返回 undefined 表示交给既有通用 RPC；不改变其他供应商行为。 */
    async handle(method, payload) {
        const req = payload;
        if (method === 'account.refresh') {
            const a = this.pool.listAccountsByProvider(AUTOCLAW.id).find(a => a.id === req?.accountId);
            if (!a)
                return undefined;
            await this.refresh(a.credentialRef);
            return { ok: true, value: { success: true } };
        }
        if (!method.startsWith('autoclaw.') && req?.provider !== AUTOCLAW.id)
            return undefined;
        if (method === 'account.create') {
            this.prune();
            if (this.pending.size >= 32)
                throw new Error('AutoClaw 登录请求过多，请关闭旧登录窗口后稍后重试');
            const accountId = `autoclaw-${randomUUID()}`;
            this.pending.set(accountId, { device: randomUUID(), expires: Date.now() + 10 * 60_000 });
            // 手机端直接在设置页完成短信登录，不要求安装桌面客户端。
            return { ok: true, value: { accountId, loginMode: 'sms' } };
        }
        if (method === 'autoclaw.cancel') {
            this.pending.delete(req.accountId);
            return { ok: true, value: {} };
        }
        if (method === 'autoclaw.sendSms' || method === 'autoclaw.login') {
            this.prune();
            const p = this.pending.get(req.accountId);
            if (!p)
                throw new Error('登录已超时，请重新点击新建账号');
            if (p.busy)
                throw new Error('正在处理，请稍候');
            const phone = typeof req.phone === 'string' ? req.phone.trim() : '';
            if (!/^1[3-9]\d{9}$/.test(phone))
                throw new Error('请输入 11 位有效手机号');
            p.busy = true;
            try {
                if (method === 'autoclaw.sendSms') {
                    if (p.sentAt && Date.now() - p.sentAt < 60_000)
                        throw new Error('请等待 60 秒后重新获取验证码');
                    await this.api.sendSms(phone, p.device);
                    p.phone = phone;
                    p.sentAt = Date.now();
                    return { ok: true, value: { cooldownSeconds: 60 } };
                }
                if (p.phone !== phone)
                    throw new Error('请先为这个手机号获取验证码');
                if (typeof req.code !== 'string' || !/^\d{4,8}$/.test(req.code))
                    throw new Error('请输入短信验证码');
                const c = await this.api.login(phone, req.code, p.device);
                if (this.pending.get(req.accountId) !== p)
                    throw new Error('登录窗口已关闭，请重新登录');
                // 按官方 user_id 去重，设备号不作为用户身份。
                let accountId = req.accountId;
                let ref = `AUTOCLAW_ACCOUNT_${randomUUID().replaceAll('-', '').toUpperCase()}`;
                for (const entry of this.pool.listAccountsByProvider(AUTOCLAW.id)) {
                    const stored = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef));
                    if (stored && parseAutoclawCredential(stored.value)?.user_id === c.user_id) {
                        accountId = entry.id;
                        ref = entry.credentialRef;
                        break;
                    }
                }
                await this.ctx.credentials.set(credentialRef(ref), JSON.stringify(c));
                const patch = { nickname: c.nickname, expiresAt: autoclawExpiry(c), refreshable: true };
                if (accountId === req.accountId)
                    await this.pool.addAccount({ id: accountId, provider: AUTOCLAW.id, credentialRef: ref, createdAt: Date.now(), enabled: true, ...patch });
                else
                    await this.pool.updateAccount(accountId, patch);
                this.pending.delete(req.accountId);
                this.adapter.invalidate();
                // 模型配置暂时失败不撤销成功的登录；界面刷新列表时可重新拉取。
                await this.adapter.load().catch(() => { });
                this.ctx.emit('llm/adapters-updated');
                return { ok: true, value: { accountId, success: true } };
            }
            finally {
                p.busy = false;
            }
        }
        if (method === 'credits.balances') {
            const accounts = await Promise.all(this.pool.listAccountsByProvider(AUTOCLAW.id).map(async (a) => {
                try {
                    return { accountId: a.id, balance: { total: await this.api.balance(await this.credential(a.credentialRef)), expiredTotal: 0, packages: [] } };
                }
                catch (error) {
                    return { accountId: a.id, balance: null, error: error instanceof Error ? error.message : '余额读取失败' };
                }
            }));
            return { ok: true, value: { accounts } };
        }
        return undefined;
    }
}
export class AutoclawAdapter extends LlmAdapter {
    integration;
    readImage;
    models = [];
    loading;
    constructor(integration, readImage) {
        super();
        this.integration = integration;
        this.readImage = readImage;
    }
    handleRpc(method, payload) { return this.integration.handle(method, payload); }
    providerInfo(provider) { return { id: provider, name: AUTOCLAW.displayName }; }
    invalidate() { this.models = []; }
    listAllModels() { return this.models.map(m => ({ id: m.id, name: m.name })); }
    async load() {
        if (this.models.length)
            return;
        if (this.loading)
            return this.loading;
        this.loading = (async () => {
            const a = this.integration.pool.listAccountsByProvider(AUTOCLAW.id).find(a => a.enabled);
            if (a)
                this.models = await this.integration.api.models(await this.integration.credential(a.credentialRef));
        })().finally(() => { this.loading = undefined; });
        return this.loading;
    }
    async listModels(_provider) {
        if (!await providerCatalogVisible(this.integration.pool, AUTOCLAW.id))
            return [];
        await this.load();
        const disabled = this.integration.pool.disabledModelsFor(AUTOCLAW.id);
        return this.models.filter(m => !disabled.has(m.id)).map(m => ({ provider: AUTOCLAW.id, id: m.id, name: m.name, inputModalities: m.input }));
    }
    async resolveModel(provider, id) {
        await this.load();
        const m = this.models.find(m => m.id === id);
        if (!m)
            throw new LlmError('AutoClaw 模型不在当前官方目录中，请刷新模型列表', 'UNKNOWN_MODEL');
        return { provider, id, name: m.name, inputModalities: m.input, ...m.contextWindow ? { context: { contextWindow: m.contextWindow } } : {}, ...m.maxTokens ? { defaultMaxTokens: m.maxTokens } : {} };
    }
    async prepareCall(provider, model, _signal) {
        return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) };
    }
    async *stream(options) {
        await this.load();
        const m = this.models.find(m => m.id === options.model);
        if (!m)
            throw new LlmError('AutoClaw 模型不存在', 'UNKNOWN_MODEL');
        const selected = await this.integration.pool.getAvailableAccount(AUTOCLAW.id, options.model);
        if (!selected)
            throw new LlmError('请先在 Jet Hub 登录并启用 AutoClaw 账号', 'MISSING_CREDENTIAL');
        const ref = selected.entry.credentialRef;
        let c = await this.integration.credential(ref);
        const images = new Map();
        for (const message of options.messages)
            if (Array.isArray(message.content))
                collectImages(message.content, images);
        const urls = new Map();
        for (const [id, image] of images) {
            if (!m.input.includes('image') || !this.readImage)
                throw new LlmError('当前 AutoClaw 模型不能读取图片', 'UNSUPPORTED_CONTENT');
            const data = await this.readImage(image);
            if (data)
                urls.set(id, `data:${data.mediaType};base64,${Buffer.from(data.data).toString('base64')}`);
        }
        const wire = serializeMessages(options.messages, urls);
        const anthropic = m.api === 'anthropic-messages';
        const tools = options.tools ?? [];
        const system = autoclawSystem(options.system);
        const body = anthropic ? {
            model: options.model, stream: true, max_tokens: options.maxTokens ?? m.maxTokens ?? 8192,
            messages: toAnthropicMessages(wire), system,
            ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
            ...(options.stop?.length ? { stop_sequences: options.stop } : {}),
        } : {
            model: options.model, stream: true,
            messages: [{ role: 'system', content: system }, ...wire],
            ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
            ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
            ...(options.stop?.length ? { stop: options.stop } : {}),
        };
        if (options.temperature !== undefined)
            Object.assign(body, { temperature: options.temperature });
        const send = () => {
            const headers = autoclawHeaders();
            Object.assign(headers, { 'X-Authorization': `Bearer ${c.access_token.replace(/^Bearer\s+/i, '')}`, 'X-Request-Model': options.model, 'X-Client-Type': 'pc', 'X-Trace-Id': randomUUID(), 'X-Request-Id': randomUUID(), 'x_trace_id': 'autoclaw-desktop', Accept: 'text/event-stream' });
            if (anthropic)
                headers['anthropic-version'] = '2023-06-01';
            return this.integration.api.fetchImpl(`${AUTOCLAW.origin}/autoclaw-proxy/proxy/autoclaw/${anthropic ? 'v1/messages' : 'chat/completions'}`, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal, redirect: 'error' });
        };
        let response = await send();
        if (response.status === 401) {
            c = await this.integration.refresh(ref, c);
            response = await send();
        }
        if (!response.ok || !response.body) {
            if (response.status === 429)
                await this.integration.pool.updateModelRateLimit(selected.entry.id, options.model, Date.now() + 60_000);
            throw new LlmError(`AutoClaw 模型请求失败（HTTP ${response.status}）`, response.status === 401 ? 'MISSING_CREDENTIAL' : response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}`);
        }
        if (anthropic)
            yield* consumeAnthropicSse(response.body, { label: AUTOCLAW.id, model: options.model, signal: options.signal });
        else
            yield* consumeOpenAiSse(response, { signal: options.signal }, { label: AUTOCLAW.id, firstTokenTimeoutMs: 120_000, chunkTimeoutMs: 120_000 });
    }
}
export function registerAutoclaw(ctx, pool, readImage) {
    const integration = new AutoclawIntegration(ctx, pool, undefined, readImage);
    registerAdapterIdempotent(ctx.llm, [AUTOCLAW.id], integration.adapter, message => ctx.logger.warn(message));
    return integration;
}
//# sourceMappingURL=autoclaw.js.map