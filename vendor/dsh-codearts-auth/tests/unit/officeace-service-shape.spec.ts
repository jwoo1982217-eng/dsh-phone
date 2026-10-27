// 验证「复制模块导出到普通对象」方案（Object.create 方案已证伪：
// 赋值沿原型链走到模块的 getter-only 属性，照样抛
// "Cannot set property … which has only a getter"）。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as officeaceAuth from '../../src/officeace-auth.js'

describe('officeace auth 服务包装的形状约束', () => {
  it('① 复制出的普通对象含**全部**导出，新增导出不再漏', () => {
    // 方案：把模块的可枚举导出拷进一个普通对象
    const svc: Record<string, unknown> = { ...officeaceAuth }
    // ⚠️ persistLogin 是本次事故漏掉的那个（login.poll 调它 ⇒ 授权失败）
    expect(typeof svc.persistLogin).toBe('function')
    expect(typeof svc.readCredential).toBe('function')
    expect(typeof svc.startLogin).toBe('function')
    expect(typeof svc.completeLogin).toBe('function')
    expect(typeof svc.fetchSubscriptionSummary).toBe('function')
  })

  it('② 普通对象可被 spy 覆盖（不触发 getter-only 报错）', () => {
    const svc: Record<string, unknown> = { ...officeaceAuth }
    svc.refreshAccountCredential = vi.fn(async () => {})
    expect(vi.isMockFunction(svc.refreshAccountCredential)).toBe(true)
    // 模块本身未被污染
    expect(vi.isMockFunction(officeaceAuth.refreshAccountCredential)).toBe(false)
  })

  it('③ 未覆盖的方法照常可用（复制的是引用，不是快照失效）', () => {
    const svc = { ...officeaceAuth }
    expect(typeof svc.isExpiring).toBe('function')
    expect(() => svc.isExpiring({
      modelAppKey: 'k', modelAppSecret: 's', maasBaseUrl: 'u',
      access: 'a', secret: 's', securityToken: 't', projectId: 'p',
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      refreshToken: 'r', dpopPrivateJwk: {},
    })).not.toThrow()
  })

  /**
   * ⚠️ **本文件最重要的一条**：直接锁死 `src/index.ts` 里的服务包装。
   *
   * 2026-10-13 事故：`officeaceAuthService` 早先是**手写的方法清单**，
   * `persistLogin` 加入后忘了同步 ⇒ `login.poll` 拿到 `undefined`，
   * 被 catch 成「登录交换失败」—— 用户看到「授权完却登录失败」。
   * 全量测试当时**全绿**，因为测试桩是自己造的对象，不走那个手写清单。
   *
   * 故这里改为：从 `index.ts` **源码文本**里确认包装是**复制**形态
   * （`{ ...officeaceAuth }`），而不是枚举形态；并断言模块新增的函数
   * 不必再手工登记。这样「漏同步」这一类缺陷**不可能**再发生。
   */
  it('④ index.ts 的服务包装是「复制模块导出」形态，不是手写清单（漏同步 ⇒ 登录失败）', () => {
    const source = readFileSync(
      new URL('../../src/index.ts', import.meta.url),
      'utf8',
    )
    // ⚠️ 判据是**形态**，不是「某个方法名在不在」—— 后者正是会漂移的那种写法。
    expect(
      source,
      'officeaceAuthService 应当是 `{ ...officeaceAuth }` 复制形态；'
      + '手写方法清单会随模块新增导出而漂移（persistLogin 事故）',
    ).toMatch(/const officeaceAuthService[^=]*=\s*\{\s*\.\.\.officeaceAuth\s*\}/)

    // 反面：不得再出现逐条转发 `persistLogin` 这类手工登记。
    expect(
      source,
      '不应再手工转发 persistLogin —— 复制形态下它是多余的，且是漂移源',
    ).not.toMatch(/persistLogin:\s*\(\s*\.\.\./)
  })

  /**
   * 端到端一致性：模块**当前所有**导出，包装对象都必须具备。
   *
   * ⚠️ 这条与 ④ 互补：④ 锁形态（结构性防御），本条锁结果（当前事实）。
   *    将来模块新增导出时，本条**自动**校验通过（因为是复制形态），
   *    而形态若被改回手写清单，④ 会立刻变红。
   */
  it('⑤ 模块的每个函数导出都能在包装对象上取到（自动跟随，无需登记）', () => {
    const svc: Record<string, unknown> = { ...officeaceAuth }
    const missing = Object.keys(officeaceAuth).filter((key) => {
      const value = (officeaceAuth as unknown as Record<string, unknown>)[key]
      return typeof value === 'function' && typeof svc[key] !== 'function'
    })
    expect(
      missing,
      `这些模块导出在包装对象上缺失 ⇒ 调用点会拿到 undefined：${missing.join(', ')}`,
    ).toEqual([])
  })
})
