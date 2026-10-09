import { describe, expect, it } from 'vitest'
import {
  LOOMY_AUTH_ERROR_CODE,
  LOOMY_OK_CODE,
  credentialExpiresAtMs,
  isLoomyChatModel,
  isLoomyExpired,
  isLoomyRefreshable,
  loomyBusinessHeaders,
  loomyChatHeaders,
  loomyDisplayName,
  parseLoomyEnvelope,
  splitLoomyRate,
  type LoomyCredential,
} from '../../src/loomy.js'

/**
 * 倍率规范化。
 *
 * ⚠️ 依据是**实测的远端 name 原值**（2026-09-26，GET /api/v1/models）。
 * Loomy 把倍率**拼在 name 字符串里**、没有独立字段，且三种括号/空格风格混用：
 *   `MiniMax M3 （x4.0）`  全角 + 括号前有空格
 *   `Qwen 3.8 Max (x12.0)` 半角
 *   `GLM 5.3 Flash(x0.8)`  半角 + 括号前无空格
 * 故必须规范化，不能原样透传（否则菜单里三种风格并存）。
 */
describe('splitLoomyRate：从远端 name 抽倍率', () => {
  it.each([
    ['DeepSeek V4 Flash 0731（x3.0）', 'DeepSeek V4 Flash 0731', 'x3.0'],
    ['MiniMax M3 （x4.0）', 'MiniMax M3', 'x4.0'],
    ['Kimi k2.6 （x6.5）', 'Kimi k2.6', 'x6.5'],
    ['Qwen 3.8 Max (x12.0)', 'Qwen 3.8 Max', 'x12.0'],
    ['GLM 5.3 Flash(x0.8)', 'GLM 5.3 Flash', 'x0.8'],
    ['qwen 3.8 flash（x0.8）', 'qwen 3.8 flash', 'x0.8'],
    ['Spark X2.5（x0.1）', 'Spark X2.5', 'x0.1'],
    ['MiMo V2.5（x3.3）', 'MiMo V2.5', 'x3.3'],
  ])('%s → name=%s rate=%s', (raw, name, rate) => {
    expect(splitLoomyRate(raw)).toEqual({ name, rate })
  })

  it('无倍率的展示名（生图模型）原样保留、rate 为空串', () => {
    expect(splitLoomyRate('Hy image 3.5 preview'))
      .toEqual({ name: 'Hy image 3.5 preview', rate: '' })
  })

  it('空串不抛错', () => {
    expect(splitLoomyRate('')).toEqual({ name: '', rate: '' })
  })

  it('括号在中间（非末尾）时不误切', () => {
    // 只认**末尾**括号：中间的括号属于模型名本身。
    expect(splitLoomyRate('Foo (bar) Baz（x1.0）'))
      .toEqual({ name: 'Foo (bar) Baz', rate: 'x1.0' })
  })

  /**
   * ⚠️ 必须同时认**已规范化**的 `{name} · x{n}` 形态。
   *
   * 真实缺陷（本次实现时暴露）：兜底表（`loomy-product.ts`）存的就是
   * 规范化后的名字，早期只认括号形态 → `resolveModel` 无法从兜底表名里
   * 去掉倍率，返回 `Spark X2.5 · x0.1` 而非 `Spark X2.5`。
   */
  it('认已规范化形态 `{name} · x{n}`（兜底表用的就是它）', () => {
    expect(splitLoomyRate('Spark X2.5 · x0.1')).toEqual({ name: 'Spark X2.5', rate: 'x0.1' })
    expect(splitLoomyRate('MiniMax M3 · x4.0')).toEqual({ name: 'MiniMax M3', rate: 'x4.0' })
    // 无空格也认
    expect(splitLoomyRate('Foo·x2.0')).toEqual({ name: 'Foo', rate: 'x2.0' })
  })

  it('幂等：对已规范化的名字再规范化不改变结果', () => {
    for (const raw of [
      'MiniMax M3 （x4.0）', 'Qwen 3.8 Max (x12.0)', 'GLM 5.3 Flash(x0.8)',
      'Hy image 3.5 preview',
    ]) {
      const once = loomyDisplayName(raw)
      expect(loomyDisplayName(once)).toBe(once)
      expect(splitLoomyRate(once)).toEqual(splitLoomyRate(raw))
    }
  })
})

describe('loomyDisplayName：拼最终展示名', () => {
  it('有倍率时用「 · x{n}」追加', () => {
    expect(loomyDisplayName('MiniMax M3 （x4.0）')).toBe('MiniMax M3 · x4.0')
  })

  it('无倍率时不追加分隔符', () => {
    expect(loomyDisplayName('Hy image 3.5 preview')).toBe('Hy image 3.5 preview')
  })
})

/**
 * chat 模型过滤。
 *
 * ⚠️ 判据必须是 `type === 'chat'`，**不能**看 `capabilities.output_modalities`
 * 或 `input_modalities`：实测 `MiniMax-M3` / `Kimi-k2.6` / `GLM-5.3-Flash` /
 * `qwen3.8-flash` / `mimo-v2.5` 的 `input_modalities` **含 image**，那是
 * 「能看图」的**输入**多模态，不是生图模型。用错判据会把它们误过滤掉。
 */
describe('isLoomyChatModel：按 type 过滤', () => {
  it('type=chat 通过（即使 input_modalities 含 image）', () => {
    expect(isLoomyChatModel({
      id: 'MiniMax-M3',
      type: 'chat',
      capabilities: { input_modalities: ['text', 'image', 'video'] },
    })).toBe(true)
  })

  it('type=image 被过滤（生图模型）', () => {
    expect(isLoomyChatModel({
      id: 'Hy-Image-3.5-preview',
      type: 'image',
      capabilities: { output_modalities: ['image'] },
    })).toBe(false)
  })

  it('非对象、缺 id、缺 type 一律过滤', () => {
    expect(isLoomyChatModel(null)).toBe(false)
    expect(isLoomyChatModel('x')).toBe(false)
    expect(isLoomyChatModel({})).toBe(false)
    expect(isLoomyChatModel({ id: 'a' })).toBe(false)
    expect(isLoomyChatModel({ id: '', type: 'chat' })).toBe(false)
  })
})

describe('parseLoomyEnvelope：业务信封', () => {
  it('code=000000 时 ok 为 true 并取出 data', () => {
    const result = parseLoomyEnvelope<{ n: number }>({
      code: LOOMY_OK_CODE, desc: '成功', trace_id: 't', data: { n: 1 },
    })
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ n: 1 })
  })

  it('code=100002 时 ok 为 false 且 message 用服务端 desc', () => {
    const result = parseLoomyEnvelope({
      code: LOOMY_AUTH_ERROR_CODE, desc: '登录已失效，请重新登录', trace_id: 't', data: {},
    })
    expect(result.ok).toBe(false)
    expect(result.message).toBe('登录已失效，请重新登录')
  })

  it('非对象/缺 code 时 ok 为 false 且给出可读 message', () => {
    expect(parseLoomyEnvelope(null).ok).toBe(false)
    expect(parseLoomyEnvelope('oops').ok).toBe(false)
    expect(parseLoomyEnvelope({}).ok).toBe(false)
  })
})

describe('凭据过期判定', () => {
  const base: LoomyCredential = {
    access_token: 'a'.repeat(32), userid: 'u1', phone: '13011112222',
  }

  it('expires_at 是毫秒时间戳**字符串**', () => {
    expect(credentialExpiresAtMs({ ...base, expires_at: '1790357492696' }))
      .toBe(1790357492696)
  })

  it('缺 expires_at / 非法值返回 undefined（不编造）', () => {
    expect(credentialExpiresAtMs(base)).toBeUndefined()
    expect(credentialExpiresAtMs({ ...base, expires_at: 'abc' })).toBeUndefined()
  })

  it('过期判定：无 expires_at 视为不过期', () => {
    expect(isLoomyExpired(base)).toBe(false)
    expect(isLoomyExpired({ ...base, expires_at: String(Date.now() - 1000) })).toBe(true)
    expect(isLoomyExpired({ ...base, expires_at: String(Date.now() + 100_000) })).toBe(false)
  })

  /**
   * ⚠️ Loomy **没有任何 refresh 端点**（实测：登录时向服务端声明
   * `expire: 1209600` 即 14 天，凭据只有 session/userid/phone/updatedAt）。
   * 故 refreshable 恒 false —— 这是诚实标记，不是遗漏。
   */
  it('isLoomyRefreshable 恒为 false（Loomy 无续期端点）', () => {
    expect(isLoomyRefreshable(base)).toBe(false)
    expect(isLoomyRefreshable({ ...base, expires_at: String(Date.now() + 1e9) })).toBe(false)
  })
})

/**
 * 两套认证头 —— 本 provider 最容易踩的坑。
 *
 * 实测交叉验证（2026-09-26）：
 *   GET /models            + Bearer → 200 + `100002 缺少 token`
 *   POST /chat/completions + token  → `100002 缺少 token`
 * 故两个头**都要发**（官方 `llm-completion.js:149-151` 也这么做）。
 */
describe('认证头', () => {
  it('业务端点带 token，且不带 Authorization', () => {
    const headers = loomyBusinessHeaders('S')
    expect(headers.token).toBe('S')
    expect(headers.Authorization).toBeUndefined()
  })

  it('chat 端点两个头都带，且 Bearer 前缀必需', () => {
    const headers = loomyChatHeaders('S')
    expect(headers.token).toBe('S')
    expect(headers.Authorization).toBe('Bearer S')
  })
})
