/**
 * opencode 匿名通道 e2e（默认跳过）。
 *
 * 闸门：`DSH_OPENCODE_E2E=1` + `DSH_OPENCODE_CHAT_E2E_CONFIRM=yes`
 * 双开关（沿用本仓库 e2e 惯例，见 tests/e2e/README.md）。
 *
 * ⚠️ 消耗匿名免费额度，故必须有显式确认开关。
 * ⚠️ 本文件**不发请求**除非双开关都开：`enabled` 为 false 时整套 suite skip。
 */
import { describe, expect, it } from 'vitest'
import { OpencodeAdapter, clearOpencodeCatalogCache } from '../../src/opencode-adapter.js'
import { listIdentitySlots } from '../../src/opencode-auth.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const enabled = process.env.DSH_OPENCODE_E2E === '1'
  && process.env.DSH_OPENCODE_CHAT_E2E_CONFIRM === 'yes'
const suite = enabled ? describe : describe.skip

/** 用匿名槽跑一次流式请求，返回拼接后的正文。 */
async function ask(model: string, text: string): Promise<string> {
  clearOpencodeCatalogCache()
  const adapter = new OpencodeAdapter({
    identitySlots: async () => listIdentitySlots([], 'opencode/1.18.22'),
  })
  const chunks: string[] = []
  const options = {
    provider: 'opencode',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    system: '',
    tools: [],
  } as unknown as GenerateOptions
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
  }
  return chunks.join('')
}

suite('opencode 匿名通道 e2e', () => {
  it('目录可拉到（只含免费模型）', async () => {
    clearOpencodeCatalogCache()
    const adapter = new OpencodeAdapter({
      identitySlots: async () => listIdentitySlots([], 'opencode/1.18.22'),
      fetchRemoteCatalog: (slot) => fetch('https://opencode.ai/zen/v1/models', {
        headers: { authorization: `Bearer ${slot.apiKey}` },
      }),
    })
    const models = await adapter.listModels('opencode')
    expect(models.length).toBeGreaterThan(0)
    // 匿名槽只应看到免费模型（付费模型对它是不可用的）
    expect(models.every((m) => !m.id.startsWith('claude'))).toBe(true)
  }, 30_000)

  it('伪装头被接受：发一条最小消息拿到正文', async () => {
    const text = await ask('big-pickle', '回复两个字：ok')
    expect(text.length).toBeGreaterThan(0)
  }, 60_000)

  it('⚠️ 形状门禁未被触发（FreeTierError 说明伪装失效，需更新）', async () => {
    // 上一条能过就说明门禁 OK；这里显式再发一次并把错误分类打出来，
    // 便于真机排查时一眼看出是「额度」还是「形状」问题。
    try {
      const text = await ask('big-pickle', 'ping')
      expect(text.length).toBeGreaterThan(0)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console
      console.error('[opencode e2e] 真实失败信息：', message)
      throw error
    }
  }, 60_000)
})
