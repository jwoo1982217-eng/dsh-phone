/**
 * ModelScope（魔搭）**接线完整性**守卫（2026-10-17 审计新增）。
 *
 * ## 起因：一个真实缺陷，且症状**纯静默**
 *
 * 用户实测：「在模型列表里只开启了 V4.1 Flash，其余 35 个全关」，
 * 但**模型选择器里仍列全部 36 个**。
 *
 * 根因：`ModelscopeAdapter.listModels` 读 `this.options.disabledModels?.()`
 * 做黑名单过滤（`modelscope-adapter.ts` 第 393 行，消费点**一直是对的**），
 * 而 `index.ts` 的 `registerModelscopeLlm(ctx, { … })` **没有传这个回调**
 * ⇒ `?.()` 恒为 `undefined` ⇒ 过滤退化成「不过滤」。
 *
 * ⚠️⚠️ **这正是本仓库反复记录的「漏一处就静默失效」形态**，且它比 accio 那次
 * 更隐蔽 —— accio 是「两处表都要登记」，本条是「**适配器支持该能力、只是接线漏了
 * 实参**」⇒ 类型检查通过、适配器自测全绿、无报错无日志。
 *
 * ## 为什么用「行为级」判据而不是源码文本
 *
 * 本仓库反复记录：源码文本断言对 `if (false)` 短路、死分支字面量等形态有假绿。
 * 故下面第 ① 条**真跑** `ModelscopeAdapter.listModels()` 并喂一个黑名单，
 * 断言被过滤 —— 这条在「接线漏了」时必然变红（真跑路径，不依赖文本）。
 * 第 ② 条才用 AST 级文本判据（因为「某个注册调用的实参里有没有 `disabledModels`」
 * 没有可观测行为，只能查文本），且**必须剥注释**后再判，避免一行注释诱饵。
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ModelscopeAdapter } from '../../src/modelscope-adapter.js'
import { MODELSCOPE, MODELSCOPE_FALLBACK_MODELS } from '../../src/modelscope-product.js'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

describe('★ ModelScope 接线完整性（2026-10-17 审计：黑名单曾完全失效）', () => {
  /**
   * ① 行为级：喂一个黑名单，`listModels` **必须**真的过滤掉它。
   *
   * ⚠️ 这条在「`disabledModels` 未接线」时**真跑**也会变红吗？—— 会，但只有
   * 「消费点仍在」时才红。它锁的是**消费点**（适配器侧），是接线守卫的**必要**
   * 而非充分条件；接线的部分由第 ② 条覆盖。
   */
  it('★ 黑名单里的模型不得出现在 listModels（真实过滤，非恒真）', async () => {
    const fallback = MODELSCOPE_FALLBACK_MODELS[0]
    const second = MODELSCOPE_FALLBACK_MODELS[1]
    expect(second, '兜底表至少要两个模型，本用例才有「过滤掉一个、留下一个」可断言')
      .toBeDefined()

    const disabled = new Set([second.id])
    const adapter = new ModelscopeAdapter({
      slots: async () => [{ id: 'a1', apiKey: 'ms-0123456789abcdefghij' }],
      product: MODELSCOPE,
      // ⚠️ 关键：这里**给**黑名单，若消费点被删掉/改成不过滤，下面会红。
      disabledModels: () => disabled,
      // ⚠️ 不给 `fetchRemoteCatalog` ⇒ 走兜底表（确定性，无网络）。
    } as never)

    const models = await adapter.listModels(MODELSCOPE.id)
    const ids = models.map((m) => m.id)
    expect(ids, '兜底表里没有被过滤的模型 ⇒ 断言恒真').toContain(fallback.id)
    expect(ids, '黑名单里的模型没有出现在 listModels ⇒ 黑名单过滤失效')
      .not.toContain(second.id)
  })

  /**
   * ② AST 级：`index.ts` 的 `registerModelscopeLlm` 实参里必须有
   *    `disabledModels`。
   *
   * ⚠️ **必须剥掉注释后再判**：否则一行「⚠️ 本该接 `disabledModels`」的注释
   *    就能让这条守卫恒绿（本仓库实测过的诱饵形态）。
   */
  it('★ index.ts 的 modelscope 注册实参里必须带 disabledModels（剥注释后判定）', () => {
    const source = readFileSync(REPO + 'src/index.ts', 'utf8')
    // 剥块注释与行注释（判据自检：剥完后 `disabledModels:` 应只剩「真调用点」）。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n')

    const at = code.indexOf('registerModelscopeLlm(')
    expect(at, 'index.ts 里找不到 registerModelscopeLlm 调用点').toBeGreaterThan(-1)
    // 该调用的实参区间：从 `registerModelscopeLlm(` 到**下一个** `})\n` 收尾。
    const tail = code.slice(at, at + 4000)
    const end = tail.indexOf('\n  })')
    const call = end > 0 ? tail.slice(0, end) : tail

    expect(call, '★ registerModelscopeLlm 的实参里没有 disabledModels ⇒ 模型黑名单完全失效（实测：关闭的模型仍出现在模型选择器里）')
      .toMatch(/disabledModels:\s*\(\)\s*=>\s*pool\.disabledModelsFor\(/)
    // 反向自检：整份代码里 `disabledModels` 的出现次数应 ≥ 3
    // （modelscope + officeace + opencode）。若为 0 说明上面的正则被写坏了。
    const occurrences = (code.match(/disabledModels/g) ?? []).length
    expect(occurrences, 'disabledModels 在剥注释后的代码里几乎不出现 —— 判据本身可能失效')
      .toBeGreaterThanOrEqual(3)
  })

  /**
   * ③ 守卫自检：把消费点短掉，第 ① 条**必须**变红。
   *
   * ⚠️ 这是「守卫有没有牙」的自检。做法：造一个**不带**黑名单回调的适配器，
   * 断言它**仍会**列出第二个模型（即不过滤）⇒ 证明第 ① 条的变红确实来自
   * 过滤生效，而不是别的巧合。
   */
  it('★ 判据自检：不传 disabledModels 时不过滤（第 ① 条的红因此有来源）', async () => {
    const second = MODELSCOPE_FALLBACK_MODELS[1]
    const adapter = new ModelscopeAdapter({
      slots: async () => [{ id: 'a1', apiKey: 'ms-0123456789abcdefghij' }],
      product: MODELSCOPE,
      // ⚠️ 刻意**不传** disabledModels
    } as never)
    const ids = (await adapter.listModels(MODELSCOPE.id)).map((m) => m.id)
    expect(ids, '不给黑名单回调时应列出全部兜底模型 —— 否则第 ① 条的「红」来源可疑')
      .toContain(second.id)
  })
})