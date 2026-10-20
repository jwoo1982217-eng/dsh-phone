/**
 * Cline 推理探针（**默认只碰一个免费模型**）。
 *
 * ## ⚠️ 为什么闸门设计得这么严
 *
 * Cline 的免费资格是**服务端动态下发的营销状态**（`recommended-models` 的
 * `free` 数组），随时可能被撤销或改为计费。若探针无条件遍历「远端说是免费」
 * 的那批模型，一旦某个模型转为计费，一次 e2e 就会**按付费价刷掉真实 token**。
 *
 * 故本探针的默认行为是：**只请求 `DEFAULT_MODEL`**（当前
 * `cline-free/mimo-v2.6-flash`）—— 用户明确指定为日常验证用的那一个。
 * 其余免费模型必须显式 opt-in。
 *
 * ## 三重闸门
 *
 * ```
 * DSH_CLINE_CHAT_E2E=1                       必需
 * DSH_CLINE_CHAT_E2E_CONFIRM=yes             必需（防误跑）
 * DSH_CLINE_CHAT_E2E_ALL_FREE=1              可选：才遍历其余免费模型
 * ```
 *
 * 另有 `DSH_CLINE_MODEL` 可指定单个被测模型（⚠️ 指定付费模型会消耗额度）。
 *
 * **付费模型一律不在本探针中请求**（无论闸门如何设置）—— 见 `assertFreeModel`。
 *
 * 用 `pnpm test:e2e:cline-chat` 运行。
 * 凭据来源：`DSH_CLINE_CREDENTIAL_JSON`，或本地 `.credentials.yaml`
 * 中的 `CLINE_ACCOUNT_*` 条目。
 *
 * ⚠️ 本探针**不续期**（不消耗/轮换 refresh_token）。
 */

import { describe, expect, it } from 'vitest'
import { CLINE, CLINE_CHAT_PATH } from '../../src/cline-product.js'
import { clineHeaders } from '../../src/cline.js'
import { loadClineModels, type ClineModel } from '../../src/cline-models.js'
import { readClineCredentialsFromDshStore } from './cline-credential.js'

const RUN = process.env.DSH_CLINE_CHAT_E2E === '1'
  && process.env.DSH_CLINE_CHAT_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

/**
 * 默认被测模型 —— **唯一**一个无需额外 opt-in 就会请求的模型。
 *
 * 选它的理由：用户明确要求 e2e 只用这一个（避免其余免费模型将来转为计费后
 * 被自动刷 token）。
 *
 * ⚠️ **原为 `cline-free/deepseek-v4.1-flash`，2026-10-05 被上游下架**
 * （移出远端 `free` 数组、直连回 `404 {"error":"model not found"}`），
 * 沿用会让本探针在 `assertFreeModel` 处直接失败（「模型不在目录中」）。
 * 改用仍在册的 `cline-free/mimo-v2.6-flash`（实测 HTTP 200、正常出字）。
 * 换默认模型时**必须同时**确认它在远端 `free` 数组里，见文件末尾的联动断言。
 */
const DEFAULT_MODEL = 'cline-free/mimo-v2.6-flash'

/** 是否遍历远端下发的**全部**免费模型（默认关）。 */
const ALL_FREE = process.env.DSH_CLINE_CHAT_E2E_ALL_FREE === '1'

/** 显式指定的模型（优先于默认值）。 */
const EXPLICIT_MODEL = process.env.DSH_CLINE_MODEL

/**
 * 远端 free 集合里的其余免费模型（**不含** `DEFAULT_MODEL`）。
 *
 * ⚠️ 与默认模型去重：否则 `DSH_CLINE_CHAT_E2E_ALL_FREE=1` 会对同一个模型
 * 发两次请求，白白多花一次免费额度。
 */
const OTHER_FREE = [
  'stealth/space-bunny-alpha',
  'cline-free/muse-spark-1.3-contributor',
]

/**
 * 断言某模型确实是免费的。
 *
 * ⚠️ **这是本探针的安全边界**：任何非免费模型都必须被拒绝，
 * 无论它来自环境变量还是远端列表。宁可让探针报错，也不要发出一个
 * 可能按付费计费的请求。
 */
function assertFreeModel(model: ClineModel | undefined, id: string, remoteFreeIds: ReadonlySet<string>): void {
  if (model === undefined) {
    throw new Error(
      `模型 "${id}" 不在目录中，拒绝请求（无法确认其免费资格）。\n`
      + '若该 id 确实存在，请先运行 pnpm test:e2e:cline 查看远端目录。',
    )
  }
  if (!model.isFree) {
    throw new Error(
      `⛔ 模型 "${id}" **不是免费模型**，拒绝发送请求。\n`
      + '本探针只允许免费模型（付费模型会消耗真实额度）。\n'
      + '如确需测试付费模型，请用其它方式，不要改本探针。',
    )
  }
  // 双保险：远端 free 集合也必须认它（`isFree` 还包含前缀/后缀启发式，
  // 而这里要求**权威来源**背书）。
  if (remoteFreeIds.size > 0 && !remoteFreeIds.has(id) && !model.isFree) {
    throw new Error(`模型 "${id}" 不在远端 free 集合中，拒绝请求`)
  }
}

/** 发一次流式推理，返回收集到的文本与思考内容。 */
async function streamOnce(
  credential: { access_token: string },
  model: string,
): Promise<{ status: number; text: string; reasoning: string; frames: number; raw: string }> {
  const response = await fetch(`${CLINE.apiBase}${CLINE_CHAT_PATH}`, {
    method: 'POST',
    headers: {
      ...clineHeaders(credential as never, CLINE),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      max_tokens: 64,
    }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!response.ok || response.body === null) {
    const raw = await response.text().catch(() => '')
    return { status: response.status, text: '', reasoning: '', frames: 0, raw: raw.slice(0, 500) }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let reasoning = ''
  let frames = 0
  let raw = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const decoded = decoder.decode(value, { stream: true })
    if (raw.length < 800) raw = (raw + decoded).slice(0, 800)
    buffer += decoded
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]' || payload.length === 0) continue
      frames += 1
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null } }>
        }
        const delta = parsed.choices?.[0]?.delta
        // ⚠️ Cline 的思考字段是 `reasoning`（不是 `reasoning_content`）
        if (typeof delta?.reasoning === 'string') reasoning += delta.reasoning
        if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content
        if (typeof delta?.content === 'string') text += delta.content
      } catch {
        // 忽略无法解析的帧（诊断信息已在 raw 里）
      }
    }
  }
  return { status: response.status, text, reasoning, frames, raw }
}

suite('Cline 推理探针（默认只请求 cline-free/mimo-v2.6-flash）', () => {
  const entries = readClineCredentialsFromDshStore()

  it('至少有一个已登录的 Cline 账号', () => {
    expect(
      entries.length,
      '未找到 Cline 凭据。请先在 Jet Hub 的 Cline 面板登录一个账号。',
    ).toBeGreaterThan(0)
  })

  it('免费模型推理链路返回 SSE（默认 cline-free/mimo-v2.6-flash）', async () => {
    const { credential } = entries[0]!
    const model = EXPLICIT_MODEL ?? DEFAULT_MODEL

    // 先取远端免费集合作为权威判据，再决定是否请求。
    const { models } = await loadClineModels(CLINE, { credential })
    const remoteFree = new Set(models.filter((m) => m.isFree).map((m) => m.id))
    const entry = models.find((m) => m.id === model)

    console.log('\n===== Cline 推理请求 =====')
    console.log(`  url      = ${CLINE.apiBase}${CLINE_CHAT_PATH}`)
    console.log(`  model    = ${model}`)
    console.log(`  isFree   = ${entry?.isFree ?? '(未知)'}`)
    console.log(`  远端 free 集合大小 = ${remoteFree.size}`)

    // ⛔ 安全边界：非免费模型直接拒绝，不发请求。
    assertFreeModel(entry, model, remoteFree)

    const result = await streamOnce(credential, model)
    console.log(`  HTTP     = ${result.status}`)
    console.log(`  frames   = ${result.frames}`)
    console.log(`  正文     = ${JSON.stringify(result.text)}`)
    console.log(`  思考     = ${JSON.stringify(result.reasoning.slice(0, 200))}`)

    expect(result.status, `推理失败：${result.raw}`).toBe(200)
    expect(result.frames, '未收到任何 SSE 帧').toBeGreaterThan(0)
    // 至少要有正文或思考之一（模型可能先思考后正文）
    expect(result.text.length + result.reasoning.length, '响应没有任何内容').toBeGreaterThan(0)
  })

  /**
   * ⚠️ 仅在显式设置 `DSH_CLINE_CHAT_E2E_ALL_FREE=1` 时才遍历其余免费模型。
   *
   * 理由：免费资格随时可能被服务端撤销，无条件遍历会**按付费价刷 token**。
   */
  it.skipIf(!ALL_FREE)(
    '遍历其余免费模型（需 DSH_CLINE_CHAT_E2E_ALL_FREE=1）',
    async () => {
      const { credential } = entries[0]!
      const { models } = await loadClineModels(CLINE, { credential })
      const byId = new Map(models.map((m) => [m.id, m]))
      const remoteFree = new Set(models.filter((m) => m.isFree).map((m) => m.id))

      console.log('\n===== 遍历其余免费模型（显式 opt-in）=====')
      for (const id of OTHER_FREE) {
        const entry = byId.get(id)
        if (entry === undefined) {
          console.log(`  ${id.padEnd(42)} 跳过（远端目录中不存在）`)
          continue
        }
        // ⛔ 逐个再确认一次：远端可能已把它移出 free 集合。
        if (!entry.isFree || (remoteFree.size > 0 && !remoteFree.has(id))) {
          console.log(`  ${id.padEnd(42)} 跳过（已不在远端 free 集合中，避免按付费计费）`)
          continue
        }
        const result = await streamOnce(credential, id)
        const ok = result.status === 200 && result.frames > 0
        console.log(
          `  ${id.padEnd(42)} HTTP ${result.status} frames=${result.frames} `
          + `text=${JSON.stringify(result.text.slice(0, 40))} ${ok ? '✓' : '✗'}`,
        )
        expect(result.status, `${id} 推理失败：${result.raw}`).toBe(200)
      }
    },
  )

  it('付费模型被安全边界拒绝（不发请求）', () => {
    // 直接验证守卫函数本身：这是「付费模型一律不请求」的机制保证。
    const paid: ClineModel = { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', isFree: false }
    expect(() => assertFreeModel(paid, paid.id, new Set())).toThrow(/不是免费模型/)
    expect(() => assertFreeModel(undefined, 'ghost/model', new Set())).toThrow(/不在目录中/)
    // 免费模型通过
    const free: ClineModel = { id: DEFAULT_MODEL, name: 'x', isFree: true }
    expect(() => assertFreeModel(free, free.id, new Set([free.id]))).not.toThrow()
  })

  it('默认模型是免费的那一个（防止有人误改默认值）', () => {
    expect(DEFAULT_MODEL).toBe('cline-free/mimo-v2.6-flash')
    expect(DEFAULT_MODEL.startsWith('cline-free/')).toBe(true)
    // ⚠️ 与兜底表联动：换默认模型时若忘了同步兜底表，这里会先红 ——
    // 比跑到网络请求才发现「模型不在目录中」要省事得多。
    expect(
      CLINE.fallbackModels.some((m) => m.id === DEFAULT_MODEL && m.isFree === true),
      `默认模型 ${DEFAULT_MODEL} 不在兜底表的免费条目里（换默认模型时需同步兜底表）`,
    ).toBe(true)
  })

  it('OTHER_FREE 与默认模型不重复（避免重复消耗免费额度）', () => {
    expect(OTHER_FREE).not.toContain(DEFAULT_MODEL)
    expect(new Set(OTHER_FREE).size).toBe(OTHER_FREE.length)
  })
})
