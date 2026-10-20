import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const index = readFileSync(join(here, '../../src/index.ts'), 'utf8')
const hybrid = readFileSync(join(here, '../../src/opencode-hybrid-adapter.ts'), 'utf8')
const at = index.indexOf('const opencodeLocalRef =')
const end = index.indexOf('// 保留手机版原有的 OrcaTerm 接线', at)
expect(at).toBeGreaterThan(0)
expect(end).toBeGreaterThan(at)
const block = index.slice(at, end)

describe('index.ts 的手机 OpenCode 本地与快通道接线', () => {
  it('同一 provider 注册混合适配器，保留原本地服务与适配器实例', () => {
    expect(block).toMatch(/new OpencodeLocalService\(/)
    expect(block).toMatch(/new OpencodeLocalAdapter\(opencodeLocal,/)
    expect(block).toMatch(/new OpencodeHybridAdapter\(opencodeLocalAdapter, opencodeInferenceAdapter,/)
    expect(block).toMatch(/registerAdapterIdempotent\(ctx\.llm, \[OPENCODE\.id\], opencodeAdapter\)/)
  })
  it('全量模型目录仍经过原来的失效模型过滤器', () => {
    expect(index).toMatch(/opencode:\s*pruned\([^)]*,\s*opencodeAdapter\)/)
  })
  it('原生服务身份仍读写本机凭据引用，不挪用 Zen 的账号池 key', () => {
    expect(block).toMatch(/credentialRef\('OPENCODE_LOCAL_SERVER'\)/)
    expect(block).toMatch(/ctx\.credentials\.resolve\(opencodeLocalRef\)/)
    expect(block).toMatch(/saveAuth: auth => ctx\.credentials\.set\(opencodeLocalRef, JSON\.stringify\(auth\)\)/)
  })
  it('RPC 继续由 JetHub 单一入口分派，混合适配器委托本地服务', () => {
    const code = index.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n')
    expect(code).not.toMatch(/registerOpencodeRpc\(/)
    expect(hybrid).toMatch(/return this\.local\.handleRpc\(method, payload\)/)
  })
  it('两条通道共享同一个 provider 的模型黑名单', () => {
    expect(block.match(/disabledModels: \(\) => pool\.disabledModelsFor\(OPENCODE\.id\)/g)).toHaveLength(2)
  })
  it('本地目录变化继续广播，快通道能力只在后台刷新', () => {
    expect(block).toMatch(/onCatalogChanged:[\s\S]*ctx\.emit\('llm\/adapters-updated'\)/)
    expect(block).toMatch(/primeOpencodeCapabilities\(\)/)
    expect(block).toMatch(/refreshOpencodeCapabilities\(\(\) => ctx\.emit\('llm\/adapters-updated'\)\)/)
    expect(block).not.toMatch(/await\s+(prime|refresh)OpencodeCapabilities/)
  })
  it('原生与快通道都获得既有附件桥接', () => {
    expect(block.match(/readImage:\s*makeReadImage\(ctx\)/g)).toHaveLength(2)
  })
  it('匿名快通道固定 public，不读取或修改手机账号池记录', () => {
    expect(hybrid).toMatch(/apiKey: OPENCODE\.anonymousKey/)
    expect(hybrid).toMatch(/kind: 'anonymous'/)
    expect(hybrid).not.toMatch(/pool\.(addAccount|updateAccount|removeAccount)/)
  })
  it('准备调用绑定实际选中的适配器，目录更新不能跨代发送', () => {
    expect(hybrid).toMatch(/async prepareCall\(/)
    expect(hybrid).toMatch(/return adapter\.prepareCall\(provider, model, signal\)/)
  })
  it('卸载回收本地服务与代理连接', () => {
    expect(block).toMatch(/ctx\.effect\(\(\) => \(\) => opencodeLocal\.dispose\(\)\)/)
    expect(index).toMatch(/closeAllProxyDispatchers/)
  })
})
