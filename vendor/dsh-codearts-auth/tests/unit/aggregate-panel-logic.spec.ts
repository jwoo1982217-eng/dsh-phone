import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  candidateRowLabel,
  expiryLabel,
  isAllCandidatesRejected,
  isRejected,
  rejectionsFromCatalog,
  rejectionKey,
  sortCandidatesByExpiry,
  sortModelsForPanel,
  toggleRejection,
} from '../../plugin-src/client/aggregate-panel-logic.js'

/** 仓库根（源码级断言用）。 */
const here = fileURLToPath(new URL('.', import.meta.url))

/** 造一个候选（照 `aggregate.catalog` 的响应形状）。 */
function candidate(provider, realId, extra = {}) {
  return {
    provider,
    realId,
    realName: `${provider} ${realId}`,
    price: 1,
    viaPatch: false,
    rejected: false,
    ...extra,
  }
}

/** 造一个虚拟模型。 */
function model(canonicalId, name, candidates) {
  return { canonicalId, name, candidates }
}

describe('sortModelsForPanel：全局按候选渠道数降序（**不分组**）', () => {
  // ⚠️ 用户 2026-10-07 明确要求**去掉厂商分组标题**：
  //    「聚合模型中显示 8 个聚合模型下面不需要再显示渠道了，因为渠道在每个模型的
  //      展开展示参与轮换的子列表中显示了」
  //    ⇒ 面板不再显示「华为云 (2) / 腾讯 (5)」这类分组标题，模型直接平铺。
  //    厂商信息仍可在每个模型展开后的子列表里逐条看到（那是渠道维度的信息）。
  //
  // ⚠️ 随之**删除了 `vendorOf` / `groupByVendor`**：去掉分组后它们**零调用者**，
  //    而本仓库对死代码有明确红线（第 2 轮审计正是把 `AGGREGATE_TTL_MS` 死配置
  //    列为 Important 缺陷）。需要时 git 历史里可找回。
  it('★ 按候选渠道数降序（渠道多的在前 —— 冗余度高、最不容易挂）', () => {
    const sorted = sortModelsForPanel([
      model('few', 'Few', [candidate('buddy', 'x')]),
      model('many', 'Many', [
        candidate('buddy', 'x'), candidate('workbuddy', 'y'), candidate('buddy', 'z'),
      ]),
      model('mid', 'Mid', [candidate('buddy', 'x'), candidate('workbuddy', 'y')]),
    ])
    expect(sorted.map((m) => m.canonicalId)).toEqual(['many', 'mid', 'few'])
  })

  it('★ 跨厂商也一起排（不因厂商不同而分段 —— 这正是去掉分组后的行为差异）', () => {
    // ⚠️ 旧实现（`groupByVendor`）会先按厂商分段，于是「华为云 6 个候选」可能排在
    //    「腾讯 2 个候选」**后面**（厂商名升序）。去掉分组后应**全局**降序。
    const sorted = sortModelsForPanel([
      model('tencent-two', 'T2', [candidate('buddy', 'x'), candidate('workbuddy', 'y')]),
      model('huawei-six', 'H6', [
        candidate('codearts', 'a'), candidate('codearts', 'b'), candidate('codearts', 'c'),
        candidate('codearts', 'd'), candidate('codearts', 'e'), candidate('codearts', 'f'),
      ]),
    ])
    expect(sorted.map((m) => m.canonicalId)).toEqual(['huawei-six', 'tencent-two'])
  })

  it('候选数相同时按 canonicalId 升序（结果稳定，便于断言与面板顺序稳定）', () => {
    const sorted = sortModelsForPanel([
      model('zebra', 'Z', [candidate('buddy', 'x')]),
      model('alpha', 'A', [candidate('buddy', 'y')]),
    ])
    expect(sorted.map((m) => m.canonicalId)).toEqual(['alpha', 'zebra'])
  })

  it('★ 纯函数：不得改动入参（React 依赖引用变化重渲染）', () => {
    const input = [
      model('few', 'Few', [candidate('buddy', 'x')]),
      model('many', 'Many', [candidate('buddy', 'x'), candidate('buddy', 'y')]),
    ]
    const before = input.map((m) => m.canonicalId)
    sortModelsForPanel(input)
    expect(input.map((m) => m.canonicalId)).toEqual(before)
  })

  it('空输入 ⇒ 空数组（不抛错）', () => {
    expect(sortModelsForPanel([])).toEqual([])
    expect(sortModelsForPanel(undefined)).toEqual([])
    expect(sortModelsForPanel(null)).toEqual([])
  })

  it('候选为空的模型不丢（仍列出，排在最后）', () => {
    // ⚠️ 一个虚拟模型的候选可能全被过滤（理论上不该发生，但面板不该因此静默吞掉它）。
    const sorted = sortModelsForPanel([
      model('empty', 'Empty', []),
      model('one', 'One', [candidate('buddy', 'x')]),
    ])
    expect(sorted.map((m) => m.canonicalId)).toEqual(['one', 'empty'])
  })
})

describe('candidateRowLabel：候选行的展示文案', () => {
  it('含渠道与真实 modelId', () => {
    const label = candidateRowLabel(candidate('buddy', 'deepseek-v4.1-flash'))
    expect(label).toContain('buddy')
    expect(label).toContain('deepseek-v4.1-flash')
  })

  it('倍率为有限数时显示（x0.15）', () => {
    const label = candidateRowLabel(candidate('buddy', 'm', { price: 0.15 }))
    expect(label).toContain('x0.15')
  })

  it('倍率为 Infinity（无标注）时不显示倍率，而不是显示 Infinity', () => {
    // ⚠️ 直接把 Infinity 拼进文案会让用户看到「xInfinity」—— 那是明显的渲染缺陷。
    const label = candidateRowLabel(candidate('buddy', 'm', { price: Number.POSITIVE_INFINITY }))
    expect(label).not.toContain('Infinity')
    expect(label).toContain('buddy')
  })

  it('倍率为 0 时显示「免费」（本仓库既有口径）', () => {
    expect(candidateRowLabel(candidate('buddy', 'm', { price: 0 }))).toContain('免费')
  })

  it('补丁来源标 ⚠️补丁（规格 §7.1 要求人工核查的重点）', () => {
    const label = candidateRowLabel(candidate('lobsterai', 'm', { viaPatch: true }))
    expect(label).toContain('补丁')
  })

  it('非补丁来源不标补丁', () => {
    expect(candidateRowLabel(candidate('buddy', 'm'))).not.toContain('补丁')
  })

  it('畸形入参不抛错（面板渲染不能因一条坏数据整体崩掉）', () => {
    expect(() => candidateRowLabel(undefined)).not.toThrow()
    expect(() => candidateRowLabel({})).not.toThrow()
    expect(typeof candidateRowLabel(undefined)).toBe('string')
  })
})

describe('rejectionKey / isRejected：拒绝状态的读写判据', () => {
  it('rejectionKey 用 NUL 分隔（渠道 id 与 realId 里可能含斜杠）', () => {
    // ⚠️ 用 `:` 或 `/` 会把 `a/b`+`c` 与 `a`+`b/c` 拼成同一个键 ⇒ 误判。
    const k1 = rejectionKey('m', 'a/b', 'c')
    const k2 = rejectionKey('m', 'a', 'b/c')
    expect(k1).not.toBe(k2)
  })

  it('isRejected：命中返回 true', () => {
    const table = { m: { buddy: { x: true } } }
    expect(isRejected(table, 'm', 'buddy', 'x')).toBe(true)
  })

  it('isRejected：缺层一律返回 false（不抛错）', () => {
    expect(isRejected({}, 'm', 'buddy', 'x')).toBe(false)
    expect(isRejected(undefined, 'm', 'buddy', 'x')).toBe(false)
    expect(isRejected({ m: {} }, 'm', 'buddy', 'x')).toBe(false)
    expect(isRejected({ m: { buddy: {} } }, 'm', 'buddy', 'x')).toBe(false)
  })

  it('isRejected：非 true 的值不算拒绝（与宿主 sanitize 同口径）', () => {
    expect(isRejected({ m: { buddy: { x: false } } }, 'm', 'buddy', 'x')).toBe(false)
    expect(isRejected({ m: { buddy: { x: 1 } } }, 'm', 'buddy', 'x')).toBe(false)
  })
})

describe('toggleRejection：纯函数地改拒绝表', () => {
  it('打开拒绝 ⇒ 写入 true', () => {
    const next = toggleRejection({}, 'm', 'buddy', 'x', true)
    expect(next).toEqual({ m: { buddy: { x: true } } })
  })

  it('关闭拒绝 ⇒ 删除键并逐级清理空层（不留 false 噪音）', () => {
    const next = toggleRejection({ m: { buddy: { x: true } } }, 'm', 'buddy', 'x', false)
    expect(next).toEqual({})
  })

  it('关闭其中一条时保留同层的其它条', () => {
    const next = toggleRejection(
      { m: { buddy: { x: true, y: true } } },
      'm', 'buddy', 'x', false,
    )
    expect(next).toEqual({ m: { buddy: { y: true } } })
  })

  it('★ 纯函数：不得改动入参', () => {
    // ⚠️ 面板用 React 状态驱动，原地改会让「新旧引用相同」⇒ 组件不重渲染
    //    ⇒ 用户点了开关但界面不变（最典型的一类 UI 缺陷）。
    const before = { m: { buddy: { x: true } } }
    const snapshot = JSON.stringify(before)
    toggleRejection(before, 'm', 'buddy', 'y', true)
    toggleRejection(before, 'm', 'buddy', 'x', false)
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('★ 纯函数：返回值与入参不是同一个引用（React 靠引用变化重渲染）', () => {
    const before = {}
    const next = toggleRejection(before, 'm', 'buddy', 'x', true)
    expect(next).not.toBe(before)
  })

  it('畸形入参退化为空表后正常写入', () => {
    expect(toggleRejection(undefined, 'm', 'buddy', 'x', true)).toEqual({ m: { buddy: { x: true } } })
    expect(toggleRejection([], 'm', 'buddy', 'x', true)).toEqual({ m: { buddy: { x: true } } })
  })
})

describe('★ 客户端 RPC 调用必须显式传 payload（真实缺陷回归）', () => {
  it('不得出现省略 payload 的 rpcCall("x.y") 写法', async () => {
    // ⚠️ **真实缺陷**（用户报障「读取聚合目录失败：Error: Invalid Jet Hub management
    //    request.」）：`callManagementRpc` 把 payload 序列化进请求体，而**后端校验
    //    要求 payload 键存在**（`src/jet-hub-rpc.ts` 的
    //    `Object.prototype.hasOwnProperty.call(call, 'payload')`）；省略 payload
    //    时它被序列化成 undefined 并**被 JSON 丢弃** ⇒ 后端判为非法请求。
    //
    //    这个坑在本文件之外早有记录（`backup.export` 的调用处有成文注释），
    //    而我在写聚合面板时**又踩了一次**（`rpcCall('aggregate.catalog')`）。
    //    ⇒ 加一条**全客户端扫描**的源码守卫：今后任何人漏传都会在测试里立刻暴露，
    //    而不是等用户报「Invalid Jet Hub management request.」。
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const clientDir = path.resolve(dir, '../../plugin-src/client')
    const files = (await fs.readdir(clientDir)).filter((f) => f.endsWith('.js'))
    expect(files.length).toBeGreaterThan(10)

    const offenders: string[] = []
    for (const file of files) {
      const source = await fs.readFile(path.join(clientDir, file), 'utf8')
      // 只匹配**单个实参**的调用：`rpcCall('a.b')`（合法写法都带第二参）。
      // ⚠️ 剥离注释再扫，避免把说明文字里的示例当成违规（本文件的注释里就有示例）。
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const m of code.matchAll(/rpcCall\(\s*'([a-z]+\.[a-zA-Z]+)'\s*\)/g)) {
        offenders.push(`${file}: ${m[1]}`)
      }
    }
    expect(offenders, '这些 RPC 调用省略了 payload，后端会回 Invalid Jet Hub management request.').toEqual([])
  })
})

describe('★ 聚合面板必须按 rpcCall 的真实契约消费返回值（真实缺陷回归）', () => {
  it('AggregatePanel 内不得出现 res.ok / res.error 判断（契约是「解包 + 抛错」）', async () => {
    // ⚠️ **真实缺陷**（用户第二次报障：面板显示「读取聚合目录失败」且**丢掉真实原因**）：
    //    `plugin-src/client/index.js` 的 rpcCall =
    //      `unwrapRpcResult(callManagementRpc(...))`
    //    而 `unwrapRpcResult`（`management-rpc.mjs`）的契约是：
    //      「如果 ok=true 返回 value，否则抛出 error」
    //    ⇒ 成功时 `res` 是**解包后的值**（如 `{ models }`），**没有** `ok` 字段；
    //      失败时**直接抛错**、根本不返回。
    //    ⇒ 写 `res?.ok === true` 判断永远为假 ⇒ 走 else 分支显示兜底文案，
    //      而 `res.error.message` 也是 undefined ⇒ **真实原因被丢掉**。
    //
    // ⚠️ 不能全仓禁 `res.ok`：`account.test` 端点返回的**值本身**含 `ok`
    //    （那是业务语义的「测试是否通过」，不是 RPC 信封）—— 全仓禁会误伤它。
    //    故本守卫**只扫 AggregatePanel 组件体**。
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const source = await fs.readFile(path.resolve(dir, '../../plugin-src/client/jet-hub.js'), 'utf8')
    const start = source.indexOf('function AggregatePanel(')
    expect(start, 'AggregatePanel 必须存在').toBeGreaterThan(0)
    // 组件体：从函数头到下一个顶层 `export function`
    const end = source.indexOf('\nexport function ', start)
    const body = source.slice(start, end > 0 ? end : undefined)
    // 剥离注释（本组件的注释里**故意**引用了 `res.ok` 来说明它是错的）。
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code, 'AggregatePanel 不得判断 res.ok（rpcCall 已解包，成功时没有 ok 字段）')
      .not.toMatch(/res\?\.ok|res\.ok/)
    expect(code, 'AggregatePanel 不得读 res.error（失败时 rpcCall 抛错，不返回）')
      .not.toMatch(/res\?\.error|res\.error/)
    expect(code, 'AggregatePanel 不得读 res.value（成功时已解包）')
      .not.toMatch(/res\?\.value|res\.value/)
  })

  it('★ 对照：account.test 的 res.ok 是业务字段，必须**保留**（守卫不得误伤）', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const source = await fs.readFile(path.resolve(dir, '../../plugin-src/client/jet-hub.js'), 'utf8')
    // `summarizeTest` 读的是 `account.test` 返回的**值**里的 ok —— 那是业务语义。
    expect(source).toMatch(/function summarizeTest\(res\)/)
    expect(source).toMatch(/if \(res\?\.ok\) return/)
  })
})

/**
 * ★ 面板的「按临期排序」（用户 2026-10-07 选定方案 C）。
 *
 * ## 背景：面板标题写「临期优先」，但候选列表是**渠道名字母序**
 *
 * 用户报障：「codearts 的 4.1 flash 没有显示在最后」—— 核实发现面板候选顺序来自
 * `aggregate-catalog.ts` 的 `candidates.sort(...)`，那是按 `provider` **字母序**
 * （`buddy → codearts → workbuddy`），**与临期顺序无关**。
 * ⇒ 标题与列表**矛盾**（面板没说真话）。
 *
 * ## 为什么不默认按临期排
 *
 * 临期顺序需要**逐候选探测余额**（真实上游 GET）。而规格 §8.3 明确要求
 * `aggregate.catalog` **零余额查询** —— 否则面板一打开就打十几次上游请求。
 * ⇒ 默认仍是字母序（零探测），用户**显式点「按临期排序」**才探测并重排。
 */
describe('★ 面板「按临期排序」（零探测为默认，点了才探测）', () => {
  it('★ 按临期升序（最早到期的排最前）；未接入/无到期的排最后', () => {
    const rows = [
      { provider: 'workbuddy', expiry: Number.POSITIVE_INFINITY },
      { provider: 'buddy', expiry: 3_000 },
      { provider: 'codearts', expiry: 1_000 },
    ]
    expect(sortCandidatesByExpiry(rows).map((r) => r.provider)).toEqual([
      'codearts', 'buddy', 'workbuddy',
    ])
  })

  it('★ 到期时刻相同时按渠道名升序（结果稳定）', () => {
    const rows = [
      { provider: 'trae', expiry: 5_000 },
      { provider: 'buddy', expiry: 5_000 },
    ]
    expect(sortCandidatesByExpiry(rows).map((r) => r.provider)).toEqual(['buddy', 'trae'])
  })

  it('★ 纯函数：不得改动入参', () => {
    const rows = [
      { provider: 'b', expiry: 2 },
      { provider: 'a', expiry: 1 },
    ]
    const before = rows.map((r) => r.provider)
    sortCandidatesByExpiry(rows)
    expect(rows.map((r) => r.provider)).toEqual(before)
  })

  it('★ 畸形入参不抛错（缺 expiry / 非数组）', () => {
    expect(sortCandidatesByExpiry(undefined)).toEqual([])
    expect(sortCandidatesByExpiry(null)).toEqual([])
    expect(sortCandidatesByExpiry([{ provider: 'a' }, { provider: 'b', expiry: 1 }])
      .map((r) => r.provider)).toEqual(['b', 'a'])
  })
})

describe('★ expiryLabel：到期时刻的可读文案', () => {
  const now = 1_800_000_000_000

  it('★ -1（查不到）与 Infinity（长期）必须**区分**', () => {
    // ⚠️ 查不到 ≠ 已过期：与 `zcodeExpiry` 的「undefined 表示查不到，不是没有余额」
    //    同一原则。把两者都说成「已过期」会让用户去重新登录一个其实好的账号。
    expect(expiryLabel(-1, now)).toBe('查不到')
    expect(expiryLabel(Number.POSITIVE_INFINITY, now)).toBe('长期')
  })

  it('★ 相对时间（分钟 / 小时 / 天）', () => {
    expect(expiryLabel(now + 30 * 60_000, now)).toBe('30 分钟')
    expect(expiryLabel(now + 5 * 3_600_000, now)).toBe('5 小时')
    expect(expiryLabel(now + 3 * 86_400_000, now)).toBe('3 天')
  })

  it('★ 边界：不到 1 分钟 / 已过期', () => {
    expect(expiryLabel(now + 30_000, now)).toBe('不到 1 分钟')
    expect(expiryLabel(now, now)).toBe('已过期')
    expect(expiryLabel(now - 1000, now)).toBe('已过期')
  })

  it('★ 畸形入参不抛错（面板不能因一条坏数据整体崩掉）', () => {
    expect(expiryLabel(undefined, now)).toBe('?')
    expect(expiryLabel(NaN, now)).toBe('?')
    expect(expiryLabel('x', now)).toBe('?')
    expect(expiryLabel(0, now)).toBe('?')
  })
})

describe('★ 面板接线：默认零探测，点了才探测（防「面板没说真话」）', () => {
  const read = (rel) => readFileSync(resolve(here, '../..', rel), 'utf8')
  const codeOf = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  const panel = read('plugin-src/client/jet-hub.js')
  const panelCode = codeOf(panel)

  it('★ 必须有「按临期排序」按钮（用户 2026-10-07 选定方案 C）', () => {
    expect(panelCode).toContain('按临期排序')
  })

  it('★ 默认**不得**在挂载时探测（规格 §8.3 的零余额查询契约）', () => {
    // ⚠️ 探测必须只在**用户点击**的处理器里发生。若挂在 effect 或直接调用，
    //    面板一打开就会对每个渠道打一次上游请求 —— 正是规格 §8.3 禁止的。
    // 判据：`aggregate.expiryOrder` 只应出现在 `onSortByExpiry` 里。
    const matches = [...panelCode.matchAll(/aggregate\.expiryOrder/g)]
    expect(matches).toHaveLength(1)
    // 且它前面不远处必须是 onSortByExpiry 的定义（而不是 effect）
    const at = panelCode.indexOf('aggregate.expiryOrder')
    const before = panelCode.slice(Math.max(0, at - 600), at)
    expect(before, 'expiryOrder 的调用必须在 onSortByExpiry 里').toContain('onSortByExpiry')
    expect(before, '不得出现在 useEffect 里').not.toMatch(/useEffect\(/)
  })

  it('★ 候选顺序：探测过才按临期排，否则保持目录顺序', () => {
    expect(panelCode).toContain('sortCandidatesByExpiry')
    // ⚠️ 必须有「未探测时用原顺序」的分支，否则面板一打开就按 undefined 排序
    //   （所有 expiry 都是 Infinity ⇒ 退化成按渠道名，看不出问题但语义是错的）。
    expect(panelCode).toMatch(/expiryOrder === null/)
  })

  it('★ 措辞必须与实际顺序一致（不再恒写「临期优先」）', () => {
    // ⚠️ 原先恒写「临期优先」而实际是**字母序** —— 用户报障的正是这个矛盾。
    expect(panelCode, '未探测时不得声称按临期').toContain('按渠道名')
    expect(panelCode).toContain('按临期')
  })

  it('★ 空态提示的渠道清单必须含 lobsterai / trae（已接入）', () => {
    // ⚠️ 白名单扩大后清单也要跟 —— 否则提示会漏掉两个真的可用的渠道。
    const at = panelCode.indexOf('当前没有可聚合的模型')
    expect(at, '必须存在该空态提示').toBeGreaterThan(0)
    // ⚠️ **不要用魔数窗口**（真实脆弱点，审计实测指出）：原实现是
    //    `panelCode.slice(at, at + 300)`，而 `lobsterai` 落在偏移 90、`trae` 在 102
    //    ⇒ 文案一变长（余量 <60 字符）就会**假失败**。
    //
    // ⚠️ 我第一版改成「到下一个 `React.createElement` 或 `</p>`」——**仍然过宽**：
    //    该文案是**跨两行的字符串拼接**（`'…渠道'` + `'（…）登录账号。'`），而
    //    `React.createElement` 在它**之前** ⇒ 边界取负、窗口退化成 1200 字符，
    //    于是「去掉提示里的 trae」这个变异**不会变红**（`trae` 在文件里出现 22 次，
    //    窗口外的命中把断言喂饱了）——反向验证实测发现了这一点。
    // ⇒ 改为**精确到该文案的结尾**（`登录账号。` 那句），窗口正好覆盖整段清单。
    const rest = panelCode.slice(at)
    const end = rest.indexOf('登录账号。')
    const snippet = end > 0 ? rest.slice(0, end + '登录账号。'.length) : rest.slice(0, 400)
    expect(snippet, '窗口必须精确覆盖该提示（否则断言会被窗口外的文本喂饱）')
      .toContain('当前没有可聚合的模型')
    expect(snippet).toContain('lobsterai')
    expect(snippet).toContain('trae')
  })
})

describe('★ 面板必须回填宿主返回的拒绝状态（真实缺陷，对抗审计实测证伪）', () => {
  const read = (rel) => readFileSync(resolve(here, '../..', rel), 'utf8')
  const codeOf = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  const panelCode = codeOf(read('plugin-src/client/jet-hub.js'))

  /**
   * ⚠️⚠️ **真实缺陷**（对抗审计探针实测）：宿主在 `aggregate.catalog` 的每个候选上
   * 返回 `rejected: boolean`（`src/aggregate-adapter.ts:343`、`src/types.ts:933`），
   * 而客户端**从不读它** —— 组件读的是本地 `rejections` 状态，而那个状态的初值是 `{}`
   * 且 `load()` **从不**回填。
   *
   * ⇒ **刷新页面后每条开关都显示「参与轮换」**（即使该候选已被拒绝）；
   * 此时用户点一下，`next = !isRejected({}, …) = true`，发出的是 `rejected: true`…
   * 但若用户本意是「保持拒绝」，他看到的开关是「参与轮换」⇒ 点一下变成「已拒绝」？
   * 不 —— 关键在**用户以为自己没拒绝过**，于是不会去点；而**一旦点到**，发出的
   * 语义与界面显示的状态一致，但**与宿主真实状态相反**：界面显示「参与轮换」
   * 而宿主是「已拒绝」，点击发出 `rejected: false`… 实际发出的是 `!false = true`？
   *
   * 精确说：`isRejected({}, …)` 恒为 `false` ⇒ 界面显示「参与轮换」。
   * 点击后 `next = !false = true` ⇒ 发出 `rejected: true`（= 再次拒绝，无害）。
   * **但**：若用户想「取消拒绝」，他会看到「参与轮换」以为没拒绝过 —— 真正的问题是
   * **界面与宿主状态不一致**（用户无法知道自己拒绝过什么），且第一次点击的语义
   * 与界面暗示的相反。
   *
   * ⚠️ 更直接的危害：用户 A 拒绝过某候选 → 刷新 → 界面显示「参与轮换」→
   * 用户以为没拒绝过（或以为拒绝丢了）→ **无法通过界面判断真实状态**。
   * 修法：`load()` 必须把 `res.models[].candidates[].rejected` 回填进 `rejections`。
   */
  it('★ load() 必须把宿主返回的 rejected 回填进 rejections 状态', () => {
    // ⚠️ 必须**先定位 `AggregatePanel`** 再找它的 `load` —— 本文件里 `load` 有多个
    //    （另一个组件的在更前面）。我第一版直接 `indexOf('const load = …')`
    //    取到了**另一个组件**的 load，于是断言恒失败（那是我的断言写错，不是实现问题）。
    const panelStart = panelCode.indexOf('function AggregatePanel(')
    expect(panelStart, '必须存在 AggregatePanel').toBeGreaterThan(0)
    const start = panelCode.indexOf('const load = React.useCallback', panelStart)
    expect(start, '必须存在 AggregatePanel 的 load').toBeGreaterThan(panelStart)
    // 到下一个顶层 `export function` 为止（不必猜长度）。
    const nextTop = panelCode.indexOf('\nexport function ', start)
    const body = panelCode.slice(start, nextTop > 0 ? nextTop : undefined)
    expect(body, 'load 必须调用 setRejections 回填宿主状态')
      .toMatch(/setRejections\(/)
    // ⚠️ 且必须用纯函数摊平（而不是自己写三层结构 —— 那会与 `isRejected` 分叉）。
    expect(body).toMatch(/rejectionsFromCatalog\(/)
  })

  it('★ 必须有「把 catalog 的 rejected 摊平成拒绝表」的纯函数（判据只写一份）', () => {
    // ⚠️ 摊平逻辑必须是**纯函数**（单测环境没有 react），且与 `isRejected` 的
    //    三层结构一致（canonicalId → provider → realId → true）。
    expect(read('plugin-src/client/aggregate-panel-logic.js'))
      .toMatch(/export function\s+\w*[Rr]ejection\w*From\w*Catalog|export function\s+rejectionsFromCatalog/)
  })
})

describe('★ isAllCandidatesRejected：候选全部被拒的显式提示（规格 §5.2 要求）', () => {
  const model = (canonicalId, candidates) => ({ canonicalId, candidates })
  const cand = (provider, realId) => ({ provider, realId })

  it('★ 每条都被拒 ⇒ true（面板据此显示「⚠️ 全部被拒」）', () => {
    const m = model('m1', [cand('buddy', 'a'), cand('zcode', 'b')])
    const rejections = {
      m1: { buddy: { a: true }, zcode: { b: true } },
    }
    expect(isAllCandidatesRejected(m, rejections)).toBe(true)
  })

  it('★ 只拒了一部分 ⇒ false（请求仍能路由到未拒的那条）', () => {
    const m = model('m1', [cand('buddy', 'a'), cand('zcode', 'b')])
    const rejections = { m1: { buddy: { a: true } } }
    expect(isAllCandidatesRejected(m, rejections)).toBe(false)
  })

  it('★ 一条也没拒 ⇒ false', () => {
    const m = model('m1', [cand('buddy', 'a')])
    expect(isAllCandidatesRejected(m, {})).toBe(false)
  })

  it('★ 无候选 ⇒ false（「无候选」是另一回事，不是「全被拒」）', () => {
    // ⚠️ 规格明确区分：全被拒 **≠** 关闭模型。无候选的模型不该报「全部被拒」。
    expect(isAllCandidatesRejected(model('m1', []), {})).toBe(false)
  })

  it('★ 畸形入参不抛错', () => {
    expect(isAllCandidatesRejected(null, {})).toBe(false)
    expect(isAllCandidatesRejected(undefined, {})).toBe(false)
    expect(isAllCandidatesRejected({}, {})).toBe(false)
    expect(isAllCandidatesRejected(model('m1', null), {})).toBe(false)
  })

  it('★ 拒绝表结构与 isRejected 一致（三层，不因层缺失而误判）', () => {
    const m = model('m1', [cand('buddy', 'a')])
    // 层存在但值是 false ⇒ 不算被拒
    expect(isAllCandidatesRejected(m, { m1: { buddy: { a: false } } })).toBe(false)
    // 只有 provider 层、没有 realId 层 ⇒ 不算被拒
    expect(isAllCandidatesRejected(m, { m1: { buddy: {} } })).toBe(false)
  })
})

describe('★ rejectionsFromCatalog：行为级（原先只有源码字符串断言，零行为覆盖）', () => {
  const model = (canonicalId, candidates) => ({ canonicalId, candidates })
  const cand = (provider, realId, rejected) => ({ provider, realId, rejected })

  it('★ 把宿主返回的 rejected 摊平成三层结构（isRejected 必须能查到）', () => {
    const models = [
      model('m1', [cand('buddy', 'a', true), cand('zcode', 'b', false)]),
      model('m2', [cand('buddy', 'c', true)]),
    ]
    const table = rejectionsFromCatalog(models)
    // ★ 关键断言：摊平结果必须能被 isRejected 查到（结构一致）
    expect(isRejected(table, 'm1', 'buddy', 'a'), 'm1/buddy/a 应查到').toBe(true)
    expect(isRejected(table, 'm1', 'zcode', 'b'), 'false 的不该进表').toBe(false)
    expect(isRejected(table, 'm2', 'buddy', 'c'), 'm2/buddy/c 应查到').toBe(true)
    // 结构逐层一致
    expect(table).toEqual({ m1: { buddy: { a: true } }, m2: { buddy: { c: true } } })
  })

  it('★ 只收**显式 true**（与宿主的 sanitize 同口径）', () => {
    const models = [model('m1', [
      { provider: 'buddy', realId: 'a' },              // rejected 缺失
      cand('buddy', 'b', undefined),
      cand('buddy', 'c', 'true'),                      // 字符串
      cand('buddy', 'd', 1),                           // 数字
    ])]
    expect(rejectionsFromCatalog(models)).toEqual({})
  })

  it('★ 畸形入参不得建出空层', () => {
    expect(rejectionsFromCatalog(null)).toEqual({})
    expect(rejectionsFromCatalog(undefined)).toEqual({})
    expect(rejectionsFromCatalog('nope')).toEqual({})
    expect(rejectionsFromCatalog([null, 42])).toEqual({})
    expect(rejectionsFromCatalog([{ canonicalId: '', candidates: [cand('b', 'r', true)] }])).toEqual({})
    expect(rejectionsFromCatalog([model('m1', null)])).toEqual({})
    // provider / realId 为空的条目跳过（否则会建出查不到的空层）
    expect(rejectionsFromCatalog([model('m1', [
      { provider: '', realId: 'r', rejected: true },
      { provider: 'p', realId: '', rejected: true },
    ])])).toEqual({})
  })

  it('★ 摊平后 isRejected 与 isAllCandidatesRejected 一致（全被拒能被识别）', () => {
    const models = [model('m1', [cand('buddy', 'a', true), cand('zcode', 'b', true)])]
    const table = rejectionsFromCatalog(models)
    expect(isAllCandidatesRejected(models[0], table), '两条都被拒 ⇒ 应识别为全拒').toBe(true)
  })
})
