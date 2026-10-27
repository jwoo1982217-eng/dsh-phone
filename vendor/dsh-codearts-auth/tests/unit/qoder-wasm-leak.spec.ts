/**
 * 回归闸：**Qoder WASM 堆不得只增不减**。
 *
 * ## 被闸的缺陷
 *
 * `src/qoder-wasm.ts` 的 `gluePromise` 是**进程级单例**（所有账号、所有会话
 * 共用一个 wasm 实例，wasm32 上限 4 GB），而每次推理都要新建
 * `QoderContext`（`qodercontext_new`）与 `RequestResult`
 * （`qodercontext_prepareInferRequest`）。早期实现从不释放它们 ⇒ 堆只增不减
 * ⇒ 长上下文会话最先撞天花板，在**发出任何网络请求之前**（~25 ms）以
 * `RuntimeError: unreachable` 暴毙，UI 只显示「本轮运行失败 unreachable」。
 * 全部 8 次历史命中都在 Qoder 路由上（见
 * `.scratch/qoder-wasm-leak/issues/01-unreachable-wasm-leak.md`）。
 *
 * ## 判据为什么是 wasm 线性内存的**页数差**
 *
 * 不用进程 RSS：RSS 受 V8 GC、分配器、以及同进程其它测试文件干扰，
 * 噪声可达几十 MB，而这里的信号是几页~几百页（64 KB/页）。wasm 线性内存
 * 只被本模块的分配驱动，`memory.grow` 又是**单调**的 ⇒ 页数差是干净的读数。
 *
 * ## 🔴 反向控制（本闸的**必要**部分，已实测两次）
 *
 * 闸若恒真就是同义反复。故做了一次**真·反向控制**：把
 * `src/qoder-wasm.ts` 的 `freePointer` 里那句 `exports[name]!(ptr, 0)`
 * 注掉（等价于「删除 free 调用」），跑本文件 ⇒ 用例①**确实变红**：
 *
 * ```
 * AssertionError: wasm 堆增长 455 页（阈值 300）—— free 调用被删了？
 *   expected 455 to be less than 300
 * Tests  1 failed | 3 passed (4)
 * ```
 *
 * 恢复该行（逐字节复原，已用 `Compare-Object` 校验）后 ⇒ **变绿**（4 passed）。
 *
 * 另有一路**不依赖改源码**的常驻反向控制（用例②）：`setFreesEnabled(false)`
 * 关掉全部 free，同一载荷下断言必然超阈。两组实测（DSH-like 80 msg/2KB +
 * 20 tools/3KB，N=50，wasm 页数）：
 *
 * | 组 | 状态 | 实测 |
 * |---|---|---|
 * | A | free 开启（生产路径） | **+294 KB / 50 次 = 5.9 KB/次**（230 页） |
 * | B | free 注掉 | **+576 KB / 50 次 = 11.5 KB/次**（450 页） |
 *
 * 复跑三次的稳定性：A = 300.8 / 294.4 / 294.4 KB；B = 588.8 / 595.2 / 582.4 KB
 * ⇒ 两组无重叠，A 恒 ≈ B/2。阈值 **300 页** 落在两者之间：
 * A 有 70 页余量、B 超阈 150 页。即原句：**`with free: +294 KB/50 calls;
 * without free: +576 KB/50 calls`**。
 *
 * ⚠️ 小载荷（单条 200 B 消息、无工具）下两组是 **2 页 vs 4 页** —— 绝对差
 * 只有 128 KB，噪声占比过高，**不足以做闸**；本文件因此固定用 DSH-like
 * 载荷（与工单里「672 KB/req 的 DSH-like 形态」同一量级）。
 *
 * ## ⚠️ 残留未消（如实记录，别把本闸当「已根治」）
 *
 * 补上两处 free 后仍有 **~294 KB/50 次 ≈ 5.9 KB/次** 的残余增长，另有来源
 * （尚未定位）。本闸锁的是「**free 不能被删掉**」这一条，不是「零泄漏」——
 * 阈值按实测标定，不会因为残余而误判。
 *
 * 另一组独立口径（medium 载荷：40 条消息/1.5 KB + 12 工具/2 KB，N=50）
 * 同样印证约 2× 的改善（`with free: +117.8 KB/次; without free: +227.8 KB/次`）：
 *
 * ```
 * medium  with free:    +5888 KB / 50 = 117.8 KB/次（92 页）
 * medium  without free: +11392 KB / 50 = 227.8 KB/次（178 页）
 * ```
 *
 * （工单里记的同口径旧数是 122 / 256 KB/req —— 与本次实测的 117.8 / 227.8
 * 同量级；差异来自载荷构造细节，故以**本次实测**为准。）
 */
import { describe, expect, it } from 'vitest'
import { describeWasmFailure, QoderEncryptedInfer, __testing, type QoderInferAsk } from '../../src/qoder-wasm.js'
// ⚠️ 生产路径的原生搜索也走 WASM（`searchOnce` 内部 create/dispose），
//    故它同样属于本闸的管辖范围。
import { QoderAdapter } from '../../src/qoder-adapter.js'

const PAGE_BYTES = 65_536

/** 与工单口径一致的 DSH-like 载荷（80 条消息 / 2 KB，20 个工具 / 3 KB）。 */
function dshLikeAsk(): QoderInferAsk {
  const history = Array.from({ length: 80 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(2000),
  }))
  const tools = Array.from({ length: 20 }, (_, i) => ({
    type: 'function' as const,
    function: { name: `tool_${i}`, description: 'y'.repeat(3000), parameters: { type: 'object' } },
  }))
  return { modelKey: 'qfmodel', userText: 'hi', history, tools }
}

const USER = { uid: 'leak-gate-uid', securityOauthToken: 'leak-gate-token' }
const MACHINE_ID = 'leak-gate-machine'
const METADATA = {
  client_type: 'ide',
  business_product: 'qoder',
  business_type: 'agent',
  scene: 'chat',
}
const HOST = 'api2.qoder.sh'

/** 调用次数（工单要求 50~100）。 */
const CALLS = 50

/**
 * 生产路径的页数上限：**必须接近零**。
 *
 * 实测（DSH-like 载荷 / N=50 / 冷堆）= **0 页**。给 10 页余量容抖动。
 *
 * ⚠️ 这里**曾经**是 300（与 `MIN_PAGES_FREES_OFF` 共用一个常量），那是按
 * 「尚有未定位残余、生产路径 230 页」标定的。残余后来被根治（就是漏掉的
 * 第三处 free，见 `src/qoder-wasm.ts` 的 `Glue.freeString`），生产路径掉到
 * 0 页 ⇒ 300 就**太松**了。实测：注掉第三处 free 后生产路径涨回约 230 页，
 * **仍然通过** —— 闸抓不住这条回归。故必须与下面那个常量分开标定。
 */
const MAX_PAGES_PRODUCTION = 10

/**
 * 关掉全部 free 后的页数下限：**必须显著超阈**。
 *
 * 实测（同上口径，`setFreesEnabled(false)`）= **455 页**。取 300 作下限，
 * 留 155 页余量。
 */
const MIN_PAGES_FREES_OFF = 300

/** 跑一批 `create → prepareInfer → dispose`，返回消耗的页数。 */
async function measurePages(ask: QoderInferAsk): Promise<number> {
  const before = await __testing.wasmHeapBytes()
  for (let i = 0; i < CALLS; i += 1) {
    const client = await QoderEncryptedInfer.create({
      user: USER,
      machineId: MACHINE_ID,
      metadata: METADATA,
      host: HOST,
    })
    try {
      client.prepareInfer(ask)
    } finally {
      client.dispose()
    }
  }
  const after = await __testing.wasmHeapBytes()
  return (after - before) / PAGE_BYTES
}

describe('Qoder WASM 堆泄漏闸', () => {
  it('N 次 prepareInfer 的 wasm 堆增长 < 阈值（生产路径带 free）', async () => {
    // ⚠️ **冷堆起测**：`memory.grow` 是**单调**的，前序用例的高水位会让差值失真
    //（详见 case ③ 的长注释 —— 那里实测过「热堆下恒真」的假绿形态）。
    __testing.resetGlue()
    // 预热：排除 compile / instantiate / 首次分配这些**一次性**开销
    // （它们与「每次请求泄漏多少」无关，计入会污染斜率）。
    const warmup = await QoderEncryptedInfer.create({
      user: USER, machineId: MACHINE_ID, metadata: METADATA, host: HOST,
    })
    warmup.prepareInfer(dshLikeAsk())
    warmup.dispose()

    const pages = await measurePages(dshLikeAsk())
    expect(
      pages,
      `wasm 堆增长 ${pages} 页（上限 ${MAX_PAGES_PRODUCTION}）—— 有 free 被删了？`
      + '判据与标定见文件头。',
    ).toBeLessThan(MAX_PAGES_PRODUCTION)
  })

  it('反向控制：注掉 free 后同一载荷必须超阈（否则本闸是同义反复）', async () => {
    __testing.resetGlue()
    const warmup = await QoderEncryptedInfer.create({
      user: USER, machineId: MACHINE_ID, metadata: METADATA, host: HOST,
    })
    warmup.prepareInfer(dshLikeAsk())
    warmup.dispose()

    let pages: number
    try {
      __testing.setFreesEnabled(false)
      pages = await measurePages(dshLikeAsk())
    } finally {
      // ⚠️ 必须无条件复位：置 false 会污染同 worker 里**后续**的用例
      //（vitest 默认按文件隔离 worker，但同文件内的用例共享模块实例）。
      __testing.setFreesEnabled(true)
    }

    expect(
      pages,
      `注掉 free 后只涨了 ${pages} 页（下限 ${MIN_PAGES_FREES_OFF}）—— 说明这条闸量不出泄漏，`
      + '需要重做判据（实测应为 ~455 页）。',
    ).toBeGreaterThanOrEqual(MIN_PAGES_FREES_OFF)
  })

  it('dispose 释放 context：连续 create + dispose 不增长', async () => {
    // ⚠️⚠️ **必须先把 glue 复位到冷堆**（真实缺陷，2026-10-12 审计实测）。
    //
    // `memory.grow` 是**单调**的：本文件前面的用例已用 DSH-like 大载荷把线性
    // 内存推到高水位，此时这 200 次 `create`（不释放 `context`）所需的几页
    // **已被预留** ⇒ 差值恒 ≈ 0 ⇒ 断言恒真，**量不出「dispose 有没有生效」**。
    // 实测证据：注掉 `dispose()` 里的 `freePointer('__wbg_qodercontext_free', …)`，
    //   ① 只跑本用例（冷堆）⇒ **变红**（涨 6 页）；
    //   ② 跑整个文件（热堆）⇒ **8/8 全绿**（连跑 3 次稳定）。
    // ⇒ 复位到冷堆后，本用例才真的在守 `dispose()` 这条交付。
    __testing.resetGlue()
    const REPEAT = 200
    const before = await __testing.wasmHeapBytes()
    for (let i = 0; i < REPEAT; i += 1) {
      const client = await QoderEncryptedInfer.create({
        user: USER, machineId: MACHINE_ID, metadata: METADATA, host: HOST,
      })
      client.dispose()
    }
    const pages = (await __testing.wasmHeapBytes() - before) / PAGE_BYTES
    // 实测（冷堆）：**不** dispose 时 200 次 = 4~6 页；dispose 时 = 0~1 页。
    // 阈值给 2 页，既容得下 1 页的测量抖动，又抓得住「dispose 被删掉」。
    expect(pages, `create + dispose 涨了 ${pages} 页（实测应为 0）`).toBeLessThan(2)
  })

  it('dispose 幂等：重复调用不释放两次（悬垂指针会让下一次 create trap）', async () => {
    const client = await QoderEncryptedInfer.create({
      user: USER, machineId: MACHINE_ID, metadata: METADATA, host: HOST,
    })
    client.dispose()
    // 第二次必须是 no-op：真去 free 同一个指针会让 wasm 分配器状态错乱，
    // 后续 `create` 就会以裸 `unreachable` 炸掉。
    expect(() => { client.dispose() }).not.toThrow()

    // 释放后不可再 prepareInfer：必须给**可读**的报错，而不是 wasm trap。
    expect(() => client.prepareInfer(dshLikeAsk())).toThrow(/已 dispose/)

    // 且不影响后续实例（证明堆没被二次释放搞坏）。
    const next = await QoderEncryptedInfer.create({
      user: USER, machineId: MACHINE_ID, metadata: METADATA, host: HOST,
    })
    await expect(Promise.resolve().then(() => next.prepareInfer(dshLikeAsk()))).resolves.toBeTruthy()
    next.dispose()
  })

  it('⚠️ 生产路径 `QoderAdapter.searchOnce` 必须自己 dispose（否则每次搜索都泄漏）', async () => {
    // ⚠️⚠️ 这条用例的存在理由（2026-10-14 变异测试实测）：
    //
    // 上面三条守的是 `QoderEncryptedInfer` 的**直接**用法。而原生搜索走的是
    // `QoderAdapter.searchOnce` —— 它在内部 **自己** `create` / `dispose`。
    // 把 `searchOnce` 里那句 `client?.dispose?.()` 删掉后，本文件原有 4 条用例
    // **全部仍绿**（实测）⇒ 存在一个**零守卫**的生产路径。
    //
    // ## 🔴 `REPEAT = 500` 是**标定过的**，不要调小
    //
    // 首次写这条用例时用了 30 次，结果**变异抓不到**（删掉 dispose 后仍全绿）。
    // 独立诊断（`create` 有/无 dispose 各 500 次，冷堆）实测：
    //
    // | 组 | 30 次 | 500 次 |
    // |---|---|---|
    // | create + dispose（生产路径） | 1 页 | **1 页** |
    // | create **不** dispose（反向控制） | 1 页 | **13 页** |
    //
    // ⇒ 30 次时 `memory.grow` 的单调性把差异吃掉了（首次分配就把堆推到高水位，
    //    后续复用 ⇒ 两种实现都只涨 1 页，**信噪比 1.0**）；500 次时信噪比 **13×**。
    __testing.resetGlue()
    const REPEAT = 500
    const before = await __testing.wasmHeapBytes()
    for (let i = 0; i < REPEAT; i += 1) {
      // fetch 恒失败即可：本用例只关心 `searchOnce` **有没有走 finally 里的
      // dispose**，不关心搜索结果。失败路径同样必须释放。
      const adapter = new QoderAdapter({
        credentialRef: 'QODER_ACCOUNT_LEAK_GATE' as never,
        resolveCredential: async () => ({
          security_oauth_token: 'leak-gate-token',
          access_token: 'leak-gate-token',
          machine_id: MACHINE_ID,
          uid: USER.uid,
        }) as never,
        refresh: async () => {},
        fetchImpl: (async () => { throw new Error('leak-gate: 故意失败') }) as unknown as typeof fetch,
      })
      await adapter.searchOnce('leak gate', {
        security_oauth_token: 'leak-gate-token',
        access_token: 'leak-gate-token',
        machine_id: MACHINE_ID,
        uid: USER.uid,
      }, new AbortController().signal).catch(() => { /* 失败是预期的 */ })
    }
    const pages = (await __testing.wasmHeapBytes() - before) / PAGE_BYTES
    // 标定：生产路径 1 页、无 dispose 13 页 ⇒ 阈值 4 页落在两者之间且留足余量。
    expect(pages, `searchOnce × ${REPEAT} 涨了 ${pages} 页（应 ≈1，说明 finally 里的 dispose 失效）`)
      .toBeLessThan(4)
  })
})

/**
 * 可观测性闸：wasm trap 的裸报文必须被改写成可自解释的中文。
 *
 * 背景：V8 对 wasm `unreachable` 的报文**只有一个词**，不含 host / provider /
 * 账号 / 阶段。DSH 再经 `normalizeLlmFailure()` 归一成
 * `{message:'unreachable', code:'UNKNOWN'}`，UI 上就剩「本轮运行失败
 * unreachable」—— 真实成因（WASM 堆耗尽 / Rust panic）完全不可见，
 * 历史上 8 次命中因此全部无法定位。
 */
describe('wasm trap 报文改写', () => {
  it('裸 `unreachable` 被改写成可自解释的中文', () => {
    const raw = new Error('unreachable')
    raw.name = 'RuntimeError'
    const described = describeWasmFailure(raw) as Error
    expect(described).toBeInstanceOf(Error)
    expect(described.message).toContain('WASM 堆耗尽')
    expect(described.message).toContain('重启 DSH')
    expect(described.message).not.toBe('unreachable')
    // 原始报文必须保留在报文里（排查要靠它认出这是 trap）。
    expect(described.message).toContain('unreachable')
    // 因果链保留：别把原始 Error 丢掉。
    expect(described.cause).toBe(raw)
  })

  it('其它 RuntimeError 原样放行（它们自带成因，改写反而丢信息）', () => {
    const oob = new Error('memory access out of bounds')
    oob.name = 'RuntimeError'
    expect(describeWasmFailure(oob)).toBe(oob)
  })

  it('非 RuntimeError 与非 Error 值原样放行', () => {
    const plain = new Error('boom')
    expect(describeWasmFailure(plain)).toBe(plain)
    expect(describeWasmFailure('unreachable')).toBe('unreachable')
    expect(describeWasmFailure(undefined)).toBeUndefined()
  })

  it('报文里带别的字样的 RuntimeError 不被误改', () => {
    const other = new Error('unreachable: something else')
    other.name = 'RuntimeError'
    expect(describeWasmFailure(other)).toBe(other)
  })
})
