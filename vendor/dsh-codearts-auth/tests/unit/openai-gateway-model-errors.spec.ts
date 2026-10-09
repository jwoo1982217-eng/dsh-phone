import { describe, expect, it } from 'vitest'
import {
  findCaseInsensitiveSuggestion,
  looksLikeMissingModel,
  normalizeUpstreamFailure,
} from '../../src/openai-gateway/model-errors.js'

/**
 * 上游「模型不存在」类错误的**翻译**。
 *
 * ## 为什么是翻译而不是预检拦截
 *
 * `design.md:76` 明确要求「隐藏模型不出现在 /v1/models，但显式请求仍交给 DSH
 * 路由处理」。有些 provider 支持目录之外的模型（远端新上线、黑名单隐藏的），
 * 网关若在发请求前用 `listModels` 拦截，会把这类合法请求一并挡掉。
 *
 * 所以网关**不预判**：照常发起请求，只把上游返回的「模型不存在」从 502
 * （网关故障、客户端会重试）翻译成 404（配置错误、重试无意义）。
 *
 * ⚠️ 判据必须**窄**：CodeArts 的 `INVALID_REQUEST` 还覆盖参数非法、余额不足等
 * 多种情况，一律误判成「模型不存在」会让真正的参数错误也变成 404。
 */

describe('looksLikeMissingModel', () => {
  it('认得实测到的真实措辞', () => {
    // 实测：codearts 返回 code=INVALID_REQUEST + 下面这句。
    expect(looksLikeMissingModel('codearts: The model is not registered, please request other model')).toBe(true)
  })

  it('认得其它常见措辞', () => {
    for (const text of [
      'unknown model: foo',
      'model not found',
      'no such model',
      'The model does not exist',
      '模型不存在',
    ]) {
      expect(looksLikeMissingModel(text), text).toBe(true)
    }
  })

  it('认得本插件自己的措辞（gemini 拒绝未知模型名）', () => {
    // 实测：`gemini/gemini-9.9-fake` 曾静默跑出 3.8 的答案，加上校验后这条
    // 错误必须也走「模型不存在」通道，否则用户看到的是 502（会被白重试）。
    expect(looksLikeMissingModel('gemini: 模型 "gemini-9.9-fake" 不在本 provider 目录中（仅支持 gemini-3.8-flash）')).toBe(true)
  })

  it('⚠️ 其它错误不得被误判成模型不存在', () => {
    // 这几条都是真实的 INVALID_REQUEST / 其它失败形态，误判会让用户去查模型名
    // 而真正的参数错误被掩盖。
    for (const text of [
      'Invalid parameter: max_tokens',
      '余额不足',
      'Billing daily count exceeded',
      'rate limit exceeded',
      'the model returned an internal error',
      '模型返回了无效内容',
      '目录服务暂时不可用',
      'provider 未配置',
      '',
    ]) {
      expect(looksLikeMissingModel(text), text).toBe(false)
    }
  })
})

/**
 * 新增的 `/不在本\s*provider\s*目录中/i` 是**本插件自己的措辞**，被放进了
 * **全 provider 共用**的判据表 —— 所以必须逐条证明它不会把别家误伤。
 *
 * ## 为什么值得单列一组
 *
 * `MISSING_MODEL_PATTERNS` 命中后的后果不是「多一句提示」，而是
 * `normalizeUpstreamFailure` 把状态码**改写成 404 + model_not_found**。
 * 一次误判 = 客户端不再重试 + 提示用户去改模型名，而真正原因（凭据失效、
 * 图片未支持、排队超时、通道缺失）被完全掩盖 —— 这类误判比不翻译更糟。
 */
describe('looksLikeMissingModel · 既有 provider 的真实报错文案不得被误伤', () => {
  /**
   * 逐条摘自各适配器的 `throw new LlmError('…')` 原文（2026-10-04 核对）。
   * ⚠️ 加新 provider / 改这些文案时，**顺手回来加一条**。
   */
  const REAL_MESSAGES: readonly string[] = [
    'codearts: no usable credential; log in first',
    'codearts: credential missing after refresh; log in again',
    'codearts: queue wait timed out after 30 minutes',
    'codearts: request aborted while waiting in queue',
    'codearts: empty model response body',
    'codearts: sse transport error: socket hang up',
    'buddy: model "X" does not accept image input.',
    'buddy: image input requires the attachment service.',
    'buddy: 模型 X 所有账号均受限，请稍后再试',
    'qoder: 图片输入需要附件服务',
    'qoder: no usable credential; log in first',
    'qoder: credential expired and refresh failed',
    'qoder: 排队等待超时',
    'qoder: 排队等待期间请求已取消',
    'cline: 图片输入需要附件服务',
    'cline: no usable credential; log in first',
    'cline: credential expired and refresh failed',
    'lobsterai: 图片输入需要附件服务',
    'lobsterai: no usable credential; log in first',
    'lobsterai: empty model response body',
    'loomy: 模型 "X" 不支持图片输入',
    'loomy: 图片输入需要附件服务',
    'loomy: no usable credential; log in first',
    'raccoon: 模型 "X" 不支持图片输入',
    'raccoon: 图片输入需要附件服务',
    'raccoon: no usable credential; log in first',
    'trae: no usable credential; log in first',
    'trae: empty model response body',
    'trae: 积分不足（余额不足）',
    'zcode: 上游请求未发出（内部状态异常）',
    'zcode: 退避等待期间请求已取消',
    'opencode: 没有可用通道',
    'opencode: 图片输入需要附件服务',
    'minimax: no usable credential; log in first',
    'minimax: 响应缺少 body',
  ]

  for (const message of REAL_MESSAGES) {
    it(`不误判：${message}`, () => {
      expect(looksLikeMissingModel(message)).toBe(false)
    })
  }

  it('⚠️ 新增措辞的近似形：只有「不在本 provider 目录中」这一整串才算命中', () => {
    // 逐条只差一两个词 —— 这些才是真正会误伤的形状。
    for (const message of [
      'provider 目录中没有这个模型',      // 语序相反
      '该模型不在目录中',                // 缺 provider
      '不在本目录中',                    // 缺 provider
      '目录不在本 provider 中',          // 词序被打乱
      '不在本 provider 中',              // 缺「目录中」
      '目录中列出了该模型，但未启用',    // 讲的是目录内容，不是「不存在」
      '模型不在本 provider 中',          // 缺「目录」二字
    ]) {
      expect(looksLikeMissingModel(message), message).toBe(false)
    }
  })

  it('已知边界（如实记录）：判据锚在整串措辞上，不锚主语', () => {
    // 「服务不在本 provider 目录中」也会命中 —— 正则只锚 `不在本 provider 目录中`
    // 这一整串，**不要求主语是「模型」**。
    //
    // 这是**刻意接受**的：① 该措辞是本插件 gemini 校验自己造的，别家不会发；
    // ② 收紧到必须带「模型」会把判据与文案耦合，上游改个词就又漏判。
    // 真正的护栏是上面那组「各 provider 真实文案」—— 逐条证明现状无碰撞。
    expect(looksLikeMissingModel('服务不在本 provider 目录中')).toBe(true)
  })

  it('仍然命中的三种写法（「本」与 provider 之间空格可有可无、大小写不敏感）', () => {
    for (const message of [
      'gemini: 模型 "x" 不在本 provider 目录中（仅支持 gemini-3.8-flash）',
      'gemini: 模型 "x" 不在本provider目录中',
      'gemini: 模型 "x" 不在本   provider   目录中',
      'GEMINI: 模型 "x" 不在本 PROVIDER 目录中',
    ]) {
      expect(looksLikeMissingModel(message), message).toBe(true)
    }
    // ⚠️ 但「不在」与「本」之间的空格**不容忍**（判据里那里没有 `\s*`）——
    // 现有文案不这么写，加这条是为了让边界写在用例里而不是只在心里。
    expect(looksLikeMissingModel('不在  本 provider 目录中')).toBe(false)
  })
})

describe('normalizeUpstreamFailure', () => {
  it('模型不存在：从 502 翻成 404 + invalid_request（不该被当成可重试故障）', () => {
    // 502 在 OpenAI 客户端眼里是「服务端故障」→ 会自动重试，而这是确定性失败。
    const result = normalizeUpstreamFailure({
      status: 502,
      type: 'server_error',
      code: 'INVALID_REQUEST',
      message: 'codearts: The model is not registered, please request other model',
    })
    expect(result).toEqual({ status: 404, type: 'invalid_request_error', code: 'model_not_found' })
  })

  it('非模型类错误原样保留（不得被顺手改写成 404）', () => {
    // ⚠️ 返回值**不含 message**（那是给调用方拼文案用的），故不能与入参整体比较。
    expect(normalizeUpstreamFailure({
      status: 502, type: 'server_error', code: 'SERVER', message: 'upstream exploded',
    })).toEqual({ status: 502, type: 'server_error', code: 'SERVER' })
  })

  it('本插件自己的「不在目录中」措辞同样翻成 404', () => {
    const result = normalizeUpstreamFailure({
      status: 502,
      type: 'server_error',
      code: 'INVALID_REQUEST',
      message: 'gemini: 模型 "gemini-9.9-fake" 不在本 provider 目录中（仅支持 gemini-3.8-flash）',
    })
    expect(result).toEqual({ status: 404, type: 'invalid_request_error', code: 'model_not_found' })
  })

  it('余额不足等 INVALID_REQUEST 不会被当成模型不存在', () => {
    const result = normalizeUpstreamFailure({
      status: 502, type: 'server_error', code: 'INVALID_REQUEST',
      message: 'Invalid parameter: max_tokens',
    })
    expect(result.status).toBe(502)
  })
})

describe('findCaseInsensitiveSuggestion', () => {
  const CATALOG = [
    'codearts/glm-5.3-flash',
    'codearts/GLM-5.2',
    'buddy/deepseek-v4.1-flash',
  ]

  it('大小写拼错时给出正确拼写', () => {
    // 实测：用户照着 GLM-5.2 的大小写习惯猜出 GLM-5.3 → 被上游拒绝，
    // 但没有任何提示告诉他真正的小写 ID 是什么。
    expect(findCaseInsensitiveSuggestion('buddy/DeepSeek-V4.1-Flash', CATALOG)).toBe('buddy/deepseek-v4.1-flash')
    expect(findCaseInsensitiveSuggestion('Codearts/GLM-5.2', CATALOG)).toBe('codearts/GLM-5.2')
  })

  it('★ 实测那个真实误填：GLM-5.3 → glm-5.3-flash（既大小写不同又少一截后缀）', () => {
    // 纯「大小写全等」救不了这条：只有前缀匹配才能命中。漏掉第二级的话，
    // 用户拿到的还是那句没有任何线索的 "model is not registered"。
    expect(findCaseInsensitiveSuggestion('codearts/GLM-5.3', CATALOG)).toBe('codearts/glm-5.3-flash')
  })

  it('少打结尾时只有在候选唯一时才敢建议（有歧义就不猜）', () => {
    const ambiguous = ['codearts/glm-5.3-flash', 'codearts/glm-5.3-flashx']
    expect(findCaseInsensitiveSuggestion('codearts/glm-5.3-f', ambiguous)).toBeUndefined()
    expect(findCaseInsensitiveSuggestion('codearts/glm-5.3-f', ambiguous.slice(0, 1))).toBe('codearts/glm-5.3-flash')
  })

  it('完全不存在时不硬凑一个建议', () => {
    expect(findCaseInsensitiveSuggestion('codearts/totally-other', CATALOG)).toBeUndefined()
    expect(findCaseInsensitiveSuggestion('unknown/model', CATALOG)).toBeUndefined()
  })

  it('精确命中时返回 undefined（没有拼写错误就没有建议）', () => {
    expect(findCaseInsensitiveSuggestion('codearts/GLM-5.2', CATALOG)).toBeUndefined()
  })

  it('目录为空时不报错', () => {
    expect(findCaseInsensitiveSuggestion('a/b', [])).toBeUndefined()
  })

  it('只认大小写不同：模型段相同但 provider 不同不得建议', () => {
    // codearts 与 buddy 各有一份 deepseek-v4.1-flash，换 provider 不是拼写错误。
    expect(findCaseInsensitiveSuggestion('CodeArts/deepseek-v4.1-flash', CATALOG)).toBeUndefined()
  })
})
