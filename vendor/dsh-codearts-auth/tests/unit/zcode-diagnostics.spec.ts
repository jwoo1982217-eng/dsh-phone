/**
 * ZCode `3012` 可观测诊断的回归用例（Gitee issue IKJI0Y）。
 *
 * ## 这组用例在钉什么
 *
 * issue 的诉求是「把账号池序号、计数、身份块字符数等写进错误文案」。
 * 它同时带来一条**必须成立**的红线：**文案里不得出现任何凭据** ——
 * 否则就是把排障信息写进了用户截图会连带泄露的东西。
 *
 * ⇒ 下面有一条专门的「反例用例」：把 accountId 换成看起来最像凭据的串，
 * 断言它的**每一个子串**都不出现在渲染结果里。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  accountOrdinal,
  describeZcodeRequestShape,
  formatZcodeDiagnostic,
  noteZcodeRequestFailed,
  noteZcodeRequestOk,
  noteZcodeRequestSent,
  resetZcodeDiagnostics,
} from '../../src/zcode-diagnostics.js'
import { buildZcodeSystemBlocks, withContextPrefix } from '../../src/zcode-identity.js'
import { describeUpstreamError, httpErrorCodeForZcode } from '../../src/zcode-adapter.js'

/** 走真实构造路径拿一份请求体形态（与 `stream()` 里用的是同一批函数）。 */
function realShape(): ReturnType<typeof describeZcodeRequestShape> {
  const system = buildZcodeSystemBlocks('You are DSH, a coding agent.', {
    cwd: process.cwd(),
    provider: 'zcode',
    model: 'GLM-5.3-Flash',
  })
  const messages = withContextPrefix([{ role: 'user', content: '你好' }])
  return describeZcodeRequestShape(system, messages)
}

describe('ZCode 3012 可观测诊断（issue IKJI0Y）', () => {
  beforeEach(() => {
    resetZcodeDiagnostics()
  })

  describe('请求形态实测', () => {
    it('★ 身份块字符数读的是**实际构造出来的 system**，不是常量', () => {
      const shape = realShape()
      // 2898 = cliPrefix(42) + stable(2856)，与 README 实测矩阵同量级。
      expect(shape.identityChars).toBe(2898)
      expect(shape.identityBlockChars).toEqual([42, 2856])
      expect(shape.cliPrefixChars).toBe(42)
      expect(shape.systemBlocks).toBeGreaterThanOrEqual(3)
    })

    it('★ 真实请求体形态的诊断行包含 issue 要的每一项', () => {
      const shape = realShape()
      const line = formatZcodeDiagnostic({
        accountId: 'zcode-1a2b3c4d',
        sentAt: 1_000_000,
        status: 405,
        shape,
        now: 1_000_000,
      })
      expect(line).toContain('账号#')
      expect(line).toContain('本进程 成功')
      expect(line).toContain('最近成功')
      expect(line).toContain('距上条')
      expect(line).toContain('身份块 2898 字符(42+2856)')
      expect(line).toContain('日期块 有')
      expect(line).toContain('HTTP 405')
    })

    /**
     * ★ 反向验证：常量说 2898，但如果真出现「身份块没进请求体」，
     * 诊断必须**如实显示 0** —— 读实际值才做得到这一点。
     */
    it('★ 身份块缺失时如实报 0 字符（读实际值，不是读常量）', () => {
      const shape = describeZcodeRequestShape('You are DSH.', [{ role: 'user', content: 'hi' }])
      expect(shape.systemBlocks).toBe(0)
      expect(shape.identityChars).toBe(0)
      const line = formatZcodeDiagnostic({
        accountId: 'a', sentAt: 1, status: 405, shape, now: 1,
      })
      expect(line).toContain('身份块 0 字符(无)')
      expect(line).not.toContain('2898')
    })

    it('日期块有无被如实识别（去掉日期块即报「无」）', () => {
      const without = describeZcodeRequestShape(
        buildZcodeSystemBlocks(undefined, { cwd: '.' }),
        [{ role: 'user', content: '裸文本' }],
      )
      expect(without.hasDateBlock).toBe(false)
      const line = formatZcodeDiagnostic({
        accountId: 'a', sentAt: 1, status: 405, shape: without, now: 1,
      })
      expect(line).toContain('日期块 无')
    })
  })

  describe('账号画像', () => {
    it('★ 同一账号多次拿到**同一序号**（否则跨请求无法对比）', () => {
      const first = accountOrdinal('acct-A')
      expect(accountOrdinal('acct-A')).toBe(first)
      expect(accountOrdinal('acct-B')).not.toBe(first)
    })

    it('★ 成功/失败计数与「最近成功」如实累计', () => {
      noteZcodeRequestSent('acct-A', 1_000)
      noteZcodeRequestOk('acct-A', 1_100)
      noteZcodeRequestSent('acct-A', 2_000)
      noteZcodeRequestOk('acct-A', 2_100)
      noteZcodeRequestSent('acct-A', 3_000)
      noteZcodeRequestFailed('acct-A')
      const line = formatZcodeDiagnostic({
        accountId: 'acct-A',
        sentAt: 3_000,
        status: 405,
        shape: realShape(),
        now: 5_100,
      })
      expect(line).toContain('本进程 成功 2/失败 1')
      expect(line).toContain('最近成功 3.0s前')
    })

    it('从未成功过的账号写「从未成功过」而不是 0（不谎报）', () => {
      const line = formatZcodeDiagnostic({
        accountId: 'acct-C', sentAt: 1, status: 405, shape: realShape(), now: 999_999,
      })
      expect(line).toContain('最近成功 从未成功过')
    })

    /**
     * ★「距上条」必须按**适配器的真实调用顺序**测：先 `noteZcodeRequestSent`
     * 记下**本次**出发时刻，再诊断 —— 而不是「记一条旧的、直接诊断一条新的」。
     *
     * ⚠ 这个顺序正是本条存在的理由：首版按后者写，全绿；
     * 但适配器实际是前者，而后者在实现里会把 `lastSentAt` 覆盖成**本次**，
     * 算出来恒为 `0ms`（端到端脚本真的打印出过 `距上条 0ms`）。
     * ⚠ 下面紧跟一条**反向验证**专测这个覆盖。
     */
    it('★「距上条」算的是**上一条**请求，且按适配器的真实调用顺序', () => {
      const T = 1_000_000
      noteZcodeRequestSent('acct-A', T - 90_000)     // 上一条
      noteZcodeRequestOk('acct-A', T - 89_500)
      noteZcodeRequestSent('acct-A', T)             // ★ 本次：先记
      noteZcodeRequestFailed('acct-A')              // ★ 再诊断（适配器的顺序）
      const line = formatZcodeDiagnostic({
        accountId: 'acct-A',
        sentAt: T,
        status: 405,
        shape: realShape(),
        now: T,
      })
      expect(line).toContain('距上条 1分30秒')
      expect(line).not.toContain('距上条 0ms')
    })

    /**
     * ★ 分钟/小时档的换算（真实缺陷，逐字复现）。
     *
     * 初版把分钟档写成 `${Math.floor(seconds % 60)}分…` —— 分位取的是**秒的
     * 余数**，于是 90 秒渲染成「30分30秒」。该错误是在**真实探针输出**里
     * 发现的（「最近成功 29分29秒前」），纯函数单测当时没覆盖 ≥60 秒的区间。
     */
    it('★ 分钟/小时档换算正确（90 秒 ≠ 30 分 30 秒）', () => {
      const T = 10_000_000
      /**
       * 每个断言用**独立账号**：复用同一个会让上一条断言留下的
       * `previousSentAt` 变成下一条的分母（诊断量的是「上一条」）。
       */
      const gapAt = (n: number, sincePrev: number) => {
        const id = `acct-G${n}`
        const sentAt = T - n * 1_000
        noteZcodeRequestSent(id, sentAt - sincePrev)   // 铺一条「上一条」
        noteZcodeRequestSent(id, sentAt)               // 本次
        noteZcodeRequestFailed(id)
        return formatZcodeDiagnostic({
          accountId: id, sentAt, status: 405, shape: realShape(), now: sentAt,
        })
      }
      expect(gapAt(1, 90_000)).toContain('距上条 1分30秒')
      expect(gapAt(2, 3_600_000)).toContain('距上条 1小时')
      expect(gapAt(3, 5_400_000)).toContain('距上条 1小时30分')
      expect(gapAt(4, 120_000)).toContain('距上条 2分')
    })

    it('★ 本次记录不得把自己的间隔抹成 0（连续两发的分母是上一条）', () => {
      const T = 2_000_000
      noteZcodeRequestSent('acct-A', T - 5_000)
      noteZcodeRequestSent('acct-A', T - 2_400)      // 本次与上一条隔 2.6 秒
      noteZcodeRequestFailed('acct-A')
      const line = formatZcodeDiagnostic({
        accountId: 'acct-A', sentAt: T - 2_400, status: 405, shape: realShape(), now: T - 2_400,
      })
      expect(line).toContain('距上条 2.6s')
    })

    it('首次请求没有「上一条」时写破折号而不是 0', () => {
      const line = formatZcodeDiagnostic({
        accountId: 'acct-D', sentAt: 5_000, status: 405, shape: realShape(), now: 5_000,
      })
      expect(line).toContain('距上条 —')
    })
  })

  describe('红线：诊断行不得含任何凭据', () => {
    it('★ accountId 的每个子串都不得出现在诊断行里', () => {
      const accountId = 'zcode-1a2b3c4d'
      noteZcodeRequestSent(accountId, 1_000)
      noteZcodeRequestOk(accountId, 1_100)
      const line = formatZcodeDiagnostic({
        accountId,
        sentAt: 2_000,
        status: 405,
        shape: realShape(),
        now: 2_000,
      })
      expect(line).not.toContain(accountId)
      // 逐个子串也排除（防止将来改成「取前 8 位」这类半截输出）
      for (const token of ['1a2b', 'b3c4', '1a2b3c4d', 'zcode-']) {
        expect(line).not.toContain(token)
      }
    })

    it('JWT / device_mid 不进诊断（诊断只看序号与计数）', () => {
      // 账号 id 哪怕长得像 JWT，也只会变成一个序号
      const jwtish = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjo0NTQ0MTc3fQ.sig'
      const line = formatZcodeDiagnostic({
        accountId: jwtish, sentAt: 1, status: 405, shape: realShape(), now: 1,
      })
      expect(line).not.toContain(jwtish)
      expect(line).not.toContain('eyJ')
    })
  })

  describe('文案接线', () => {
    it('★ 3012 文案带上诊断行', () => {
      noteZcodeRequestSent('acct-A', 1_000)
      noteZcodeRequestFailed('acct-A')
      const diag = formatZcodeDiagnostic({
        accountId: 'acct-A', sentAt: 1_000, status: 405, shape: realShape(), now: 1_000,
      })
      const text = describeUpstreamError(405, '{"code":3012,"msg":"blocked"}', diag)
      expect(text).toContain('本机诊断：')
      expect(text).toContain('账号#1')
      expect(text).toContain('身份块 2898 字符')
    })

    it('★ 不给诊断时行为与原来**逐字一致**（旧调用点不受影响）', () => {
      const text = describeUpstreamError(405, '{"code":3012,"msg":"blocked"}')
      expect(text).not.toContain('本机诊断')
      expect(text).toContain('原始响应：blocked')
    })

    it('★ 诊断只是**加了一行**，不改变 3012 的可重试性', () => {
      const diag = formatZcodeDiagnostic({
        accountId: 'acct-A', sentAt: 1, status: 405, shape: realShape(), now: 1,
      })
      const code = httpErrorCodeForZcode(405, '{"code":3012}')
      expect(code).toBe('PERMISSION')
      expect(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']).not.toContain(code)
      expect(describeUpstreamError(405, '{"code":3012}', diag)).toContain('3012')
    })

    it('非 3012 的错误**不附**诊断（那些文案本身已说明原因）', () => {
      // 适配器只在 `text.includes('3012')` 时传诊断；这里验证纯函数侧：
      // 即使误传，3007/1005 的固定文案仍以自己的说明开头。
      const diag = '账号#1 · 身份块 2898 字符'
      expect(describeUpstreamError(400, '{"code":3007}', diag)).toContain('阿里云 captcha 校验失败')
      expect(describeUpstreamError(429, '{"code":1005}', diag)).toContain('额度用尽')
    })
  })
})
