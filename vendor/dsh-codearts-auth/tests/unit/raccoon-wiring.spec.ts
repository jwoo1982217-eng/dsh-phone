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
describe('Raccoon 在 index.ts 的接线', () => {
  it('导入并实例化 RaccoonAuth', () => {
    expect(indexSource).toContain("from './raccoon-auth.js'")
    expect(indexSource).toContain('new RaccoonAuth(ctx)')
  })

  it('注册 Raccoon 适配器并接收返回值', () => {
    expect(indexSource).toContain("from './raccoon-adapter.js'")
    expect(indexSource).toContain('registerRaccoonLlm(ctx,')
    expect(indexSource).toMatch(/const raccoonAdapter = registerRaccoonLlm/)
  })

  it('provider 解析用 RACCOON.id（不写死字面量）', () => {
    expect(indexSource).toContain("pool.getAvailableAccount(RACCOON.id, '')")
  })

  it('refresh 走 refreshAccountCredential（刷新解析凭据所用的那个账号）', () => {
    expect(indexSource).toMatch(/raccoon\.refreshAccountCredential\(/)
    expect(indexSource).toMatch(/available\.entry\.credentialRef/)
  })

  /**
   * ⚠️ **真实缺陷回归**（用户报障）：「凭据过期后显示过期，但是似乎是续期
   * 成功了还是没有真正的过期，我发送会话成功从 6300 扣分了。」
   *
   * 根因：续期成功后没把新的 `expiresAt` 写回账号池，而 Jet Hub UI 读的
   * 正是账号池。实测该账号 JWT `exp` 已是 15:09（有效）、账号池却是
   * 12:02（已过期），**相差 3.1 小时**。
   *
   * 判据：`index.ts` 的续期路径必须把 `pool` 与 `entry.id` 传下去，
   * 否则 `syncAccountExpiry` 无从回写。
   */
  it('⚠️ 续期调用必须传 pool 与 accountId（否则 UI 假过期）', () => {
    // 适配器的 refresh 回调 = 「发消息时按需续期」，最常触发的路径
    expect(
      indexSource,
      '适配器 refresh 回调必须传 pool + entry.id，否则账号池的 expiresAt 不会更新',
    ).toMatch(
      /refreshAccountCredential\(\s*available\.entry\.credentialRef,\s*pool,\s*available\.entry\.id,?\s*\)/,
    )
  })

  it('settings namespace 已注册', () => {
    expect(indexSource).toMatch(/registerProviderSettings\([\s\S]*?'llm-raccoon'/)
  })

  it('加入批量续期调度', () => {
    // `(pool|p)`：逐个 await 与表驱动两种写法都接受，避免重构调度器时假失败。
    expect(indexSource).toMatch(/raccoon\.refreshAll\((?:pool|p)\)/)
  })

  it('modelAdapters 里登记了 raccoon', () => {
    // ⚠️ 2026-10-06 复审 !66：登记项经 `pruned(...)` 包装（否则 Jet Hub 拿到原始
    // 实例、「已失效模型」剔除对设置页不生效）。
    expect(indexSource).toMatch(/const modelAdapters[\s\S]*?raccoon: pruned\([^)]*,\s*raccoonAdapter\)/)
  })

  it('registerJetHubRpc 传入了 raccoon', () => {
    // ⚠️ 不限定 raccoon 与 modelAdapters 之间的具体实参：将来新增 provider
    // 会在此处插入新参数，写死顺序会让每次扩展都误报失败。
    expect(indexSource).toMatch(/registerJetHubRpc\([\s\S]*?raccoon,[\s\S]*?modelAdapters\)/)
  })

  it('fetchRemoteModels 委托给 RaccoonAuth.fetchModels', () => {
    const start = indexSource.indexOf('fetchRemoteModels: () => raccoon.fetchModels')
    expect(start).toBeGreaterThan(-1)
  })

  it('凭据类型标注为 RaccoonCredential（不是 any）', () => {
    expect(indexSource).toContain("from './raccoon.js'")
    expect(indexSource).toMatch(/RaccoonCredential/)
  })
})
