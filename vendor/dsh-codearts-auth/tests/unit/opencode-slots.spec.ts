import { describe, expect, it } from 'vitest'
import {
  ensureDefaultAnonymousSlot, isAnonymousCredential, listIdentitySlots,
  newAccountFingerprint, nextFingerprintGeneration, normalizeOpencodeGeneration,
  poolEntrySnapshot,
  type PoolEntrySnapshot,
} from '../../src/opencode-auth.js'
import { deriveProjectId } from '../../src/opencode.js'

/**
 * 构造一个账号池条目。
 *
 * ⚠️ 默认**不给 fingerprint**（`undefined`），以镜像真实接线：接线层按
 * `deriveProjectId(identity, generation)` 现算 —— 匿名槽的 identity 是条目 id
 * （它们的 api_key 全是 `public`，不可用于派生）。若这里默认填一个由 api_key
 * 派生的指纹，测试就会假通过（两个不同条目拿到同一指纹也测不出来）。
 */
function entry(over: Partial<PoolEntrySnapshot> = {}): PoolEntrySnapshot {
  return {
    id: 'opencode-a1b2',
    enabled: true,
    apiKey: 'sk-test-key-A',
    proxy: undefined,
    fingerprint: undefined,
    ...over,
  }
}

describe('newAccountFingerprint', () => {
  it('生成 40 hex + 代次 0', () => {
    const fp = newAccountFingerprint('sk-x')
    expect(fp.projectId).toMatch(/^[0-9a-f]{40}$/)
    expect(fp.generation).toBe(0)
  })
  it('同 key 同代次稳定，不同 key 不同', () => {
    expect(newAccountFingerprint('sk-a').projectId).toBe(newAccountFingerprint('sk-a').projectId)
    expect(newAccountFingerprint('sk-a').projectId).not.toBe(newAccountFingerprint('sk-b').projectId)
  })
})

describe('nextFingerprintGeneration', () => {
  it('代次 +1 且 project id 随之变化', () => {
    const next = nextFingerprintGeneration(newAccountFingerprint('sk-a'))
    expect(next.generation).toBe(1)
    expect(next.projectId).not.toBe(newAccountFingerprint('sk-a').projectId)
  })
  it('旧指纹对象不被就地修改（调用方可能已缓存它）', () => {
    const before = newAccountFingerprint('sk-a')
    nextFingerprintGeneration(before)
    expect(before.generation).toBe(0)
  })
  it('脏代次（非安全整数/负数）被纠正为 1 而不是产生非法 project id', () => {
    expect(nextFingerprintGeneration({ projectId: 'x', generation: Number.NaN }).generation).toBe(1)
    expect(nextFingerprintGeneration({ projectId: 'x', generation: -5 }).generation).toBe(1)
  })
})

describe('isAnonymousCredential', () => {
  it('字面量 public 即匿名通道', () => {
    expect(isAnonymousCredential('public')).toBe(true)
  })
  it('真实 key 不是匿名', () => {
    expect(isAnonymousCredential('sk-abc')).toBe(false)
    expect(isAnonymousCredential(undefined)).toBe(false)
  })
})

describe('listIdentitySlots', () => {
  it('账号槽保持账号池的手动顺序', () => {
    const slots = listIdentitySlots([entry({ id: 'opencode-1' }), entry({ id: 'opencode-2' })], 'opencode/1.18.22')
    expect(slots.map((s) => s.id)).toEqual(['opencode-1', 'opencode-2'])
    expect(slots.every((s) => s.kind === 'account')).toBe(true)
  })

  it('⚠️ 不再自动追加进程内匿名槽（匿名通道改为池内条目，2026-10-02）', () => {
    // 旧行为：恒定追加一个 anonymous 末位槽。它无法添加/配代理/排序，
    // 用户拿不到「多条匿名通道各走各的出口」。现在由 ensureDefaultAnonymousSlot
    // 在池里建一条真实条目来承担这个角色。
    expect(listIdentitySlots([], 'opencode/1.18.22')).toHaveLength(0)
  })

  it('⚠️ 池内的匿名条目被识别为 anonymous 且 api_key 固定为 public', () => {
    const slots = listIdentitySlots([entry({ id: 'opencode-anon-1', apiKey: 'public' })], 'opencode/1.18.22')
    expect(slots[0]!.kind).toBe('anonymous')
    expect(slots[0]!.apiKey).toBe('public')
  })

  it('停用条目被剔除', () => {
    expect(listIdentitySlots([entry({ enabled: false })], 'opencode/1.18.22')).toHaveLength(0)
  })

  it('每槽指纹独立（账号 A 与账号 B 不同）', () => {
    const slots = listIdentitySlots(
      [entry({ id: 'a', apiKey: 'sk-a' }), entry({ id: 'b', apiKey: 'sk-b' })],
      'opencode/1.18.22',
    )
    expect(slots[0]!.fingerprint.projectId).not.toBe(slots[1]!.fingerprint.projectId)
  })

  it('⚠️ 多个匿名槽指纹互不相同（api_key 都是 public，故 identity 取条目 id）', () => {
    const slots = listIdentitySlots(
      [entry({ id: 'opencode-anon-1', apiKey: 'public' }), entry({ id: 'opencode-anon-2', apiKey: 'public' })],
      'opencode/1.18.22',
    )
    expect(slots[0]!.fingerprint.projectId).not.toBe(slots[1]!.fingerprint.projectId)
  })

  it('⚠️ 匿名槽也能配代理（配额扩容靠这个 —— 匿名按出口 IP 限额）', () => {
    const slots = listIdentitySlots(
      [entry({ id: 'opencode-anon-1', apiKey: 'public', proxy: '127.0.0.1:7897' })],
      'opencode/1.18.22',
    )
    expect(slots[0]!.proxy?.url).toBe('http://127.0.0.1:7897')
  })

  it('合法代理被归一为 NormalizedProxy', () => {
    expect(listIdentitySlots([entry({ proxy: '127.0.0.1:7897' })], 'opencode/1.18.22')[0]!.proxy?.url)
      .toBe('http://127.0.0.1:7897')
  })

  it('⚠️ 非法代理降级为直连（不抛错、不静默拨错地址）', () => {
    expect(listIdentitySlots([entry({ proxy: 'vmess://x' })], 'opencode/1.18.22')[0]!.proxy).toBeUndefined()
  })

  it('缺 fingerprint 的老账号自动补一份', () => {
    expect(listIdentitySlots([entry({ fingerprint: undefined })], 'opencode/1.18.22')[0]!.fingerprint.projectId)
      .toMatch(/^[0-9a-f]{40}$/)
  })

  it('userAgent 透传到每个槽', () => {
    const slots = listIdentitySlots([entry()], 'opencode/1.18.99')
    expect(slots.every((s) => s.userAgent === 'opencode/1.18.99')).toBe(true)
  })
})

/**
 * `poolEntrySnapshot` 是**唯一的**槽输入投影实现（2026-10-08 第二轮抽出来的）。
 *
 * ## 为什么要有这一段
 *
 * 抽它之前，同一套派生有**两处**：`index.ts` 的 opencode 接线块和
 * `listIdentitySlots` 的缺指纹回退分支。两处都算
 * `identity = anonymous ? id : apiKey` + `deriveProjectId`。
 * 分叉的后果是**静默**的：匿名通道的 api_key 全是 `public`，
 * 若某处误用 api_key 派生，N 条匿名通道会拿到**同一个指纹**
 * ——不报错、日志无字，只是「换了通道却仍被关联」。
 *
 * 抽取本身由 `opencode-wiring.spec.ts` 的源码断言锁住（`index.ts` 不得再出现
 * 那份 identity 派生）；本段锁**抽取后的行为**，两者缺一不可：
 * 只锁源码会让「函数体写错」漏过，只锁行为会让「又抄一份回去」漏过。
 */
describe('poolEntrySnapshot（槽输入投影的唯一实现）', () => {
  it('账号槽用 apiKey 派生，且代次进 project id（「指纹」按钮的生效点）', () => {
    const base = poolEntrySnapshot({ id: 'opencode-a1', apiKey: 'sk-A' })
    expect(base.fingerprint.projectId).toBe(deriveProjectId('sk-A', 0))
    expect(base.fingerprint.generation).toBe(0)
    const rotated = poolEntrySnapshot({ id: 'opencode-a1', apiKey: 'sk-A', generation: 2 })
    expect(rotated.fingerprint.projectId).toBe(deriveProjectId('sk-A', 2))
    expect(rotated.fingerprint.projectId).not.toBe(base.fingerprint.projectId)
  })

  it('⚠️⚠️ 匿名槽用**条目 id** 派生（用 api_key 会让 N 条匿名通道指纹相同）', () => {
    const first = poolEntrySnapshot({ id: 'opencode-anon-1', apiKey: 'public' })
    const second = poolEntrySnapshot({ id: 'opencode-anon-2', apiKey: 'public' })
    expect(first.fingerprint.projectId).toBe(deriveProjectId('opencode-anon-1', 0))
    // 核心不变式：两条匿名通道必须彼此不可关联。
    expect(first.fingerprint.projectId).not.toBe(second.fingerprint.projectId)
  })

  it('⚠️ enabled 缺省为 true —— 探测靠它才能重测停用账号', () => {
    // `listIdentitySlots` 会跳过 enabled === false 的条目，而探测的既定语义是
    // 「停用账号也要能重测」（account-probe.ts 模块头第 2 条设计）。
    expect(poolEntrySnapshot({ id: 'a', apiKey: 'sk-A' }).enabled).toBe(true)
    expect(poolEntrySnapshot({ id: 'a', apiKey: 'sk-A', enabled: false }).enabled).toBe(false)
  })

  it('代次归一化：负 / NaN / Infinity / undefined 一律 0（不能只判 nullish）', () => {
    // ⚠️ `-1` 不是 nullish，`?? 0` 放它过去 ⇒ 与另一处判据分叉。
    // 规范化收敛在 `normalizeOpencodeGeneration`，这里连同池侧方法一起对拍。
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(poolEntrySnapshot({ id: 'a', apiKey: 'sk-A', generation: bad }).fingerprint.generation)
        .toBe(0)
      expect(normalizeOpencodeGeneration(bad)).toBe(0)
    }
    expect(poolEntrySnapshot({ id: 'a', apiKey: 'sk-A', generation: 3 }).fingerprint.generation).toBe(3)
    expect(normalizeOpencodeGeneration(3)).toBe(3)
  })

  it('proxy 原样带出（归一化是 listIdentitySlots 的职责，不在这里做）', () => {
    expect(poolEntrySnapshot({ id: 'a', apiKey: 'sk-A', proxy: '127.0.0.1:7897' }).proxy)
      .toBe('127.0.0.1:7897')
    expect(poolEntrySnapshot({ id: 'a', apiKey: 'sk-A' }).proxy).toBeUndefined()
  })
})

describe('ensureDefaultAnonymousSlot', () => {
  function harness(hasAnonymous: boolean) {
    const added: Array<Record<string, unknown>> = []
    const creds: Array<[string, string]> = []
    return {
      added,
      creds,
      run: () => ensureDefaultAnonymousSlot(
        async (e) => { added.push(e) },
        async (ref, v) => { creds.push([ref, v]) },
        () => [],
        () => hasAnonymous,
      ),
    }
  }

  it('池里没有匿名槽时创建一条（api_key = public）', async () => {
    const h = harness(false)
    expect(await h.run()).not.toBe('')
    expect(h.added).toHaveLength(1)
    expect(h.added[0]!.provider).toBe('opencode')
    expect(h.added[0]!.refreshable).toBe(false)
    expect(JSON.parse(h.creds[0]![1]).api_key).toBe('public')
  })

  it('已有匿名槽时不重复创建（幂等）', async () => {
    const h = harness(true)
    expect(await h.run()).toBe('')
    expect(h.added).toHaveLength(0)
  })

  it('⚠️ 失败时静默返回空串（启动路径不能因它崩掉）', async () => {
    expect(await ensureDefaultAnonymousSlot(
      async () => { throw new Error('disk full') },
      async () => {},
      () => [],
      () => false,
    )).toBe('')
  })
})

