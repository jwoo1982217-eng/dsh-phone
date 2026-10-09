/**
 * TRAE 思考档位 e2e 探针（issue IKI7WT/IKILR7「模型缺少思考强度」的回归闸门）。
 *
 * ⚠️ **会消耗模型额度**：本文件的第 2、3 条用例真的向 TRAE 发对话请求
 * （各一次，`maxTokens` 压到 64）。故用**两道闸门**：
 * `DSH_TRAE_REASONING_E2E=1` **且** `DSH_TRAE_REASONING_E2E_CONFIRM=yes`。
 * 只设前者时整体 skip —— 目录类断言已由单测覆盖，这里要证明的是
 * 「真发得出去、且不回流内 4001」。
 *
 * 为什么必须实测这两件事：
 * - 修好合并规则后，`deepseek-v4.1-flash` 的通道从 `solo_work_lite` 变为
 *   `solo_agent`（档位与 `function` 必须同源）。**通道变了就有 4001 风险**
 *   （上游：模型只在列出它的通道里可调用）；
 * - `reasoning_effort` 是本缺陷要恢复的载荷，必须确认它被接受。
 */
import { describe, expect, it } from 'vitest'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { TRAE } from '../../src/trae-product.js'
import {
  TRAE_BATCH_MODELS_PATH,
  parseTraeBatchModelList,
  traeSOLOHeaders,
} from '../../src/trae.js'
import { readTraeCredentialsFromDshStore } from './trae-credential.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const enabled = process.env.DSH_TRAE_REASONING_E2E === '1'
  && process.env.DSH_TRAE_REASONING_E2E_CONFIRM === 'yes'
const d = enabled ? describe : describe.skip

/** 本探针覆盖的模型：用户日常在用的那个（issue 里点名的就是它）。 */
const MODEL = 'deepseek-v4.1-flash'

d('E2E-TRAE-REASONING（消耗额度）', () => {
  const entry = readTraeCredentialsFromDshStore()[0]

  /** 与 `TraeAuth.fetchModels` 同款的真实批量拉取。 */
  async function fetchLive() {
    const credential = entry!.credential as unknown as Record<string, unknown>
    const res = await fetch(`${TRAE.agentHost}${TRAE_BATCH_MODELS_PATH}`, {
      method: 'POST',
      headers: traeSOLOHeaders(credential as never, TRAE, false) as Record<string, string>,
      body: JSON.stringify({
        functions: [
          'ui_builder_v2', 'solo_coder', 'chat_v3', 'solo_builder',
          'builder_v3', 'builder', 'chat', 'inline_chat', 'git_ai',
          'custom_agent_generation', 'utils', 'code_reviewer',
          'code_review_summary', 'solo_agent', 'solo_agent_remote',
          'solo_work_remote', 'solo_agent_lite', 'solo_work_lite',
          'solo_design_lite', 'solo_design_remote', 'multimodal',
          'system_diagnosis',
        ],
        agent_type: '',
        current_config_info: { config_name: '', is_custom_model: false },
        mode_type: 0, access_type: 0, ab_force_vids: '', ab_autotest_advanced_mode: 0,
        show_custom_model: true,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return parseTraeBatchModelList(await res.json() as unknown)
  }

  it('档位不再被空档位条目覆盖（13 个模型的缺陷回归）', async () => {
    const all = await fetchLive()
    const byId = new Map(all.map((m) => [m.id, m]))
    // 这些模型在真实目录里**至少有一个通道**声明了 options；修复前它们
    // 被排在最后的 `solo_work_lite` / `solo_design_*` 空条目覆盖成 options=[]。
    for (const id of ['deepseek-v4.1-flash', 'glm-5.2', 'glm-5.3', 'kimi-k3', 'qwen3.8-max']) {
      const model = byId.get(id)
      expect(model, `${id} 应在目录中`).toBeDefined()
      expect(model!.reasoningConfig?.options.length ?? 0, `${id} 的思考档位`).toBeGreaterThan(0)
      expect(model!.reasoningConfig?.supportThinking, id).not.toBe(false)
    }
    // 档位与通道必须同源：选中的条目就是声明档位的那条。
    expect(byId.get(MODEL)!.function, `${MODEL} 应路由到声明档位的通道`).toBe('solo_agent')
  })

  it('resolveModel 真的声明出档位（UI 不再显示「未提供推理等级」）', async () => {
    const all = await fetchLive()
    const adapter = new TraeAdapter({
      credentialRef: 'TRAE_ACCESS_TOKEN' as never,
      resolveCredential: async () => entry!.credential,
      refresh: async () => {},
      fetchRemoteModels: async () => all,
      product: TRAE,
    })
    const resolved = await adapter.resolveModel('trae', MODEL)
    const efforts = resolved.reasoning?.efforts.map((e) => e.id) ?? []
    console.log(`[trae-reasoning] ${MODEL} efforts = ${JSON.stringify(efforts)} default = ${String(resolved.reasoning?.defaultEffort)}`)
    expect(efforts).toContain('extra_high')
    expect(efforts).toContain('light')
    // 默认档采信上游 `default_level`（实测该模型上游给 `high`），不再一律顶格。
    expect(resolved.reasoning?.defaultEffort, '默认档应采信上游 default_level').toBe('high')
  })

  /**
   * 发一次真实对话，返回 `{ text, error, finishKind }`。
   *
   * ⚠️ **不要断言「正文非空」**：实测（2026-09-26）`extra_high` 下即使给到
   * 4096 额度，正文也可能为空 —— 上游自己的预算很小（`outputTokens` 仅
   * 41~113，几乎全是 `reasoningTokens`），且**同一档位重复调用会随机地**
   * 有时返回「好的」、有时只回思考不吐正文（`finish.reason` 均为 `stop`）。
   * 这是模型行为而非档位被拒，拿它当判据会得到**随机失败**的假阴性。
   *
   * 真正能区分「档位被接受」与「档位被拒」的判据是 `finish.reason`：
   * 档位不合法时上游会走 `max-tokens` 截断或报错，正常接受时是 `stop`。
   */
  async function chat(adapter: TraeAdapter, reasoningEffort?: string): Promise<{ text: string; error: string; finishKind: string }> {
    const chunks: string[] = []
    let error = ''
    let finishKind = ''
    try {
      for await (const c of adapter.stream({
        model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：好的' }] }],
        maxTokens: 4096,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
      } as unknown as GenerateOptions)) {
        const t = c as { type: string; text?: string; reason?: { kind?: string } }
        if (t.type === 'text-delta' && typeof t.text === 'string') chunks.push(t.text)
        if (t.type === 'finish' && typeof t.reason?.kind === 'string') finishKind = t.reason.kind
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    return { text: chunks.join(''), error, finishKind }
  }

  it('新通道（solo_agent）可调用，且 reasoning_effort 被接受', async () => {
    const all = await fetchLive()
    const adapter = new TraeAdapter({
      credentialRef: 'TRAE_ACCESS_TOKEN' as never,
      resolveCredential: async () => entry!.credential,
      refresh: async () => {},
      fetchRemoteModels: async () => all,
      product: TRAE,
    })
    // 1. 不带档位：验证通道迁移本身没把请求打成 4001。
    const plain = await chat(adapter)
    console.log(`[trae-reasoning] 不带档位 → ${JSON.stringify(plain.text.slice(0, 40))} err=${plain.error} finish=${plain.finishKind}`)
    expect(plain.error, '不带档位的请求不该报错').toBe('')
    expect(plain.finishKind, '不带档位应正常结束').toBe('stop')

    await new Promise((r) => setTimeout(r, 3000))

    // 2. 带最高档：验证恢复出来的档位真的能下发、且不报 4001。
    const strong = await chat(adapter, 'extra_high')
    console.log(`[trae-reasoning] extra_high → ${JSON.stringify(strong.text.slice(0, 40))} err=${strong.error} finish=${strong.finishKind}`)
    expect(strong.error, 'reasoning_effort=extra_high 不该报错').toBe('')
    // ⚠️ 判据用 `finish.reason.kind === 'stop'`（正常结束），**不是**「正文非空」：
    // 该档位下上游偶尔只回思考不吐正文（见 `chat` 的注释），断言正文会随机失败；
    // 而档位真被拒时会走 `max-tokens` 截断或直接报错，故 `stop` 是有区分度的。
    expect(strong.finishKind, 'extra_high 应被接受并正常结束（而非被截断/拒绝）').toBe('stop')
  }, 300_000)
})
