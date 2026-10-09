/** 登录账号的额度来源；只读取已有密钥，不创建云端密钥，不向客户端返回密钥。 */
import { createHash } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { fetchZcodeBalance } from './zcode-upstream.js';
const services = new WeakMap();
export function zcodeSources(ctx, pool) {
    let service = services.get(pool);
    if (!service) {
        service = new ZcodeSources(ctx, pool);
        services.set(pool, service);
    }
    return service;
}
export class ZcodeSources {
    ctx;
    pool;
    fetchImpl;
    cache = new Map();
    constructor(ctx, pool, fetchImpl = fetch) {
        this.ctx = ctx;
        this.pool = pool;
        this.fetchImpl = fetchImpl;
    }
    async read(entry) {
        const raw = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef));
        if (!raw)
            throw new Error('当前 ZCode 账号凭据不可用，请重新登录');
        return JSON.parse(raw.value);
    }
    async get(url, headers) {
        const response = await this.fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(15_000), redirect: 'error' });
        if (!response.ok)
            throw new Error(`来源查询失败（HTTP ${response.status}）`);
        const text = await response.text();
        if (text.length > 1024 * 1024)
            throw new Error('来源查询返回过大');
        const value = JSON.parse(text);
        if (value.success === false || (typeof value.code === 'number' && value.code !== 0 && value.code !== 200))
            throw new Error('上游未允许读取此额度来源');
        return value.data ?? value;
    }
    async projectKey(host, token, org, project, team) {
        const headers = { Authorization: token, 'Content-Type': 'application/json', 'bigmodel-organization': org, 'bigmodel-project': project };
        const base = `${host}/api/biz/v1/organization/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/api_keys`;
        const raw = await this.get(base, headers);
        const list = Array.isArray(raw) ? raw : [];
        const key = team ? list.find((v) => v.name === 'zcode-team-api-key' && v.keyType === 2)
            : list.find((v) => v.name === 'zcode-api-key' && v.keyType !== 2) ?? list.find((v) => v.keyType !== 2 && typeof v.apiKey === 'string');
        if (typeof key?.apiKey !== 'string' || !key.apiKey.trim())
            return undefined;
        const copied = await this.get(`${base}/copy/${encodeURIComponent(key.apiKey)}`, headers);
        return typeof copied?.secretKey === 'string' && copied.secretKey.trim() ? `${key.apiKey}.${copied.secretKey}` : key.apiKey;
    }
    async quota(host, key, org, project) {
        const data = await this.get(`${host}/api/monitor/usage/quota/limit`, {
            Authorization: key, ...(org && project ? { 'bigmodel-organization': org, 'bigmodel-project': project } : {}),
        });
        const limits = Array.isArray(data?.limits) ? data.limits : [];
        const rows = limits.filter((v) => typeof v.remaining === 'number' || typeof v.percentage === 'number').map((v, index) => {
            // 数字unit是上游周期枚举，不能拼到remaining后面当数量单位。
            const label = v.type === 'TIME_LIMIT' ? '5小时' : v.type === 'WEEKLY_LIMIT' ? '每周' : `套餐配额${index + 1}`;
            const unit = typeof v.unit === 'string' ? v.unit : '';
            const reset = typeof v.nextResetTime === 'number' && v.nextResetTime > 0
                ? `（重置：${new Date(v.nextResetTime < 1e12 ? v.nextResetTime * 1000 : v.nextResetTime).toLocaleString('zh-CN')}）` : '';
            // 官方percentage表示已用比例，不擅自倒算成积分数。
            return label + (typeof v.remaining === 'number' ? `：剩余 ${v.remaining}${unit}` : `：已用 ${v.percentage}%`) + reset;
        });
        return rows.join('；') || '未取得余量，以平台用量页为准';
    }
    async discover(c) {
        const international = Boolean(c.zai_access_token);
        const host = international ? 'https://api.z.ai' : 'https://bigmodel.cn';
        const api = international ? 'https://api.z.ai' : 'https://open.bigmodel.cn';
        const token = c.zai_access_token ?? c.bigmodel_access_token;
        const sources = [{ id: 'start-plan', label: 'Start Plan · 每日赠送', kind: 'start-plan', available: Boolean(c.zcode_jwt), projection: { id: 'start-plan', kind: 'start-plan', url: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages', key: c.zcode_jwt } }];
        try {
            const b = await fetchZcodeBalance(c, this.fetchImpl);
            sources[0].quota = b && !b.enterprise ? b.buckets.map(bucket => `${bucket.showName ?? '赠送额度'}：剩余 ${bucket.availableUnits ?? bucket.remainingUnits ?? '未知'} ${bucket.unitType ?? '积分'}`).join('；') || '余额见本账号 Start Plan 积分行' : '赠送额度查询失败';
        }
        catch {
            sources[0].quota = '赠送额度查询失败';
        }
        let personal = international ? c.coding_plan_key_zai : c.coding_plan_key_bigmodel;
        const personalRow = { id: 'individual', label: `${international ? 'Z.ai' : 'BigModel'} · 个人套餐`, kind: 'individual', available: Boolean(personal), projection: { id: 'individual', kind: 'individual', url: `${api}/api/anthropic/v1/messages`, key: personal } };
        sources.push(personalRow);
        if (!token) {
            personalRow.reason = personal ? undefined : '缺少平台授权，请重新登录此账号';
            return sources;
        }
        try {
            const info = await this.get(`${host}/api/biz/customer/getCustomerInfo`, { Authorization: token, 'Content-Type': 'application/json' });
            const orgs = Array.isArray(info?.organizations) ? info.organizations : [];
            // 默认机构的普通项目是个人密钥所在项目；team projectType=2另作套餐来源。
            const ordinary = orgs.flatMap((o) => (o.projects ?? []).filter((p) => String(p.projectType) !== '2').map((p) => ({ o, p })));
            ordinary.sort((a, b) => Number(String(b.o.organizationName).includes('默认机构')) - Number(String(a.o.organizationName).includes('默认机构')));
            for (const { o, p } of orgs.flatMap((o) => (o.projects ?? []).map((p) => ({ o, p }))).slice(0, 64)) {
                if (typeof o.organizationId !== 'string' || typeof p.projectId !== 'string')
                    continue;
                const team = String(p.projectType) === '2';
                let key, reason;
                try {
                    key = await this.projectKey(host, token, o.organizationId, p.projectId, team);
                }
                catch {
                    reason = '机构密钥读取失败，请刷新或重新授权';
                }
                if (!team && ordinary[0]?.o.organizationId === o.organizationId && ordinary[0]?.p.projectId === p.projectId && !personal && key) {
                    personal = key;
                    personalRow.projection.key = key;
                    personalRow.available = true;
                }
                const kind = team ? 'team' : 'organization-flow';
                const id = `${kind}:${encodeURIComponent(o.organizationId)}:${encodeURIComponent(p.projectId)}`;
                const row = { id, kind, label: `${team ? '机构套餐' : '机构流量'} · ${String(o.organizationName ?? '机构')} / ${String(p.projectName ?? '项目')}`, available: Boolean(key), reason: reason ?? (key ? undefined : '未找到已有密钥，请先在官方客户端或平台配置'), quota: team ? undefined : '资源包 / 充值余额，余量以机构后台为准', projection: { id, kind, key, url: team ? `${api}/api/anthropic/v1/messages` : `${api}/api/paas/v4/chat/completions`, organizationId: o.organizationId, projectId: p.projectId } };
                if (team && key) {
                    try {
                        const entitlement = await this.get(`${host}/api/biz/team/subscribe/product/querySubscribeDetail`, { Authorization: token, 'bigmodel-organization': o.organizationId, 'bigmodel-project': p.projectId });
                        if (entitlement.hasSubscription === false || entitlement.status === 'EXPIRED' || entitlement.memberGrantStatus === 'UNASSIGNED') {
                            row.available = false;
                            row.reason = '机构套餐未生效或尚未分配席位';
                        }
                    }
                    catch {
                        row.reason = '机构套餐资格暂未确认';
                    }
                    try {
                        row.quota = await this.quota(host, key, o.organizationId, p.projectId);
                    }
                    catch {
                        row.quota = '机构套餐余量查询失败';
                    }
                }
                sources.push(row);
            }
        }
        catch {
            personalRow.reason = '平台机构目录读取失败；已有个人套餐凭据保留';
        }
        if (personal) {
            try {
                personalRow.quota = await this.quota(host, personal);
            }
            catch {
                personalRow.quota = '个人套餐余量查询失败';
            }
        }
        else {
            personalRow.reason ??= '未找到已有个人套餐密钥，请先在官方客户端或平台配置';
        }
        return sources;
    }
    async load(entry, c, refresh = false) {
        const fingerprint = createHash('sha256').update(JSON.stringify(c)).digest('hex');
        const old = this.cache.get(entry.id);
        if (!refresh && old?.fingerprint === fingerprint && old.expires > Date.now())
            return old.sources;
        const sources = this.discover(c);
        this.cache.set(entry.id, { fingerprint, expires: Date.now() + 5 * 60_000, sources });
        try {
            return await sources;
        }
        catch (error) {
            this.cache.delete(entry.id);
            throw error;
        }
    }
    async list(accountId, refresh = false) {
        const entry = this.pool.findAccount(accountId);
        if (!entry || entry.provider !== 'zcode')
            throw new Error('ZCode 账号不存在');
        const sources = await this.load(entry, await this.read(entry), refresh);
        return { accountId, selected: entry.zcodeSource ?? 'auto', sources: sources.map(({ projection, ...publicRow }) => publicRow) };
    }
    async select(accountId, sourceId) {
        const entry = this.pool.findAccount(accountId);
        if (!entry || entry.provider !== 'zcode')
            throw new Error('ZCode 账号不存在');
        if (sourceId !== 'auto') {
            const found = (await this.load(entry, await this.read(entry))).find(s => s.id === sourceId);
            if (!found?.available)
                throw new Error(found?.reason ?? '当前账号没有可用的这个额度来源');
        }
        await this.pool.updateAccount(accountId, { zcodeSource: sourceId });
    }
    async resolve(entry, c) {
        if (!entry.zcodeSource || entry.zcodeSource === 'auto')
            return c;
        const source = (await this.load(entry, c)).find(s => s.id === entry.zcodeSource);
        if (!source?.available || !source.projection.key)
            throw new LlmError('ZCode 所选额度来源不可用，请到账号卡片刷新并选择', 'MISSING_CREDENTIAL');
        return { ...c, source_selection: source.projection };
    }
}
//# sourceMappingURL=zcode-sources.js.map