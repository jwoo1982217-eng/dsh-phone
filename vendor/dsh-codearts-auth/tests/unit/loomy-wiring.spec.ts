import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8')

/**
 * 源码级回归：新增 provider 的接线点一处都不能漏。
 * 历史缺陷正是「加了 provider 但忘了在 modelAdapters 里登记」→
 * 设置页里被关闭的模型显示成裸 id（丢倍率）。
 */
describe('Loomy 在 index.ts 的接线', () => {
  it('导入并实例化 LoomyAuth', () => {
    expect(indexSource).toContain("from './loomy-auth.js'")
    expect(indexSource).toContain('new LoomyAuth(ctx)')
  })

  it('注册 Loomy 适配器并接收返回值', () => {
    expect(indexSource).toContain("from './loomy-adapter.js'")
    expect(indexSource).toContain('registerLoomyLlm(ctx,')
    expect(indexSource).toMatch(/const loomyAdapter = registerLoomyLlm/)
  })

  it('provider 解析用 LOOMY.id（不写死字面量）', () => {
    expect(indexSource).toContain("pool.getAvailableAccount(LOOMY.id, '')")
  })

  it('refresh 走 refreshAccountCredential（刷新解析凭据所用的那个账号）', () => {
    // `[^)]*` 容忍签名扩展：续期成功后要把新 `expiresAt` 回写账号池，
    // 故实际调用还带 `pool` + `available.entry.id`（见 issue !IKIRTT）。
    expect(indexSource).toMatch(/loomy\.refreshAccountCredential\(available\.entry\.credentialRef[^)]*\)/)
  })

  /**
   * ⚠️ **按余额优先选号（负载均衡）**。
   *
   * **真实缺陷**：实测 Loomy 今日额度（每天 5000）耗尽后**继续扣永久积分
   * 且不报错**（静默降级），而既有「限流 → 换号」只在服务端返回限流错误时
   * 触发，故对它完全无效 —— 会一直烧同一个号（用户报障）。
   */
  it('接入按余额优先的选号器（负载均衡）', () => {
    expect(indexSource).toContain("from './loomy-balance-selector.js'")
    expect(indexSource).toContain('new LoomyBalanceSelector(')
    expect(indexSource).toContain('loomyBalanceSelector.select(')
    // 候选必须先按「未停用」过滤（用户要求：策略建立在未停用基础上）
    expect(indexSource).toMatch(/listAccountsByProvider\(LOOMY\.id\)[\s\S]{0,300}?filter\(a => a\.enabled\)/)
    // 再按模型限流过滤（用户要求：策略建立在模型未受限基础上）
    expect(indexSource).toMatch(/modelRateLimits\[key\]/)
  })

  /**
   * ⚠️ **模型 id 必须透传给选号器**：限流是**按模型**记的，
   * 传空串等于「不按模型过滤」，会让模型级限流失效（原实现的疏漏）。
   */
  it('resolveCredential 接收并透传 modelId（限流按模型记）', () => {
    const adapterSource = readFileSync(
      resolve(here, '../../src/loomy-adapter.ts'), 'utf8',
    )
    // 适配器侧：声明与调用都带 modelId
    expect(adapterSource).toMatch(/resolveCredential: \(modelId\?: string\)/)
    expect(adapterSource).toContain('this.options.resolveCredential(options.model)')

    // 宿主侧：接住 modelId 并用它过滤限流
    expect(indexSource).toMatch(/resolveCredential: async \(modelId\?: string\)/)
    expect(indexSource).toContain('const key = modelId ?? ')
  })

  it('settings namespace 已注册', () => {
    expect(indexSource).toMatch(/registerProviderSettings\([\s\S]*?'llm-loomy'/)
  })

  it('加入批量续期调度', () => {
    // 只断言「loomy 在续期调度里且真被传了池」：`(pool|p)` 同时接受逐个
    // `await x.refreshAll(pool)` 与表驱动 `(p) => x.refreshAll(p)` 两种写法。
    expect(indexSource).toMatch(/loomy\.refreshAll\((?:pool|p)\)/)
  })

  it('cleanup 调用 loomy.stop()', () => {
    expect(indexSource).toMatch(/loomy\.stop\(\)/)
  })

  it('modelAdapters 里登记了 loomy', () => {
    // ⚠️ 2026-10-06 复审 !66：登记项改为经 `pruned(...)` 包装（否则拿的是原始
    // 实例，「已失效模型」剔除对 Jet Hub 设置页不生效）。断言的是**登记语义**，
    // 故用正则容忍包装层，不要写死字面写法。
    expect(indexSource).toMatch(/const modelAdapters[\s\S]*?loomy: pruned\([^)]*,\s*loomyAdapter\)/)
  })

  it('registerJetHubRpc 传入了 loomy', () => {
    // ⚠️ 断言到 `loomy` 与 `modelAdapters` 之间**不限定**具体参数 ——
    // 每新增一个 provider 都会在这中间插一个实参（raccoon 即如此），
    // 写死 `cline, loomy, modelAdapters` 会让每次新增 provider 都误报失败。
    expect(indexSource).toMatch(/registerJetHubRpc\([\s\S]*?loomy,[\s\S]*?modelAdapters\)/)
  })

  /**
   * ⚠️ 远端模型目录必须用 **token 头**（业务端点），不是 Bearer。
   * 带错会得到 `100002 缺少 token`，表现为「模型列表永远是兜底表」。
   */
  it('fetchRemoteModels 用 token 头请求 /models', () => {
    // ⚠️ 不能用 `indexOf('fetchRemoteModels')` —— 那个字符串在文件里出现 6 次
    // （每个 provider 一次），会命中 CodeArts 的那处。用 Loomy 专属锚点。
    const start = indexSource.indexOf('LOOMY.apiBase}/models')
    expect(start).toBeGreaterThan(-1)
    const body = indexSource.slice(Math.max(0, start - 400), start + 200)
    expect(body).toContain('token: credential.access_token')
    expect(body).toContain('token') // 业务端点用 token 头
  })
})
