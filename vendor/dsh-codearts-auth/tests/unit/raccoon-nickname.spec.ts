import { describe, expect, it } from 'vitest'
import { buildRaccoonNickname } from '../../src/jet-hub-rpc.js'

/**
 * Raccoon 账号展示名的构造。
 *
 * ⚠️ **为什么要追加手机号尾号**（真实情况，用户提出）：
 * 服务端的 `name` 是**自动生成的默认名**（实测 `RaccoonAva`，
 * 即「Raccoon」+ 随机串），且微信扫码**不回传微信昵称**
 *（`wechat_bindings` 只有 `[{id, bound_at}]`）。它是账号的正式名字
 *（JWT payload 里也有 `name`，官方客户端就显示它），故**保留**；
 * 但注册第二个账号时服务端很可能又给相近的默认名 → 多账号重名、无法区分。
 *
 * 故形如 `RaccoonAva (1100)`：原名 + 手机号尾号。
 */
describe('buildRaccoonNickname', () => {
  it('昵称 + 手机号尾号（典型情形）', () => {
    expect(buildRaccoonNickname(
      { nickname: 'RaccoonAva', phone: '13011111100', user_id: '7445120' },
      'RACCOON_ACCOUNT_ABD05EAC',
    )).toBe('RaccoonAva (1100)')
  })

  it('无手机号时退化为用户 id', () => {
    expect(buildRaccoonNickname(
      { nickname: 'RaccoonAva', user_id: '7445120' },
      'fallback',
    )).toBe('RaccoonAva (7445120)')
  })

  it('只有昵称时原样返回（不产出孤立括号）', () => {
    expect(buildRaccoonNickname({ nickname: 'RaccoonAva' }, 'fallback')).toBe('RaccoonAva')
  })

  it('无昵称但有手机号时用 `Raccoon 尾号`（照 Loomy 形态）', () => {
    expect(buildRaccoonNickname(
      { phone: '13011111100', user_id: '7445120' },
      'fallback',
    )).toBe('Raccoon 1100')
  })

  it('只有用户 id 时用它作后缀', () => {
    expect(buildRaccoonNickname({ user_id: '7445120' }, 'fallback')).toBe('Raccoon 7445120')
  })

  it('全都没有时回退到账号 id（不产出空名）', () => {
    expect(buildRaccoonNickname({}, 'RACCOON_ACCOUNT_X')).toBe('RACCOON_ACCOUNT_X')
  })

  it('手机号短于 4 位时不用它（避免把号码片段当尾号）', () => {
    expect(buildRaccoonNickname({ nickname: 'A', phone: '123' }, 'fb')).toBe('A')
  })

  it('昵称里已含该尾号时不重复追加', () => {
    // 服务端将来若把手机号尾号写进 name，不应产出 `X1100 (1100)`
    expect(buildRaccoonNickname(
      { nickname: 'Raccoon1100', phone: '13011111100' },
      'fb',
    )).toBe('Raccoon1100')
  })

  it('空白昵称视为无昵称（不产出 ` (1100)` 这种前导空格）', () => {
    expect(buildRaccoonNickname(
      { nickname: '   ', phone: '13011111100' },
      'fb',
    )).toBe('Raccoon 1100')
  })

  it('只取手机号后 4 位（不完整暴露号码）', () => {
    const name = buildRaccoonNickname({ nickname: 'N', phone: '13011111100' }, 'fb')
    expect(name).not.toContain('13011111100')
    expect(name).toContain('(1100)')
    expect(name).toBe('N (1100)')
  })
})
