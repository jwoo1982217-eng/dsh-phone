import { describe, it, expect } from 'vitest'
import { isModelSaturationError, isRateLimited, MODEL_SATURATION_BUSINESS_CODE } from '../../src/llm-adapter.js'

/**
 * 回归：**模型饱和（14003）**必须与**账号额度限流（6004）**分开
 * （Gitee issue，用户报障 2026-10-05）
 *
 * ## 用户症状
 *
 * 第一次用 `buddy/space-bunny`（reasoningEffort=max / maxTokens=128000）就收到：
 * ```
 * 本轮运行失败 buddy: 模型 space-bunny 所有账号均受限，请稍后再试
 * QUOTA_EXCEEDED
 * ```
 * 而 4 个账号的凭据全部有效、服务端对 `space-bunny` 实测**完全可用**。
 *
 * ## 根因（本文件锁死的就是它）
 *
 * `14003 model busy` **也是 HTTP 429**，而 `isRateLimited` 对 429
 * **无条件返回 true** ⇒ 走了限流分支 ⇒ 给**每个**账号写一条 1 小时标记。
 *
 * 实测四条证据（`scripts/probe-buddy-*.mjs`，2026-10-05）：
 *
 * | 观测 | 结果 |
 * |---|---|
 * | 4 个**不同腾讯 uid** 的账号 | 20 秒内**全部**被写 `space-bunny` 标记 |
 * | 标记解禁时刻 | 全 = 「写入 + 整 1 小时」= `RATE_LIMIT_FALLBACK_MS` **兜底值** |
 * | 4 MB 输入 | 稳定逼出 `429/14003`，报文自称「模型繁忙，请换模型」 |
 * | 小请求 30 发 | 全 200，但耗时 841ms ~ 216s（上游**时变**背压） |
 *
 * 4 个互不相干的账号同时中招 ⇒ 账号级限流**无法解释**，只能是**模型级**。
 * 服务端报文自己就写着 `actions:["SWITCH_MODEL",…]`（**没有**换号选项）。
 *
 * ## 为什么必须分开（行为分叉，不是措辞问题）
 *
 * | | 额度限流 `6004` | 模型饱和 `14003` |
 * |---|---|---|
 * | 语义 | 该**账号**在该模型上额度用完 | 该**模型**此刻整体饱和 |
 * | 换号 | **有效** | **无益**（所有账号撞同一堵墙） |
 * | 写限流标记 | **必须** | **绝对不许**（会把整池锁 1 小时） |
 * | 建议 | 等解禁 / 换账号 | **换模型** / 稍后重试 |
 */

/** 实测原文（`scripts/probe-buddy-error-catalog.mjs`，2026-10-05，4 MB 输入逼出）。 */
const SATURATION_BODY = JSON.stringify({
  code: 14003,
  msg: 'too many requests',
  requestId: 'ac2ff1af-6d6b-49b4-8614-14981aed34d8',
  displayMsg: {
    en: 'Model busy. Please switch models or retry later',
    zh: '模型繁忙，请换模型或稍后重试',
    'zh-hant': '模型繁忙，請更換模型或稍後重試',
  },
  displayTips: {
    en: 'This model is currently saturated. It is not a network issue. Please switch to another model or wait a moment and retry.',
    zh: '这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。',
  },
  actions: ['SWITCH_MODEL', 'SUBMIT_FEEDBACK', 'RETRY'],
})

describe('模型饱和（14003）与额度限流（6004）必须分开', () => {
  describe('判据本体', () => {
    it('真实报文（429 + code 14003）必须被判为模型饱和', () => {
      expect(isModelSaturationError(429, SATURATION_BODY)).toBe(true)
    })

    it('额度限流 6004 **不是**模型饱和（两者动作相反，不能互相吞并）', () => {
      const body = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置"}'
      expect(isModelSaturationError(429, body)).toBe(false)
      // 反向：6004 仍必须被判为限流（既有行为不许回退）
      expect(isRateLimited(body, 429)).toBe(true)
    })

    it('⚠️ 14003 同时**也**满足 isRateLimited（这正是缺陷成因，判据顺序才是修复）', () => {
      // 这条断言是**故意**锁住 `isRateLimited` 的宽泛性：它无法也不该被改窄
      // （空体 429 必须判限流，见 rate-limit-parser.spec.ts）。
      // 所以修复只能靠「在适配器里让饱和判定**先于**限流分支」。
      expect(isRateLimited(SATURATION_BODY, 429)).toBe(true)
    })

    it('业务码兼容字符串与数字两种编码', () => {
      expect(isModelSaturationError(429, '{"code":14003}')).toBe(true)
      expect(isModelSaturationError(429, '{"code":"14003"}')).toBe(true)
    })

    it('裸英文文案（无 JSON 包裹）也能兜底识别', () => {
      // 网关可能包一层裸文本；服务端措辞就是 model busy / saturated。
      expect(isModelSaturationError(429, 'Model busy. Please switch models or retry later')).toBe(true)
      expect(isModelSaturationError(429, 'This model is currently saturated.')).toBe(true)
    })

    it('⚠️ 正文宣称「正常」时（status < 400）不许判饱和', () => {
      // 防止模型正文里恰好讨论「服务器繁忙」被当成错误。
      expect(isModelSaturationError(200, '服务器繁忙时应当重试')).toBe(false)
      // ⚠️ 判据必须**窄**：泛词「繁忙」不算，只认服务端原话里的组合词。
      // 这条断言的意义正是「宁可漏判也不要误伤正常正文」。
      expect(isModelSaturationError(undefined, '服务器繁忙时应当重试')).toBe(false)
      // 但状态码未知、且正文确实是服务端原话时，仍要认（网关裸文本场景）。
      expect(isModelSaturationError(undefined, '模型繁忙，请换模型或稍后重试')).toBe(true)
      // 明确：只有状态码确实表示失败时才认文案。
      expect(isModelSaturationError(500, '模型繁忙')).toBe(true)
    })

    it('不误伤：空体、无关错误、11140 安全拦截都不算饱和', () => {
      expect(isModelSaturationError(429, '')).toBe(false)
      expect(isModelSaturationError(400, '{"code":11102,"msg":"model service info not found"}')).toBe(false)
      expect(isModelSaturationError(403, '{"code":11140,"msg":"request illegal"}')).toBe(false)
      expect(isModelSaturationError(200, '')).toBe(false)
    })

    it('导出常量与实现一致（防止改码值时漏改一处）', () => {
      expect(MODEL_SATURATION_BUSINESS_CODE).toBe(14003)
    })
  })
})
