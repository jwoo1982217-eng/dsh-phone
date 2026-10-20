/**
 * Gemini `project` 的探测与缓存。
 *
 * ## 守的是什么
 *
 * 信封里的 `project` **不是恒为 `aicode-consumers`** —— 那是 `loadCodeAssist`
 * 探测为空时的**兜底**。真机对照实验（2026-10-05）证明原版读
 * `loadCodeAssist` 的 `cloudaicompanionProject`：假上游返回 `CCP-TWO`，
 * 信封里就是 `CCP-TWO`。
 *
 * ## 最容易写错的一处：「探测失败」vs「探测成功但为空」
 *
 * | 情形 | 期望 |
 * |---|---|
 * | 200 且 project 非空 | 用探测值 |
 * | 200 但 project 为空（免费档常态） | 回落兜底串，**照常发推理** |
 * | 非 2xx / 网络错误 | 返回 `error` ⇒ 调用方**不发推理** |
 *
 * 第三行是原版实测行为（注入 500 后原版只在端点间重试 LCA + quota，
 * **不发** `streamGenerateContent`）。把「空」误判成「失败」会让所有免费档
 * 账号直接不可用；把「失败」误判成「空」会让我们发出原版不会发的请求。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  GEMINI_DEFAULT_PROJECT,
  GEMINI_ENDPOINT_DAILY,
  GEMINI_ENDPOINT_SANDBOX,
  GEMINI_LOAD_CODE_ASSIST_PATH,
  type GeminiCredential,
} from '../../src/gemini.js'
import {
  geminiCredentialIdentity,
  parseGeminiProject,
  persistGeminiProject,
  resolveGeminiProject,
} from '../../src/gemini-project.js'

function cred(extra: Partial<GeminiCredential> = {}): GeminiCredential {
  return { access_token: 'AT', email: 'user@example.com', ...extra }
}

/** 记录调用的假 fetch。 */
function fakeFetch(responses: Array<() => Response>): {
  fetcher: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  let index = 0
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    const make = responses[Math.min(index, responses.length - 1)]!
    index += 1
    return make()
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

const lcaOk = (body: string): (() => Response) =>
  () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })

describe('gemini project 解析', () => {
  it('project 取值顺序：顶层优先、currentTier 兜底、都缺则空串', () => {
    expect(parseGeminiProject({ cloudaicompanionProject: 'CCP-TOP' })).toBe('CCP-TOP')
    expect(parseGeminiProject({ currentTier: { cloudaicompanionProject: 'CCP-TIER' } })).toBe('CCP-TIER')
    // 顶层优先（逐字对齐 `project.go:129-132` 的取值顺序）
    expect(parseGeminiProject({
      cloudaicompanionProject: 'CCP-TOP',
      currentTier: { cloudaicompanionProject: 'CCP-TIER' },
    })).toBe('CCP-TOP')
    // 免费档：两者都缺 ⇒ 空串（**不是** error）
    expect(parseGeminiProject({ currentTier: { id: 'free-tier' } })).toBe('')
    expect(parseGeminiProject(null)).toBe('')
    expect(parseGeminiProject('nope')).toBe('')
  })

  it('凭据身份优先用 email/sub，不用 access_token（后者每次续期都变）', () => {
    expect(geminiCredentialIdentity(cred())).toBe('user@example.com')
    expect(geminiCredentialIdentity(cred({ email: undefined, sub: 'SUB' }))).toBe('SUB')
    // 都没有才退回 token
    expect(geminiCredentialIdentity({ access_token: 'AT' })).toBe('AT')
  })
})

describe('gemini project 三级缓存', () => {
  it('★ 一级 / 二级命中 ⇒ 都不打 LCA', async () => {
    // 一级：进程内缓存
    const cached = new Map<string, string>([['user@example.com', 'CACHED']])
    const l1 = fakeFetch([lcaOk('{"cloudaicompanionProject":"SHOULD-NOT-BE-USED"}')])
    const p1 = await resolveGeminiProject({ credential: cred(), cache: cached, fetcher: l1.fetcher })
    expect(p1.project).toBe('CACHED')
    expect(p1.probed).toBeFalsy()
    expect(l1.calls).toHaveLength(0)

    // 二级：凭据字段（并回填一级）
    const empty = new Map<string, string>()
    const l2 = fakeFetch([lcaOk('{"cloudaicompanionProject":"SHOULD-NOT-BE-USED"}')])
    const p2 = await resolveGeminiProject({
      credential: cred({ cloudaicompanionProject: 'FROM-CRED' }),
      cache: empty,
      fetcher: l2.fetcher,
    })
    expect(p2.project).toBe('FROM-CRED')
    expect(l2.calls).toHaveLength(0)
    expect(empty.get('user@example.com')).toBe('FROM-CRED')
  })

  it('★ 三级：现探走 sandbox 优先；第一个端点失败回退 daily；探到真值进缓存', async () => {
    const cache = new Map<string, string>()
    const first = fakeFetch([lcaOk('{"cloudaicompanionProject":"CCP-PROBED"}')])
    const probe = await resolveGeminiProject({ credential: cred(), cache, fetcher: first.fetcher })
    expect(probe.project).toBe('CCP-PROBED')
    expect(probe.probed).toBe(true)
    expect(first.calls).toHaveLength(1)
    expect(first.calls[0]).toBe(`${GEMINI_ENDPOINT_SANDBOX}${GEMINI_LOAD_CODE_ASSIST_PATH}`)
    expect(cache.get('user@example.com')).toBe('CCP-PROBED')

    // sandbox 挂了 ⇒ 回退 daily（不放弃探测）
    const fallback = fakeFetch([
      () => new Response('boom', { status: 503 }),
      lcaOk('{"cloudaicompanionProject":"FROM-DAILY"}'),
    ])
    const retried = await resolveGeminiProject({ credential: cred(), fetcher: fallback.fetcher })
    expect(retried.project).toBe('FROM-DAILY')
    expect(fallback.calls).toHaveLength(2)
    expect(fallback.calls[1]).toBe(`${GEMINI_ENDPOINT_DAILY}${GEMINI_LOAD_CODE_ASSIST_PATH}`)
  })

  it('★ 「探测成功但为空」⇒ 兜底串且无 error；「探测失败」⇒ error', async () => {
    // 空 project 是免费档**常态**，不是失败 —— 必须照常发推理
    const empty = fakeFetch([lcaOk('{"currentTier":{"id":"free-tier","name":"Antigravity"}}')])
    const ok = await resolveGeminiProject({ credential: cred(), fetcher: empty.fetcher })
    expect(ok.project).toBe(GEMINI_DEFAULT_PROJECT)
    expect(ok.error).toBeUndefined()
    expect(ok.probed).toBe(true)

    // 非 2xx / 网络异常 = 真失败 —— 调用方据此**不发推理**
    const down = fakeFetch([
      () => new Response('{"error":{"code":500}}', { status: 500 }),
      () => new Response('{"error":{"code":500}}', { status: 500 }),
    ])
    const failed = await resolveGeminiProject({ credential: cred(), fetcher: down.fetcher })
    expect(failed.project).toBe('')
    expect(failed.error).toBeTruthy()

    const thrown = (async () => { throw new Error('fetch failed') }) as unknown as typeof fetch
    const thrownProbe = await resolveGeminiProject({ credential: cred(), fetcher: thrown })
    expect(thrownProbe.error).toContain('fetch failed')
  })
})

describe('gemini project 回写凭据', () => {
  it('★ 只回写真值（保留原有字段）；兜底串、「值没变」、写失败都不影响推理', async () => {
    // 真值 ⇒ 整份 JSON 回写，原有字段保留
    const written: string[] = []
    await persistGeminiProject({
      credential: cred(),
      project: 'CCP-REAL',
      write: async (value) => { written.push(value) },
    })
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0]!).cloudaicompanionProject).toBe('CCP-REAL')
    expect(JSON.parse(written[0]!).access_token).toBe('AT')

    const write = vi.fn(async () => {})
    // 兜底串不写 —— 否则该账号将来拿到真实 project 会被陈旧值挡住
    await persistGeminiProject({ credential: cred(), project: GEMINI_DEFAULT_PROJECT, write })
    // 值没变也不写 —— 避免每轮整体落盘
    await persistGeminiProject({
      credential: cred({ cloudaicompanionProject: 'SAME' }),
      project: 'SAME',
      write,
    })
    expect(write).not.toHaveBeenCalled()

    // 写失败只告警，不抛（纯缓存，不该影响推理）
    const warn = vi.fn()
    await expect(persistGeminiProject({
      credential: cred(),
      project: 'CCP-REAL',
      write: async () => { throw new Error('disk full') },
      logger: { warn },
    })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })
})
