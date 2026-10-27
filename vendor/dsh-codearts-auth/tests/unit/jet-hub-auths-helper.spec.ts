/**
 * `tests/helpers/jet-hub-auths.ts` 的回归测试。
 *
 * ## 守的是什么（复审 Finding 2 的根因）
 *
 * 命名对象下**键的相邻关系零语义**，而原先三条断言用的是相邻性正则
 * （`/\bminimax,\s*zcode,\s*gemini,/` 等）。本助手是那三条断言的替代判据，
 * 故它自己必须先被证明「对书写形态中立、对键的增删敏感」—— 否则只是把
 * 「假失败」换成了「假绿」，而假绿比假失败更糟（本仓库红线）。
 */
import { describe, expect, it } from 'vitest'
import {
  jetHubAuthsCallKeys,
  jetHubAuthsInterfaceKeys,
} from '../helpers/jet-hub-auths.js'

/** 造一个最小调用点；`body` 是对象字面量的成员列表。 */
const call = (body: string): string => `
declare const ctx: unknown
declare const pool: unknown
declare const modelAdapters: unknown
declare const service: unknown
declare const qoderCn: unknown
declare const buddy: unknown
declare const qoder: unknown
registerJetHubRpc(ctx, pool, {
${body}
}, modelAdapters)
`

/** 造一个最小接口声明。 */
const iface = (body: string): string => `
export interface JetHubAuths {
${body}
}
`

describe('jetHubAuthsCallKeys：读调用点的键（对书写形态中立）', () => {
  it('★ 同一组键的**任意重排**结果逐字相同（这正是相邻性正则做不到的）', () => {
    const a = jetHubAuthsCallKeys(call('  minimax,\n  zcode,\n  gemini,'))
    const b = jetHubAuthsCallKeys(call('  gemini,\n  minimax,\n  zcode,'))
    expect(Object.keys(a).sort()).toEqual(['gemini', 'minimax', 'zcode'])
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort())
  })

  it('★ 换行 / 同行 / 注释 / 键之间插入新键都不影响键集合', () => {
    const oneLine = jetHubAuthsCallKeys(call('  minimax, zcode, gemini,'))
    const withComment = jetHubAuthsCallKeys(call(
      '  // 注释里写出反模式 `minimax: zcode` 也不该被当成键\n  minimax, /* 行内 */ zcode, gemini,',
    ))
    const withExtra = jetHubAuthsCallKeys(call('  minimax, kuku, zcode, gemini,'))
    expect(Object.keys(oneLine).sort()).toEqual(['gemini', 'minimax', 'zcode'])
    expect(Object.keys(withComment).sort()).toEqual(['gemini', 'minimax', 'zcode'])
    // ⚠️ 插入的新键**必须**出现在结果里（它是真实的键，不是噪声）。
    expect(Object.keys(withExtra).sort()).toEqual(['gemini', 'kuku', 'minimax', 'zcode'])
  })

  it('★ 删掉某个键必须反映出来（断言才不会假绿）', () => {
    const keys = Object.keys(jetHubAuthsCallKeys(call('  minimax, zcode,')))
    expect(keys).not.toContain('gemini')
    expect(keys.sort()).toEqual(['minimax', 'zcode'])
  })

  it('★ 读出「键 → 值」映射（`qodercn: qoderCn` 的键值不同名形态）', () => {
    const keys = jetHubAuthsCallKeys(call('  qoder,\n  qodercn: qoderCn,'))
    // 键是 provider id，值是变量名 —— 两者不同名是刻意的。
    expect(keys.qodercn).toBe('qoderCn')
    expect(Object.keys(keys)).not.toContain('qoderCn')
    // 简写属性 `qoder,` 的键与值同名。
    expect(keys.qoder).toBe('qoder')
  })

  it('★ 找不到调用点 / 第三参不是对象字面量时抛错（不静默返回空表）', () => {
    expect(() => jetHubAuthsCallKeys('const x = 1')).toThrow(/找不到 registerJetHubRpc 调用点/)
    expect(() => jetHubAuthsCallKeys('registerJetHubRpc(ctx, pool, auths)'))
      .toThrow(/第三个实参不是对象字面量/)
  })
})

describe('jetHubAuthsInterfaceKeys：读接口声明（类型层权威）', () => {
  it('★ 按声明顺序取成员键，跳过 JSDoc 与空行', () => {
    const keys = jetHubAuthsInterfaceKeys(iface(`
  readonly codearts: CodeArtsAuth
  /** 注释里的 \`readonly fake: X\` 不该被当成成员 */
  readonly qodercn: QoderAuth

  readonly trae: TraeAuth
`))
    expect(keys).toEqual(['codearts', 'qodercn', 'trae'])
  })

  it('★ 找不到接口时抛错', () => {
    expect(() => jetHubAuthsInterfaceKeys('export interface Other {}'))
      .toThrow(/找不到 interface JetHubAuths/)
  })
})
