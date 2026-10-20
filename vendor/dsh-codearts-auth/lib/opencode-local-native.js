import { mkdir, readFile, writeFile, rename, access, symlink, rm } from 'node:fs/promises';
import { constants, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Agent, fetch as localFetch } from 'undici';
/** 本地 serve 与 Zen 远程 OpenAI 端点是两种协议，不能共用 URL 拼接。 */
export function normalizeOpencodeLocalUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port === '0' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
        throw Error('请填写本机 OpenCode 服务地址，例如 http://127.0.0.1:4096');
    return url.origin;
}
export class OpencodeLocalService {
    options;
    root;
    baseUrl = 'http://127.0.0.1:4096';
    dispatcher = new Agent({ connections: 8 });
    child;
    starting;
    loading;
    initialized;
    models = [];
    catalogAt = 0;
    version;
    error;
    disposed = false;
    busy = 0;
    constructor(options) {
        this.options = options;
        this.root = join(options.home, 'opencode-local');
    }
    cachedModels() { return this.models; }
    beginCall() { this.busy++; return () => { this.busy--; }; }
    init() {
        return this.initialized ??= (async () => {
            await mkdir(this.root, { recursive: true, mode: 0o700 });
            try {
                const config = JSON.parse(await readFile(join(this.root, 'settings.json'), 'utf8'));
                this.baseUrl = normalizeOpencodeLocalUrl(config.baseUrl);
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        })();
    }
    async request(path, body, options = {}) {
        await this.init();
        const auth = await this.options.readAuth();
        const url = new URL(path, this.baseUrl);
        if (options.directory)
            url.searchParams.set('directory', options.directory);
        const headers = { 'content-type': 'application/json', accept: 'application/json' };
        if (auth?.password)
            headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
        const timeout = AbortSignal.timeout(options.timeout ?? 5000);
        const response = await (this.options.fetcher ?? localFetch)(url, {
            method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers, redirect: 'error',
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
            dispatcher: this.dispatcher,
        });
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) {
            const message = response.status === 401 || response.status === 403
                ? '本地 OpenCode 服务访问密码未通过校验，请在 JetHub 连接设置中核对'
                : `本地 OpenCode 返回了网页或非 JSON 内容（HTTP ${response.status}），请核对 serve 地址`;
            throw Object.assign(Error(message), { status: response.status });
        }
        const value = await response.json();
        if (!response.ok) {
            const message = value?.data?.message ?? value?.error?.message ?? value?.message ?? `HTTP ${response.status}`;
            const error = Object.assign(Error(`OpenCode 本地服务：${String(message).slice(0, 1200)}`), { status: response.status });
            throw error;
        }
        return value;
    }
    async health() {
        const value = await this.request('/global/health', undefined, { timeout: 1500 });
        if (value?.healthy !== true || typeof value.version !== 'string' || !value.version)
            throw Error('此地址不是已就绪的 OpenCode serve 服务');
        this.version = value.version;
        return true;
    }
    async executable() {
        const candidates = [this.options.executable, process.env.DSH_OPENCODE_BINARY, join(this.options.home, 'tools/opencode/opencode'), join(dirname(process.execPath), 'opencode'), join(homedir(), '.opencode/bin/opencode'), join(homedir(), '.local/bin/opencode'), ...String(process.env.PATH ?? '').split(':').filter(Boolean).map(p => join(p, 'opencode'))];
        for (const path of candidates) {
            if (!path)
                continue;
            try {
                await access(path, constants.X_OK);
                return path;
            }
            catch { }
        }
        return undefined;
    }
    ensure() {
        if (this.disposed)
            return Promise.reject(Error('OpenCode 服务已关闭'));
        return this.starting ??= this.start().finally(() => { this.starting = undefined; });
    }
    async start() {
        await this.init();
        try {
            await this.health();
            this.error = undefined;
            return;
        }
        catch (error) {
            if (error.status === 401 || error.status === 403)
                throw error;
            // HTTP 成功但内容不对不抢占端口；只在连接确实失败时尝试启动。
            const cause = error.cause;
            if (cause?.code !== 'ECONNREFUSED' && !(cause?.errors?.length && cause.errors.every(error => error.code === 'ECONNREFUSED')))
                throw error;
        }
        const binary = await this.executable();
        if (!binary)
            throw Error('本机尚未安装 OpenCode 可执行程序，请安装完整的 DSH 更新包或官方 OpenCode CLI');
        let auth = await this.options.readAuth();
        if (!auth?.password) {
            auth = { username: 'opencode', password: randomBytes(32).toString('base64url') };
            await this.options.saveAuth(auth);
        }
        const state = join(this.root, 'runtime');
        await mkdir(state, { recursive: true, mode: 0o700 });
        const env = { ...process.env, XDG_CONFIG_HOME: join(state, 'config'), XDG_DATA_HOME: join(state, 'data'), XDG_CACHE_HOME: join(state, 'cache'), XDG_STATE_HOME: join(state, 'state'), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_SERVER_USERNAME: auth.username, OPENCODE_SERVER_PASSWORD: auth.password };
        delete env.OPENCODE_CONFIG_CONTENT;
        delete env.OPENCODE_DISABLE_PROJECT_CONFIG;
        const loader = this.options.loader ?? process.env.DSH_OPENCODE_LOADER;
        let args = [];
        if (loader) {
            const lib = this.options.libraryRoot ?? dirname(loader), links = join(this.root, 'musl');
            await mkdir(links, { recursive: true, mode: 0o700 });
            for (const [name, target] of [['libgcc_s.so.1', 'libdshopencodegcc.so'], ['libstdc++.so.6', 'libdshopencodestdcpp.so']]) {
                await rm(join(links, name), { force: true });
                await symlink(join(lib, target), join(links, name));
            }
            args = ['--library-path', links, binary];
        }
        const port = new URL(this.baseUrl).port || '80';
        args.push('serve', '--hostname', new URL(this.baseUrl).hostname.replace(/^\[|\]$/g, ''), '--port', port);
        const log = openSync(join(this.root, 'serve.log'), 'a', 0o600);
        let spawnError;
        try {
            if (this.disposed)
                throw Error('OpenCode 启动已取消');
            this.child = spawn(loader ?? binary, args, { cwd: state, env, stdio: ['ignore', log, log], windowsHide: true });
            this.child.on('error', error => { spawnError = error; });
            this.child.unref();
        }
        finally {
            closeSync(log);
        }
        for (let attempt = 0; attempt < 45; attempt++) {
            if (this.disposed)
                throw Error('OpenCode 启动已取消');
            if (spawnError)
                throw spawnError;
            if (this.child.exitCode !== null || this.child.signalCode !== null)
                throw Error('OpenCode 服务启动后退出，请查看本地服务日志');
            try {
                await this.health();
                this.error = undefined;
                return;
            }
            catch { }
            await new Promise(resolve => setTimeout(resolve, 400));
        }
        throw Error('OpenCode 服务尚未就绪，请稍后点击重连');
    }
    catalog(force = false) {
        if (!force && this.catalogAt > Date.now() - 60000)
            return Promise.resolve(this.models);
        return this.loading ??= (async () => {
            await this.ensure();
            const value = await this.request('/provider', undefined, { timeout: 15000 });
            const provider = Array.isArray(value?.all) ? value.all.find((p) => p && typeof p === 'object' && p.id === 'opencode') : undefined;
            if (!provider?.models || typeof provider.models !== 'object')
                throw Error('OpenCode 没有返回 opencode 模型目录');
            const models = [];
            for (const [id, raw] of Object.entries(provider.models)) {
                const model = raw;
                if (!model || model.cost?.input !== 0 || model.cost?.output !== 0)
                    continue;
                const positive = (n) => Number.isSafeInteger(n) && Number(n) > 0 ? Number(n) : undefined;
                models.push({ id, name: typeof model.name === 'string' ? model.name : id, inputModalities: model.capabilities?.input?.image === true ? ['text', 'image'] : ['text'], contextWindow: positive(model.limit?.context), outputLimit: positive(model.limit?.output), variants: model.variants && typeof model.variants === 'object' ? Object.keys(model.variants) : [] });
            }
            this.models = models;
            this.catalogAt = Date.now();
            this.error = undefined;
            try {
                this.options.onCatalogChanged?.();
            }
            catch { }
            return models;
        })().catch(error => { this.error = error instanceof Error ? error.message : String(error); throw error; }).finally(() => { this.loading = undefined; });
    }
    warm() { void this.catalog().catch(error => { this.error = error instanceof Error ? error.message : String(error); }); }
    async status() {
        await this.init();
        let healthy = false;
        try {
            healthy = await this.health();
        }
        catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }
        return { baseUrl: this.baseUrl, healthy, version: healthy ? this.version : undefined, modelCount: this.models.length, models: this.models, managed: !!this.child && this.child.exitCode === null, executableAvailable: !!await this.executable(), error: healthy ? undefined : this.error, activeRequests: this.busy };
    }
    async handleRpc(method, payload) {
        if (!method.startsWith('opencode.local.'))
            return undefined;
        switch (method) {
            case 'opencode.local.status': return { ok: true, value: await this.status() };
            case 'opencode.local.start':
            case 'opencode.local.refresh':
                await this.catalog(true);
                return { ok: true, value: await this.status() };
            case 'opencode.local.configure': {
                if (this.busy)
                    throw Error('OpenCode 任务仍在调用，请结束后再修改服务地址');
                if (this.starting || this.loading)
                    throw Error('OpenCode 服务仍在准备中，请就绪后再保存地址');
                const value = payload;
                const baseUrl = normalizeOpencodeLocalUrl(String(value?.baseUrl ?? ''));
                await this.init();
                if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
                    const child = this.child;
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => { child.off('exit', done); reject(Error('旧 OpenCode 服务尚未退出，请稍后再保存')); }, 2500);
                        const done = () => { clearTimeout(timer); resolve(); };
                        child.once('exit', done);
                        child.kill('SIGTERM');
                    });
                }
                const file = join(this.root, 'settings.json'), tmp = file + '.tmp';
                const before = await readFile(file).catch(error => { if (error.code === 'ENOENT')
                    return undefined; throw error; });
                await writeFile(tmp, JSON.stringify({ baseUrl }), { mode: 0o600 });
                await rename(tmp, file);
                try {
                    if (typeof value.password === 'string' && value.password)
                        await this.options.saveAuth({ username: typeof value.username === 'string' && value.username ? value.username : 'opencode', password: value.password });
                }
                catch (error) {
                    if (before) {
                        await writeFile(tmp, before, { mode: 0o600 });
                        await rename(tmp, file);
                    }
                    else
                        await rm(file, { force: true });
                    throw error;
                }
                this.baseUrl = baseUrl;
                this.models = [];
                this.catalogAt = 0;
                try {
                    this.options.onCatalogChanged?.();
                }
                catch { }
                return { ok: true, value: await this.status() };
            }
            default: throw Error('未知的 OpenCode 本地服务操作');
        }
    }
    async dispose() {
        this.disposed = true;
        if (this.child && this.child.exitCode === null && this.child.signalCode === null)
            this.child.kill('SIGTERM');
        await this.dispatcher.destroy();
    }
}
//# sourceMappingURL=opencode-local-native.js.map