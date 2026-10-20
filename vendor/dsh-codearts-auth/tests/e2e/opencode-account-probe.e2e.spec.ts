/**
 * opencode 账号通道 e2e（默认跳过）。
 *
 * 闸门：`DSH_OPENCODE_ACCOUNT_E2E=1` + `DSH_OPENCODE_ACCOUNT_E2E_CONFIRM=yes`，
 * 且必须在环境里给 `DSH_OPENCODE_API_KEY`（**不落盘、不写进仓库**）。
 *
 * ⚠️ 这个通道消耗**付费**额度（虽然免费模型本身不花钱，但走 key 通道），
 * 故比匿名通道多一道确认开关。
 */
import { describe, expect, it } from 'vitest'
import { OpencodeAdapter, clearOpencodeCatalogCache } from '../../src/opencode-adapter.js'
import { listIdentitySlots, newAccountFingerprint, type PoolEntrySnapshot } from '../../src/opencode-auth.js'
import { OPENCODE } from '../../src/opencode-product.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const key = process.env.DSH_OPENCODE_API_KEY
const enabled = process.env.DSH_OPENCODE_ACCOUNT_E2E === '1'
  && process.env.DSH_OPENCODE_ACCOUNT_E2E_CONFIRM === 'yes'
  && typeof key === 'string' && key.length > 0
const suite = enabled ? describe : describe.skip

function entry(): PoolEntrySnapshot {
  return { id: 'opencode-e2e', enabled: true, apiKey: key!, fingerprint: newAccountFingerprint(key!) }
}

suite('opencode 账号通道 e2e', () => {
  it('目录可拉到，且付费模型对账号槽可见', async () => {
    clearOpencodeCatalogCache()
    const adapter = new OpencodeAdapter({
      identitySlots: async () => listIdentitySlots([entry()], 'opencode/1.18.22'),
      fetchRemoteCatalog: (slot, signal) => fetch(`${OPENCODE.baseUrl}${OPENCODE.modelsPath}`, {
        headers: { authorization: `Bearer ${slot.apiKey}` },
        ...signal === undefined ? {} : { signal },
      }),
    })
    const models = await adapter.listModels('opencode')
    expect(models.length).toBeGreaterThan(0)
  }, 30_000)

  it('用账号 key 发一条最小消息', async () => {
    clearOpencodeCatalogCache()
    const adapter = new OpencodeAdapter({
      identitySlots: async () => listIdentitySlots([entry()], 'opencode/1.18.22'),
    })
    const chunks: string[] = []
    const options = {
      provider: 'opencode',
      model: 'big-pickle',
      messages: [{ role: 'user', content: [{ type: 'text', text: '回复两个字：ok' }] }],
      system: '',
      tools: [],
    } as unknown as GenerateOptions
    for await (const chunk of adapter.stream(options)) {
      if (chunk.type === 'text-delta') chunks.push(chunk.text)
    }
    expect(chunks.join('').length).toBeGreaterThan(0)
  }, 60_000)

  it('⚠️ 付费模型没有账号槽时报「缺账号」而不是「额度用尽」', async () => {
    // 这是 Task 7 修掉的真实语义问题：混成配额错误会让用户以为要等额度恢复。
    clearOpencodeCatalogCache()
    const anonOnly = new OpencodeAdapter({
      identitySlots: async () => listIdentitySlots([], 'opencode/1.18.22'),
    })
    const options = {
      provider: 'opencode',
      model: 'claude-opus-4-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      system: '',
      tools: [],
    } as unknown as GenerateOptions
    await expect(anonOnly.stream(options).next()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  }, 15_000)
})
