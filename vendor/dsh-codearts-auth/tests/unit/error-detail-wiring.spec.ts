import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * ★ `errorDetail` 的 `detail` 腿必须**逐处**接线（Issue IKLBSH A1）。
 *
 * ## 为什么需要这条守卫（独立审计实测的真实缺口）
 *
 * 本仓库有 **6 份**同义的 `errorDetail`（`openai-compat` / `llm-adapter` /
 * `buddy-adapter` / `lobsterai-adapter` / `trae-adapter` / `accio-adapter`）。
 * 我修 A1 时给 6 处都接了 `detailFieldText`，但**只有 `llm-adapter` 那 1 处有
 * 行为守卫**（它的 4 条用例）。
 *
 * 对抗性审计实测：把 `detailFieldText` 改成恒 `undefined`，全量测试**只红 3 条**，
 * 且全部落在 `llm-adapter.spec.ts` ⇒ **其余 5 处接线零覆盖**（改坏不红）。
 *
 * 这正是本仓库点名的复发形态：**「接线了一处」≠「这处有守卫」** ——
 * 与 `provider-abstraction-g3-exceptions.md` 记的「登记了一处例外 ≠ 这处例外有
 * 守卫（当时实测出 G3-4 零守卫）」同型。
 *
 * ## 判据为什么用「计数」而不是逐文件断言
 *
 * 逐文件的 `expect(源码).toMatch(...)` 在**新增第 7 份 `errorDetail`** 时会静默
 * 漏掉（新文件不在清单里）。故这里用**扫描 + 计数**：
 * 遍历 `src/` 下所有 `.ts`，找出每份 `errorDetail` 的函数体，
 * 断言①**份数恰好是 6**（新增/删除会红）、②**每一份都调了 `detailFieldText`**。
 * 这样「漏接一处」与「新增一份没接」都会被抓住。
 *
 * ⚠️ 与既有教训一致：并列断言必须用**计数**，源码级断言必须**锚定片段**
 *（本文件同时用两者）。
 */
describe('★ errorDetail 的 detail 腿必须逐处接线（Issue IKLBSH A1 审计）', () => {
  const SRC_DIR = resolve(here, '../../src')

  /**
   * 抽出每一份 `errorDetail` 的**实现体**。
   *
   * ⚠️ 两条出口（`errorDetail` / `errorDetailForClassify`）**共用** `errorDetailImpl`
   * 的实现 —— 故对那两个文件，要抽的是 `errorDetailImpl` 而非 `errorDetail`
   * （`errorDetail` 只是一行转发）。本函数同时认这两个名字，取**包含
   * `detailFieldText(` 或 `includeDetailField` 判据**的那个体。
   */
  function extractBodies(source) {
    const bodies = []
    // 先找 `errorDetailImpl`（两出口共用），找不到再退回 `errorDetail`。
    const names = ['errorDetailImpl', 'errorDetail']
    for (const name of names) {
      const re = new RegExp(`function ${name}\\(`, 'g')
      let m
      while ((m = re.exec(source)) !== null) {
        const start = m.index
        const open = source.indexOf('{', start)
        if (open < 0) continue
        let depth = 0
        let i = open
        for (; i < source.length; i += 1) {
          const ch = source[i]
          if (ch === '{') depth += 1
          else if (ch === '}') {
            depth -= 1
            if (depth === 0) break
          }
        }
        bodies.push({ start, name, body: source.slice(open, i + 1) })
      }
      // `errorDetailImpl` 存在时不再看 `errorDetail`（后者只是一行转发，没有腿）。
      if (bodies.length > 0 && name === 'errorDetailImpl') break
    }
    return bodies
  }

  it('★ src/ 下恰好有 6 份 errorDetail（新增一份会红，提醒同步接线）', async () => {
    const fs = await import('node:fs/promises')
    const files = (await fs.readdir(SRC_DIR, { recursive: true }))
      .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
    let total = 0
    const where = []
    for (const file of files) {
      const source = await fs.readFile(resolve(SRC_DIR, file), 'utf8')
      const bodies = extractBodies(source)
      if (bodies.length > 0) {
        total += bodies.length
        where.push(`${file}×${bodies.length}`)
      }
    }
    // ⚠️ 计数是**刻意的**：本仓库 6 份同义实现是「同一语义多套判据」的既成事实，
    // 数量变化意味着又有人复制第七份（或删了一份）—— 两者都要人来看一眼。
    expect(total, `实际分布：${where.join(', ')}`).toBe(6)
  })

  it('★★ 每一份 errorDetail 都必须接 detailFieldText（漏一处即红）', async () => {
    const fs = await import('node:fs/promises')
    const files = (await fs.readdir(SRC_DIR, { recursive: true }))
      .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
    const missing = []
    let checked = 0
    for (const file of files) {
      const source = await fs.readFile(resolve(SRC_DIR, file), 'utf8')
      for (const { body } of extractBodies(source)) {
        checked += 1
        if (!body.includes('detailFieldText(')) missing.push(file)
      }
    }
    expect(checked, '应恰好检查 6 份（与上一条同源）').toBe(6)
    // ⚠️ 这条断言是本次审计的**核心产出**：改坏任何一处接线都会红。
    expect(missing, '这些 errorDetail 没接 detailFieldText（A1 的 detail 腿漏了）').toEqual([])
  })

  it('回归守卫：detailFieldText 只允许有**一份**实现（不得各写各的）', async () => {
    const fs = await import('node:fs/promises')
    const files = (await fs.readdir(SRC_DIR, { recursive: true }))
      .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
    const definers = []
    const callers = []
    for (const file of files) {
      const source = await fs.readFile(resolve(SRC_DIR, file), 'utf8')
      if (/export function detailFieldText\(/.test(source)) definers.push(file)
      else if (source.includes('detailFieldText(')) callers.push(file)
    }
    // ⚠️ 「一文件两套同义判据」是本仓库首条红线：这条腿**只留一份实现**，
    // 其余 5 份必须 import 它。各写一份会在上游改报文形态时分别漂移。
    expect(definers, 'detailFieldText 的实现只允许有一份').toEqual(['openai-compat.ts'])
    // 5 份 import 它（6 份 errorDetail 减去 openai-compat 自己那份）。
    expect(callers.length).toBe(5)
  })

  /**
   * ★★ **展示出口与分类出口必须分开**（真实净回归，两轮审计独立确证）。
   *
   * `detail` 腿会**加长分类判据的输入** ⇒ 可能翻转错误码（实测：
   * `{"message":"bad request","detail":"out of credits"}` 从 `INVALID_REQUEST`
   * 变成 `QUOTA_EXCEEDED`；detail 含超限措辞时变成 `CONTEXT_WINDOW_EXCEEDED`，
   * 后者还会触发 DSH 的溢出压缩）。
   *
   * ⇒ `errorDetail`（展示，含 detail）／`errorDetailForClassify`（分类，不含）
   * 两条出口。**分类调用点只允许走后者** —— 本用例把它变成结构性判据：
   * 任何人把分类点换回展示出口都会红（不依赖具体报文，故没有"选例偏差"）。
   *
   * ⚠️ 这条正是补上审计指出的**零守卫缺口**：我原本只有 3 条「返回值断言」，
   * 没有一条锁分类 ⇒ 换回展示出口时全量测试**一条都不红**（实测）。
   */
  it('★★ 分类调用点不得用展示出口 errorDetail（只允许 errorDetailForClassify）', async () => {
    const fs = await import('node:fs/promises')
    // 只有 `llm-adapter.ts` 存在分类消费者（`httpErrorCode` + 4xx 额度判据）。
    // ⚠️ 其余适配器的 `httpErrorCode` **刻意收原始 body**（buddy 的注释写明理由：
    // `errorDetail` 会丢掉 `extError`），故不受此约束 —— 但若将来有人新增了
    // 「把 errorDetail 产物喂进分类判据」的写法，本用例必须能抓到。
    const files = (await fs.readdir(SRC_DIR, { recursive: true }))
      .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
    const offenders = []
    for (const file of files) {
      const source = await fs.readFile(resolve(SRC_DIR, file), 'utf8')
      // 剥注释后扫**分类语境**里的 `errorDetail(` 调用（两类：`httpErrorCode` 的实参、
      // 以及 `isXxxError(errorDetail(...))` / `classifyXxx(errorDetail(...))` 形态）。
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      for (const m of code.matchAll(/(?:isQuotaExceededError|isContextWindowExceededError|isSse[A-Za-z]*|classify[A-Za-z]*|httpErrorCode)\([^)]*errorDetail\(/g)) {
        offenders.push(`${file}: ${m[0].slice(0, 80)}`)
      }
    }
    expect(
      offenders,
      '分类调用点用了展示出口 errorDetail（含 detail 腿）⇒ detail 里的额度/超限措辞会翻转错误码。改用 errorDetailForClassify',
    ).toEqual([])
    // 反向：确认 `llm-adapter.ts` 真的**有**分类调用点（否则本守卫是空集假绿）。
    const adapter = await fs.readFile(resolve(SRC_DIR, 'llm-adapter.ts'), 'utf8')
    expect(adapter, 'llm-adapter.ts 应当有 errorDetailForClassify 的分类调用点')
      .toMatch(/httpErrorCode\([\s\S]{0,60}errorDetailForClassify|errorDetailForClassify\(body\)/)
  })

  it('对照：openai-compat 自己的 errorDetail 也在 6 份之内（不是第 7 份）', () => {
    // 上一条断言 definers 只有 openai-compat ⇒ 它自己那份 errorDetail 也算在内。
    // 这条只是把该事实写成可读断言，防止有人把「定义处」从计数里排除。
    const source = readFileSync(resolve(SRC_DIR, 'openai-compat.ts'), 'utf8')
    expect(source).toMatch(/export function errorDetail\(/)
    expect(extractBodies(source).length).toBe(1)
    expect(extractBodies(source)[0].body).toContain('detailFieldText(')
  })
})
