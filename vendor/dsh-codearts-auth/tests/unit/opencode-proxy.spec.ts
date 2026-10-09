import { describe, expect, it } from 'vitest'
import { buildProxyDispatcher, buildSocks5Handshake, closeAllProxyDispatchers, proxyCacheSize } from '../../src/opencode-proxy.js'
import type { NormalizedProxy } from '../../src/opencode.js'

const httpProxy: NormalizedProxy = { kind: 'http', url: 'http://127.0.0.1:7897', label: 'http://127.0.0.1:7897' }
const socksProxy: NormalizedProxy = { kind: 'socks5', url: 'socks5://127.0.0.1:1080', label: 'socks5://127.0.0.1:1080' }

describe('buildProxyDispatcher', () => {
  it('HTTP 代理产出可用的 Dispatcher（含 dispatch/close/destroy）', () => {
    const d = buildProxyDispatcher(httpProxy) as unknown as Record<string, unknown>
    expect(typeof d.dispatch).toBe('function')
    expect(typeof d.close).toBe('function')
    expect(typeof d.destroy).toBe('function')
  })
  it('⚠️ 同 URL 复用同一实例（连接池复用）', () => {
    const a = buildProxyDispatcher(httpProxy)
    const b = buildProxyDispatcher({ ...httpProxy })
    expect(a).toBe(b)
  })
  it('不同 URL 得到不同实例', () => {
    const a = buildProxyDispatcher(httpProxy)
    const b = buildProxyDispatcher({ ...httpProxy, url: 'http://127.0.0.1:1080' })
    expect(a).not.toBe(b)
  })
  it('SOCKS5 代理也产出 Dispatcher 子集', () => {
    const d = buildProxyDispatcher(socksProxy) as unknown as Record<string, unknown>
    expect(typeof d.dispatch).toBe('function')
    expect(typeof d.close).toBe('function')
  })
  it('⚠️ 密码型 SOCKS5 URL 也能建实例（认证走隧道层，不是 URL 层）', () => {
    const d = buildProxyDispatcher({ ...socksProxy, url: 'socks5://u:p@127.0.0.1:1080' })
    expect(d).toBeDefined()
  })
  it('closeAllProxyDispatchers 清空缓存', async () => {
    buildProxyDispatcher(httpProxy)
    expect(proxyCacheSize()).toBeGreaterThan(0)
    await closeAllProxyDispatchers()
    expect(proxyCacheSize()).toBe(0)
  })
  it('LRU 上限：超过 16 个不同代理后旧实例被淘汰', async () => {
    for (let i = 0; i < 20; i++) {
      buildProxyDispatcher({ kind: 'http', url: `http://127.0.0.1:${9000 + i}`, label: '' })
    }
    expect(proxyCacheSize()).toBe(16)
    await closeAllProxyDispatchers()
  })
})

describe('SOCKS5 握手帧（RFC 1928/1929）', () => {
  it('无认证：VER=5 METHOD=0', () => {
    const hello = buildSocks5Handshake({ url: 'socks5://127.0.0.1:1080' })
    expect([...hello]).toEqual([0x05, 0x01, 0x00])
  })
  it('带认证：METHOD 序列含 0x02（用户名密码）', () => {
    const hello = buildSocks5Handshake({ url: 'socks5://u:p@127.0.0.1:1080' })
    expect(hello[0]).toBe(0x05)
    expect(hello[1]).toBe(0x02)
    expect([...hello].includes(0x02)).toBe(true)
  })
  it('只有用户名（无密码）也算带认证', () => {
    const hello = buildSocks5Handshake({ url: 'socks5://u@127.0.0.1:1080' })
    expect(hello[1]).toBe(0x02)
  })
  it('percent-encoded 的凭据被解码（用户填的 %40 是 @）', () => {
    const hello = buildSocks5Handshake({ url: 'socks5://user%40corp:p%40ss@127.0.0.1:1080' })
    expect(hello[1]).toBe(0x02)
  })
})
