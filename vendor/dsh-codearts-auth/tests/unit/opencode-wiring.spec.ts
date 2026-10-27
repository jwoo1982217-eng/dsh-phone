import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const index = readFileSync(join(here, '../../src/index.ts'), 'utf8')

describe('index.ts 接线', () => {
  it('注册 opencode 适配器', () => {
    expect(index).toMatch(/new OpencodeLocalAdapter\(opencodeLocal, \{/ )
    expect(index).toContain('const opencodeAdapter = opencodeLocalAdapter')
    expect(index).toMatch(/registerAdapterIdempotent\(ctx\.llm, \[OPENCODE\.id\], opencodeAdapter\)/)
  })
  it('modelAdapters 含 opencode（「显示列表」要用，否则面板只显示裸 id）', () => {
    // ⚠️ 2026-10-06 复审 !66：登记项经 `pruned(...)` 包装（致命缺陷修复之一），
    // 否则 Jet Hub 拿到原始实例、看不到「已失效模型」剔除。
    expect(index).toMatch(/opencode:\s*pruned\([^)]*,\s*opencodeAdapter\)/)
  })
  it('账号槽从账号池读（保持手动排序）', () => {
    const local = readFileSync(join(here, '../../src/opencode-local-native.ts'), 'utf8')
    expect(index).toContain("credentialRef('OPENCODE_LOCAL_SERVER')")
    expect(local).toContain('readAuth')
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
  it('原生注册仍用统一 id，且关闭/图片/黑名单接在同一实例', () => {
    const at = index.indexOf('new OpencodeLocalAdapter(')
    const end = index.indexOf('const opencodeAdapter =', at)
    expect(at).toBeGreaterThan(0)
    const block = index.slice(at, end)
    expect(block).toContain('providerClosedFor(OPENCODE.id)')
    expect(block).toContain('disabledModelsFor(OPENCODE.id)')
    expect(block).toContain('readImage: makeReadImage(ctx)')
  })
  it('上游账号探针继续从 entry 取指纹代次和代理，不复制派生实现', () => {
    const at = index.indexOf('createProbeAdapter:', index.indexOf('  opencode: {'))
    const block = index.slice(at, index.indexOf('/** 注册 codeartsAuth', at))
    expect(block).toContain('poolEntrySnapshot({')
    expect(block).toContain('generation: entry?.opencodeFingerprintGeneration')
    expect(block).toContain('proxy: entry?.opencodeProxy')
  })
  it('本机服务生命周期随宿主释放，原生 RPC 仍能操作', () => {
    expect(index).toContain('ctx.effect(() => () => opencodeLocal.dispose())')
    expect(index).toContain('handleRpc:')
  })
  it('⚠️ 匿名槽的指纹 identity 用条目 id（api_key 全是 public，不可用）', () => {
    // ⚠️ 2026-10-08：这条规则**从 `index.ts` 搬进了 `opencode-auth.ts`**。
    //    原因是探测路径也需要造槽 ⇒ 若在 `index.ts` 里再写一份就是
    //    「同一语义两处实现」，而分叉的表现只是「多个匿名通道指纹相同」——
    //    **不报错**。断言随之改指唯一实现处；`index.ts` 那一侧改为断言
    //    「它调用的是那个唯一实现」（见上面的代次用例）。
    const auth = readFileSync(join(here, '../../src/opencode-auth.ts'), 'utf8')
    expect(auth).toMatch(/isAnonymousCredential\(source\.apiKey\) \? source\.id : source\.apiKey/)
    // 反向：接线块不该再有自己那份 identity 派生（两处实现即红线）。
    const at = index.indexOf('createProbeAdapter:', index.indexOf('  opencode: {'))
    const block = index.slice(at, at + 2600)
    expect(block).not.toMatch(/const identity = apiKey === OPENCODE\.anonymousKey/)
    expect(block).toMatch(/poolEntrySnapshot\(/)
  })
  it('原生默认通道不在启动时擅自新建匿名账号，显式匿名入口仍保留', () => {
    const code = index.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/ensureDefaultAnonymousSlot\(/)
    const rpc = readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8')
    expect(rpc).toContain('opencode.addAnonymous')
    // ⚠️ 判据必须是「池里有没有匿名条目」而非「有没有账号」——
    // 用户主动删光匿名通道后不该每次启动又被塞回来（删除会像失灵）。
    const auth = readFileSync(join(here, '../../src/opencode-auth.ts'), 'utf8')
    expect(auth).toContain('-anon-')
  })
  it('dispose 时关闭代理 dispatcher（否则进程退出前会挂住）', () => {
    expect(index).toMatch(/closeAllProxyDispatchers/)
  })
})
