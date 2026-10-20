// 端到端验证：真实 batch 目录 + 真实适配器按模型路由通道。
import { describe, expect, it } from 'vitest'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { TRAE } from '../../src/trae-product.js'
import {
  TRAE_BATCH_MODELS_PATH,
  isTraeModelUsable,
  parseTraeBatchModelList,
  traeSOLOHeaders,
} from '../../src/trae.js'
import { readTraeCredentialsFromDshStore } from './trae-credential.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const enabled = process.env.DSH_TRAE_E2E === '1'
const d = enabled ? describe : describe.skip

/** 与 TraeAuth.fetchModels 同款的真实批量拉取。 */
async function fetchLive(credential: Record<string, unknown>) {
  const res = await fetch(`${TRAE.agentHost}${TRAE_BATCH_MODELS_PATH}`, {
    method: 'POST',
    headers: traeSOLOHeaders(credential as never, TRAE, false) as Record<string, string>,
    body: JSON.stringify({
      functions: [...TRAE.channels],
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

d('E2E-TRAE-CHANNELS', () => {
  it('真实目录 + 路由', async () => {
    const { credential } = readTraeCredentialsFromDshStore()[0]!
    const raw = credential as unknown as Record<string, unknown>

    const all = await fetchLive(raw)
    const usable = all.filter(isTraeModelUsable)
    console.log(`目录：合并 ${all.length} 条 → 可用 ${usable.length}`)
    console.log('channels = ' + JSON.stringify(TRAE.channels))
    console.log('可用模型 = ' + JSON.stringify(usable.map((m) => m.id)))

    // 1. agent 专有模型必须在，且通道正确
    //
    // ⚠️ Issue IKJOZ7 后 `glm-5.1` 的通道是 **`solo_coder`**，不再是
    // `solo_agent_remote` —— 它在 `solo_agent*` 里全是 `is_invisible_to_user:
    // true`（被既有硬过滤剔除），故落到第一个既列出它、又未被硬过滤的**可调用**
    // 通道上。这条断言曾写死 `solo_agent_remote`，修复白名单后必然失败。
    const glm51 = usable.find((m) => m.id === 'glm-5.1')
    expect(glm51, 'glm-5.1 应出现在可用目录里').toBeDefined()
    expect(TRAE.channels, 'glm-5.1 的通道必须在可调用白名单内').toContain(glm51!.function)
    expect(glm51!.contextWindow).toBe(200_000)

    // 2. 所有可用条目的通道都必须在白名单内（Issue IKJOZ7 的核心回归断言）
    for (const model of usable) {
      expect(TRAE.channels, `${model.id} 的通道 ${String(model.function)} 不在白名单内`).toContain(model.function)
    }

    // 3. work 专有模型的通道
    //
    // ⚠️ `glm-5-turbo` / `sagitta` / `seed-code-pro-0430` **已从上游下架**
    // （2026-10-04 实测：不在任何 function 里），故这里不能再断言它们存在。
    // 原断言 `turbo?.function === 'solo_work_lite'` 在 `turbo` 为 undefined 时
    // **属于假绿**（`?.` 让整个表达式变 undefined 而不是抛错）。
    //
    // ⚠️ 也不能断言「存在 function === 'solo_work_lite' 的模型」：`solo_work_lite`
    // 列出的模型**同时也在 `solo_agent` 里**，而后者在白名单中更靠前 ⇒ 按优先级
    // 择优后它们全部落在 `solo_agent`。这正是「顺序即优先级」在起作用。
    //
    // 有意义的断言是「**只在专用通道里出现**的模型被保留下来」—— 它同时证明了
    // 白名单没把专用通道一刀切掉（如 multimodal 只服务 `multimodal_image_*`）。
    const specialChannelModel = usable.find((m) => m.function === 'multimodal')
    expect(specialChannelModel, '专用通道（multimodal）的独有模型应被保留').toBeDefined()
    expect(specialChannelModel!.id).toContain('multimodal_image')

    // 3. 不可调用的自定义模型必须被剔除 —— ⚠️ 判据是**标志的值**，不是模型名。
    //
    // 原实现写死了 4 个模型名（`deepseek-v4-flash` / `silk-gpt-5.6-luna` /
    // `glm-5.3-flash` / `agnes-2.5-flash`），那**是 2026-09-19 的快照**：前 3 个已
    // 下架、`glm-5.3-flash` 已转为 `is_custom_model: false` 的**正常可调用**模型
    // （AGENTS.md 早已记录并明确警告「不要再据此删模型」）。照该名单断言会把一个
    // 合法模型判成缺陷。
    for (const model of usable) {
      expect(model.isCustomModel, `${model.id} 是自定义模型，不该出现在可用目录里`).not.toBe(true)
    }
    // 4. 主流模型的远端 max_tokens 已被消费
    const glm52 = usable.find((m) => m.id === 'glm-5.2')
    expect(glm52?.maxOutputTokens).toBe(32_000)
    expect(glm52?.contextWindow).toBe(200_000)

    // 5. hideInternal 模式下目录应与「官方可见集」一致
    //
    // ⚠️ 判据同样是**标志**：原来断言 `ideLike.length < usable.length` 且
    // `not.toContain('glm-5.1')`，但 `glm-5.1` 的 `isHidden` 实测已是 `false`
    // （它被 `is_invisible_to_user` 在**解析阶段**滤掉了，不在 `all` 里），
    // 故该断言在真实数据上不成立。这里断言真正的不变式：hideInternal 的结果里
    // 不得有 `isHidden === true` 的条目，且它是 usable 的子集。
    const ideLike = all.filter((m) => isTraeModelUsable(m, { hideInternal: true }))
    for (const model of ideLike) {
      expect(model.isHidden, `${model.id} 被官方隐藏，不该出现在 hideInternal 结果里`).not.toBe(true)
    }
    expect(ideLike.length).toBeLessThanOrEqual(usable.length)

    // ── 真实适配器：按通道路由 ──
    const adapter = new TraeAdapter({
      credentialRef: 'TRAE_ACCESS_TOKEN' as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      fetchRemoteModels: async () => all,
      product: TRAE,
    })

    async function chat(model: string): Promise<string> {
      const chunks: string[] = []
      let err = ''
      try {
        for await (const c of adapter.stream({
          model,
          messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：好的' }] }],
          maxTokens: 32,
        } as unknown as GenerateOptions)) {
          const t = c as { type: string; text?: string }
          if (t.type === 'text-delta' && typeof t.text === 'string') chunks.push(t.text)
        }
      } catch (e) { err = e instanceof Error ? e.message : String(e) }
      return err !== '' ? `ERR: ${err.slice(0, 80)}` : chunks.join('').slice(0, 40)
    }

    // glm-5.1 必须走**可调用**通道 —— 修复前它取目录给的 `function: 'chat'`，
    // 一发就回 `4023 the model is unknown`（Issue IKJOZ7）。
    const r1 = await chat('glm-5.1')
    console.log(`glm-5.1（通道 ${String(glm51!.function)}）→ ${JSON.stringify(r1)}`)
    expect(r1.startsWith('ERR'), `glm-5.1 不该报错：${r1}`).toBe(false)

    // 反向验证路由不是"一律发同一个通道"：挑一个通道与 glm-5.1 不同的模型。
    const other = usable.find((m) => m.id !== 'glm-5.1' && m.function !== glm51!.function)
    if (other !== undefined) {
      await new Promise((r) => setTimeout(r, 4000))
      const r2 = await chat(other.id)
      console.log(`${other.id}（通道 ${String(other.function)}）→ ${JSON.stringify(r2)}`)
      expect(r2.startsWith('ERR'), `${other.id} 不该报错：${r2}`).toBe(false)
    }

    // 真实拉取的目录里前端应能看到这些模型
    const listed = (await adapter.listModels('trae')).map((m) => m.id)
    console.log(`listModels → ${listed.length} 个`)
    expect(listed).toContain('glm-5.1')
    expect(listed).toContain('glm-5.2')
  }, 600_000)
})
