/**
 * 回归：腾讯系（buddy / workbuddy）适配器的 `refresh` 必须刷新**账号池里
 * 实际使用的那一个账号**，而不是默认单凭据 ref。
 *
 * ## 原始症状（真实缺陷，2026-09-26）
 *
 * 用户报障：workbuddy 国际版 + `deepseek-v4.1-flash`，任务跑到一半失败，
 * 「继续执行目标」后每一轮都立刻报 **「未配置凭据，请先登录」**。实测环境：
 * 账号池里 5 个 workbuddy 账号、`enabled` 全为 true、5 个 access_token 用
 * `GET /v3/config` 逐个探测**全部 HTTP 200**、`deepseek-v4.1-flash` 至少
 * 3 个账号不在限流窗口内 —— 即「凭据不可用」这个结论完全站不住。
 *
 * ## 根因
 *
 * `src/index.ts` 曾把 `refresh` 直接接成 `buddy.refresh()` /
 * `workbuddy.refresh()`。那两者读写的是**默认单凭据 ref**
 * （`BUDDY_ACCESS_TOKEN` / `WORKBUDDY_ACCESS_TOKEN`），而 Jet Hub 的登录
 * 入口只写 `*_ACCOUNT_XXX` —— 那个 ref 根本不存在。于是 `refresh()` 恒抛
 * 「未配置凭据，请先登录」，**文案与真实原因无关**。
 *
 * 本文件刻意 import **真实的 `createPoolRefresh`**（而不是把接线抄一份进
 * 测试）：抄写式的断言只能证明副本自洽，改动真实接线时不会失败。
 */

import { describe, expect, it, vi } from 'vitest'
import { createPoolRefresh } from '../../src/buddy-auth.js'

interface FakeEntry {
  id: string
  provider: string
  credentialRef: string
}

/** 账号池替身：只实现 createPoolRefresh 用到的那一个方法。 */
function makePool(entries: FakeEntry[]) {
  const calls: Array<{ provider: string; modelId: string }> = []
  return {
    calls,
    getAvailableAccount: async (provider: string, modelId: string) => {
      calls.push({ provider, modelId })
      const entry = entries.find(e => e.provider === provider)
      return entry === undefined ? null : { entry, credential: { access_token: 'AT' } }
    },
  }
}

describe('createPoolRefresh：刷新账号池里实际使用的那一个账号', () => {
  it('池内有账号时刷的是池账号的 credentialRef，绝不碰默认单凭据', async () => {
    const poolRef = 'WORKBUDDY_ACCOUNT_94255A7D'
    const pool = makePool([{ id: 'workbuddy-94255a7d', provider: 'workbuddy', credentialRef: poolRef }])
    const targets: string[] = []
    const auth = {
      refreshAccountCredential: async (ref: string) => { targets.push(ref) },
      refresh: async () => { targets.push('(默认单凭据)') },
    }

    await createPoolRefresh(pool, 'workbuddy', auth)()

    expect(targets).toEqual([poolRef])
    // 关键：默认单凭据路径一次都不能被走到 —— 那正是报错文案的来源。
    expect(targets).not.toContain('(默认单凭据)')
  })

  it('按产品 id 取号：workbuddy 不会取到 buddy 的账号', async () => {
    const pool = makePool([
      { id: 'buddy-1', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_000001' },
    ])
    const targets: string[] = []
    const auth = {
      refreshAccountCredential: async (ref: string) => { targets.push(ref) },
      refresh: async () => { targets.push('(默认单凭据)') },
    }

    await createPoolRefresh(pool, 'workbuddy', auth)()

    // 池里只有 buddy 账号 → workbuddy 取不到 → 回退单凭据，且**没取错别人的账号**。
    expect(targets).toEqual(['(默认单凭据)'])
    expect(pool.calls).toEqual([{ provider: 'workbuddy', modelId: '' }])
  })

  it('池内为空时才回退到默认单凭据 ref（老数据兼容路径）', async () => {
    const pool = makePool([])
    const targets: string[] = []
    const auth = {
      refreshAccountCredential: async (ref: string) => { targets.push(ref) },
      refresh: async () => { targets.push('(默认单凭据)') },
    }

    await createPoolRefresh(pool, 'buddy', auth)()

    expect(targets).toEqual(['(默认单凭据)'])
  })

  it('池账号的 refreshAccountCredential 抛错时，错误原样冒泡（不被吞成别的文案）', async () => {
    const pool = makePool([{ id: 'w-1', provider: 'workbuddy', credentialRef: 'WORKBUDDY_ACCOUNT_X' }])
    const auth = {
      refreshAccountCredential: async () => { throw new Error('无 refresh_token，请重新登录') },
      refresh: vi.fn(async () => {}),
    }

    await expect(createPoolRefresh(pool, 'workbuddy', auth)()).rejects.toThrow('无 refresh_token')
    expect(auth.refresh).not.toHaveBeenCalled()
  })
})
