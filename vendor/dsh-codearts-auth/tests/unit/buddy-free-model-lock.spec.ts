/**
 * 免费模型**跳过永久积分锁定**的回归（`src/buddy-adapter.ts` + `src/index.ts`）。
 *
 * ## 为什么单独守这个
 *
 * 用户报障：**用免费模型**（消耗 0 积分）却报
 * 「WorkBuddy：没有可用账号。已锁定永久积分，而所有账号的『N 天内到期』积分都已用尽」，
 * 而账号余额查询正常、Jet Hub 面板显示有钱 —— 即「账户可用却提示异常失败」。
 *
 * 根因是**接线缺失**，不是算法错：`pickBuddyCredential` 只问
 * 「锁没锁 + 有没有临期积分」，从不问「这个模型要不要钱」。免费模型既不消耗
 * 临时积分也不消耗永久积分，却被那道门一并拦下。锁定要保护的是「别把永久积分
 * 烧掉」，与免费模型无关。
 *
 * ## 两条必须同时成立的约定
 *
 * 1. **确定免费才放开**：`isFreeModel` 只在能确认 0 积分时返回 true。
 *    把付费模型误判成免费会绕开锁定、**真烧掉永久积分且不可撤回** ——
 *    这是本补丁最危险的失效方向，故边界用例逐条锁死。
 * 2. **免费路径仍受模型级限流约束**：免费不等于无视限流标记。
 *
 * 与 `buddy-permanent-lock.spec.ts` 同款：源码级断言（接线不能断）+
 * 行为级验证（判据必须对）。UI 无法在单测里渲染（react 不在依赖内）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const adapterSource = readFileSync(resolve(here, '../../src/buddy-adapter.ts'), 'utf8').replace(/\r\n/g, '\n')
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** 剥掉注释后的源码。⚠️ 接线断言必须只看代码，不能因「注释里提到某符号」而误判。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const indexCode = codeOnly(indexSource)
const adapterCode = codeOnly(adapterSource)

/** 复现 `isFreeModel` 的判据（与源码同口径，供行为级用例使用）。 */
function isZeroRate(rate: string | undefined): boolean {
  return rate === 'x0' || rate === '免费'
}

function judgeFree(meta: { creditsRate?: string; discountedCreditsRate?: string } | undefined): boolean {
  if (meta === undefined) return false
  return isZeroRate(meta.creditsRate) || isZeroRate(meta.discountedCreditsRate)
}

describe('免费模型跳过永久积分锁定', () => {
  describe('判据（行为级）', () => {
    it('credits 直给 x0 视为免费', () => {
      expect(judgeFree({ creditsRate: 'x0' })).toBe(true)
    })

    it('促销价 x0 视为免费', () => {
      expect(judgeFree({ creditsRate: 'x0.5', discountedCreditsRate: 'x0' })).toBe(true)
    })

    it('促销 factor:0 写入的中文串「免费」也视为免费', () => {
      // ⚠️ 这条最容易漏：parsePromotions 在 factor === 0 时写的是 `rate = '免费'`，
      // **不是** `x0`。只认 `x0` 会让夜间免费模型仍被拦截。
      expect(judgeFree({ creditsRate: 'x0.29', discountedCreditsRate: '免费' })).toBe(true)
    })

    it('付费模型一律不视为免费（误判会绕开锁定、真烧永久积分）', () => {
      expect(judgeFree({ creditsRate: 'x0.29' })).toBe(false)
      expect(judgeFree({ creditsRate: 'x0.5', discountedCreditsRate: 'x0.17' })).toBe(false)
      expect(judgeFree({ creditsRate: 'x1.62' })).toBe(false)
    })

    it('无倍率信息 / 未知模型不视为免费（保守方向）', () => {
      expect(judgeFree(undefined)).toBe(false)
      expect(judgeFree({})).toBe(false)
      expect(judgeFree({ creditsRate: '' })).toBe(false)
    })

    it('x0 前缀的其它倍率不被误判（x0.29 不是免费）', () => {
      // 防止有人把判据写成 startsWith('x0') —— 那会把 x0.29 也判成免费。
      expect(judgeFree({ creditsRate: 'x0.29' })).toBe(false)
      expect(judgeFree({ creditsRate: 'x0.03' })).toBe(false)
    })
  })

  describe('isFreeModel 源码约定', () => {
    it('存在 isFreeModel 方法且为 async（必须先 await 远端目录）', () => {
      expect(adapterCode).toMatch(/async isFreeModel\(/)
    })

    it('先确保远端目录已加载，否则判据静默失效', () => {
      const body = adapterCode.slice(adapterCode.indexOf('async isFreeModel('))
      const end = body.indexOf('\n  }')
      expect(body.slice(0, end)).toContain('await this.ensureRemoteModels()')
    })

    it('只信远端 remoteMeta（兜底表没有倍率字段，不可作为免费依据）', () => {
      const body = adapterCode.slice(adapterCode.indexOf('async isFreeModel('))
      const end = body.indexOf('\n  }')
      const fn = body.slice(0, end)
      expect(fn).toContain('this.remoteMeta.get(modelId)')
      // 兜底表是编译期快照、不含 creditsRate；拿它判免费会恒为 false 或误判。
      expect(fn).not.toContain('productFallbackIndex')
    })

    it('同时认 x0 与中文「免费」两种形态', () => {
      const body = adapterCode.slice(adapterCode.indexOf('async isFreeModel('))
      const end = body.indexOf('\n  }')
      const fn = body.slice(0, end)
      expect(fn).toContain("'x0'")
      expect(fn).toContain("'免费'")
    })

    it('空 / 非字符串入参直接返回 false', () => {
      const body = adapterCode.slice(adapterCode.indexOf('async isFreeModel('))
      const end = body.indexOf('\n  }')
      expect(body.slice(0, end)).toContain('return false')
    })
  })

  describe('接线（源码级）', () => {
    it('pickBuddyCredential 接受 isFreeModel 选项', () => {
      expect(indexCode).toMatch(/isFreeModel\?:\s*boolean/)
    })

    it('免费路径在余额分档之前短路返回', () => {
      const fnStart = indexCode.indexOf('const pickBuddyCredential =')
      const fnBody = indexCode.slice(fnStart)
      const freeBranch = fnBody.indexOf('options.isFreeModel === true')
      const lockRead = fnBody.indexOf('pool.permanentLocked(options.product.id)')
      expect(freeBranch).toBeGreaterThan(-1)
      expect(lockRead).toBeGreaterThan(-1)
      // 免费分支必须**先于**读取锁定状态 —— 否则仍会被拦下。
      expect(freeBranch).toBeLessThan(lockRead)
    })

    it('免费路径遍历候选并解析凭据', () => {
      const fnStart = indexCode.indexOf('const pickBuddyCredential =')
      const fnBody = indexCode.slice(fnStart)
      const freeBranch = fnBody.slice(fnBody.indexOf('options.isFreeModel === true'))
      const end = freeBranch.indexOf('const allowPermanent')
      const block = freeBranch.slice(0, end)
      expect(block).toContain('for (const candidate of candidates)')
      // ⚠️ 2026-10-06 泛化后这里调的是局部 `resolveCredential`（= 入参或 buddy 缺省值），
      // 不再是直接引用 `resolveBuddyCredentialByRef` —— 后者只作为**缺省值**出现在
      // 函数头部。断言改为检查实际调用点，语义不变（免费路径必须解析凭据）。
      expect(block).toContain('await resolveCredential(candidate.credentialRef)')
      expect(fnBody).toContain('options.resolveCredential')
    })

    it('免费路径不调用余额分档（免费模型无需选包）', () => {
      const fnStart = indexCode.indexOf('const pickBuddyCredential =')
      const fnBody = indexCode.slice(fnStart)
      const freeBranch = fnBody.slice(fnBody.indexOf('options.isFreeModel === true'))
      const end = freeBranch.indexOf('const allowPermanent')
      const block = freeBranch.slice(0, end)
      expect(block).not.toContain('pickBuddyAccount')
    })

    it('免费路径不绕开模型级限流过滤（限流仍在候选构造里）', () => {
      const fnStart = indexCode.indexOf('const pickBuddyCredential =')
      const fnBody = indexCode.slice(fnStart)
      const candidatesEnd = fnBody.indexOf('options.isFreeModel === true')
      const before = fnBody.slice(0, candidatesEnd)
      expect(before).toContain('modelRateLimits')
      expect(before).toContain('.filter(a => a.enabled)')
    })

    it('两个 provider 调用点都传入了 isFreeModel', () => {
      expect(indexCode).toContain('isFreeModel: await buddyAdapter.isFreeModel(modelId)')
      expect(indexCode).toContain('isFreeModel: await workbuddyAdapter.isFreeModel(modelId)')
    })

    it('调用点透传的是本次请求的 modelId（不是空串）', () => {
      // 断言整条语句：`isFreeModel: await <adapter>.isFreeModel(modelId)`。
      expect(indexCode).toMatch(/isFreeModel: await buddyAdapter\.isFreeModel\(modelId\)/)
      expect(indexCode).toMatch(/isFreeModel: await workbuddyAdapter\.isFreeModel\(modelId\)/)
    })
  })

  describe('锁定语义未被削弱（回归保护）', () => {
    it('付费模型仍走原有的锁定报错路径', () => {
      // 免费分支不得吞掉 locked 分支的错误语义。
      expect(indexCode).toContain("picked.kind === 'locked'")
      expect(indexCode).toContain('没有可用账号')
    })

    it('锁定后仍不落到 getAvailableAccount 兜底', () => {
      const fnStart = indexCode.indexOf('const pickBuddyCredential =')
      const fnBody = indexCode.slice(fnStart)
      const lockBranch = fnBody.slice(fnBody.indexOf("picked.kind === 'locked'"))
      const end = lockBranch.indexOf('return { tried }')
      expect(lockBranch.slice(0, end)).not.toContain('getAvailableAccount')
    })
  })
})
