import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const index = readFileSync(join(here, '../../src/index.ts'), 'utf8')

describe('index.ts 接线', () => {
  it('注册 opencode 适配器', () => {
    expect(index).toMatch(/registerOpencodeLlm\(/)
  })
  it('modelAdapters 含 opencode（「显示列表」要用，否则面板只显示裸 id）', () => {
    // ⚠️ 2026-10-06 复审 !66：登记项经 `pruned(...)` 包装（致命缺陷修复之一），
    // 否则 Jet Hub 拿到原始实例、看不到「已失效模型」剔除。
    expect(index).toMatch(/opencode:\s*pruned\([^)]*,\s*opencodeAdapter\)/)
  })
  it('账号槽从账号池读（保持手动排序）', () => {
    expect(index).toMatch(/pool\.listAccountsByProvider\(OPENCODE\.id\)/)
  })
  it('⚠️ index.ts 不再单独注册 opencode RPC（由 jet-hub-rpc 的 handleMethod 统一分派）', () => {
    // 真机报障「unknown method: opencode.addAnonymous」的根因：曾在这里调
    // registerOpencodeRpc 走 `rpc.register`，而 Jet Hub **唯一**通道是
    // `jet-hub-rpc.ts` 的 `connection.fetch.register` → handleMethod，
    // 它的 switch `default` 直接回 unknown method 且不让路。
    // 代码行里不得再出现该调用（注释里的说明不算）。
    const code = index.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(code).not.toMatch(/registerOpencodeRpc\(/)
  })
  it('⚠️ 不在 opencode 接线块里硬写 provider id 字面量（统一用 OPENCODE.id）', () => {
    const at = index.indexOf('registerOpencodeLlm(')
    const block = index.slice(at, at + 2200)
    // 允许注释里出现字面量，但代码里不能出现 'opencode' 单引号字面量
    const code = block.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(code).not.toMatch(/'opencode'/)
  })
  it('⚠️ 指纹代次以池为权威重算（漏这一步会让「轮换」按钮点了没反应）', () => {
    const at = index.indexOf('registerOpencodeLlm(')
    const block = index.slice(at, at + 2600)
    expect(block).toMatch(/opencodeFingerprintGenerationFor\(/)
    expect(block).toMatch(/deriveProjectId\(/)
  })
  it('⚠️ 匿名通道是池内条目 ⇒ 受限标记要落盘（否则面板看不到、也无法重测清除）', () => {
    // 2026-10-02 起匿名通道不再进程内合成，它有账号条目，
    // 所以 markLimited 应当**照常落盘**（旧实现对匿名槽直接 return，重启即丢）。
    const at = index.indexOf('registerOpencodeLlm(')
    const block = index.slice(at, at + 3000)
    expect(block).toMatch(/updateModelRateLimit\(slotId, modelId, resetAtMs\)/)
    expect(block).not.toMatch(/slotId === ANONYMOUS_SLOT_ID\s*\)\s*return/)
  })
  it('⚠️ 匿名槽的指纹 identity 用条目 id（api_key 全是 public，不可用）', () => {
    const at = index.indexOf('registerOpencodeLlm(')
    const block = index.slice(at, at + 2600)
    expect(block).toMatch(/const identity = apiKey === OPENCODE\.anonymousKey \? entry\.id : apiKey/)
  })
  it('⚠️ 启动时保证至少有一条匿名通道（零账号也能用免费模型）', () => {
    expect(index).toMatch(/ensureDefaultAnonymousSlot\(/)
    // ⚠️ 判据必须是「池里有没有匿名条目」而非「有没有账号」——
    // 用户主动删光匿名通道后不该每次启动又被塞回来（删除会像失灵）。
    expect(index).toMatch(/-anon-/)
  })
  it('dispose 时关闭代理 dispatcher（否则进程退出前会挂住）', () => {
    expect(index).toMatch(/closeAllProxyDispatchers/)
  })
})
