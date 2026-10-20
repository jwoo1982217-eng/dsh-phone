/**
 * 仓库内**真实个人敏感信息**的防回归护栏。
 *
 * ## 为什么需要它（真实缺陷，2026-10-06）
 *
 * 用户在 Gitee issue IKJQ3M 的复核过程中指出：`README.md` 里写着一个真实
 * 腾讯云账号的手机号（「实测白号 `18582895338` 第一轮仅…」）。它是**排查
 * 过程中顺手贴进文档的实测证据**，但仓库是公开的，那个号码可被任何人检索。
 *
 * ⚠️ 这类泄露**极易复发**：实测记录天然带着「哪个账号、哪个号码、哪封邮箱」，
 * 而写文档时它们往往正是最有说服力的证据。
 *
 * ## 判据（刻意保守，宁可漏判不可误伤）
 *
 * 只拦**高置信度**形态，不去猜「这个号码是不是真的」：
 *
 * 1. **中国大陆手机号**：完整 11 位（`1[3-9]` 开头）。服务端下发的昵称
 *    （`130******00`）本身**已带星号**，不匹配该正则，无需豁免。
 * 2. **邮箱**：任何 `<local>@<domain>` 形态。仓库里的邮箱全部是真实账号
 *    （实测样本），没有「纯示例邮箱」这一说。
 *
 * ⚠️ **不拦**：测试目录里的占位号码（断言输入），以及
 * {@link CONSTRUCTOR_SAMPLES} 里逐条列出的**构造示例**
 * —— 那些号码是文档讲解脱敏函数时的输入（如 `src/lobsterai.ts` 的归一化
 * 示例表），判别依据是**构造痕迹**（连号 / 全零）。它们被改掉会让
 * 30+ 条用例失效与文档失真。
 * ⚠️ 白名单**必须逐条列出，不得改用「重复数字 / 连号」这类正则启发式** ——
 * 那会让判据随作者口味漂移，且真号码偶尔也会含重复位。
 *
 * ⚠️ 与 `scripts/audit-repo-secrets.mjs` 的分工：那个脚本还需读取
 * `~/.dsh/.credentials.yaml` 做「真实凭据反查」，且输出按 P0–P4 分档、
 * 需要人工判定；本用例**零依赖、纯形态判定、可直接进 CI**，守住下限。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读取已跟踪及准备新增的文本文件；忽略 Git 排除的本地资料。 */
function trackedTextFiles(): Array<{ path: string; text: string }> {
  const list = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '.'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out: Array<{ path: string; text: string }> = []
  for (const path of list.split(/\r?\n/).filter((p) => p.length > 0)) {
    // ⚠️ 测试目录豁免（见文件头「不拦」）：里面的号码是断言输入。
    if (path.startsWith('tests/')) continue
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue   // 二进制或已被删除
    }
    out.push({ path, text })
  }
  return out
}

/** 构造示例号码白名单（见文件头）。 */
const CONSTRUCTOR_SAMPLES: ReadonlySet<string> = new Set([
  '13011111100',
  '13011112222',
  '13800000000',
  '13800000001',
  '13800000002',
  '13000001100',
  '13000001111',
])

const FILES = trackedTextFiles()

describe('仓库内不得残留真实个人敏感信息', () => {
  it('入库文本文件里没有完整 11 位手机号', () => {
    // 真实缺陷：README.md 的「实测白号 18582895338」
    const re = /(?<!\d)1[3-9]\d{9}(?!\d)/g
    const hits: string[] = []
    for (const { path, text } of FILES) {
      for (const m of text.matchAll(re)) {
        if (CONSTRUCTOR_SAMPLES.has(m[0])) continue
        hits.push(`${path}: ${m[0].slice(0, 3)}****${m[0].slice(-2)}（第 ${text.slice(0, m.index).split('\n').length} 行）`)
      }
    }
    // ⚠️ 13 位时间戳（1790645562328 这类）与本正则不匹配（前后有数字），
    // 已实测确认不会误伤。
    expect(hits, '发现完整手机号，改成脱敏形态或换成账号 A/B 的措辞').toEqual([])
  })

  it('入库文本文件里没有真实邮箱', () => {
    const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
    const hits: string[] = []
    for (const { path, text } of FILES) {
      for (const m of text.matchAll(re)) {
        // ⚠️ git remote 形态（`git@gitee.com:wjm251/…`）里的 **用户名** 是
        // 仓库归属标识，**不是隐私**（它就写在仓库 URL 里），豁免。
        // 判据是「该行含 git@gitee.com」，只放过 remote 行，别把真实邮箱一并放过。
        if (/git@gitee\.com/.test(text.slice(Math.max(0, m.index - 40), m.index + 40))) continue
        const local = m[0].split('@')[0] ?? ''
        hits.push(`${path}: ${local.slice(0, 1)}***@${m[0].split('@')[1]}`)
      }
    }
    // 真实缺陷：gemini-credits.ts 的「实测第二个 Google 账号」、
    // zcode-auth.ts 的 issue 原文引用。
    expect(hits, '发现真实邮箱，改成 <账号已脱敏> 之类的措辞').toEqual([])
  })

  it('扫描面本身是有效的（否则上面两条是同义反复）', () => {
    // ⚠️ 反向验证护栏：若 git ls-files 失败或只扫到极少文件，上面两条
    // 会「因为扫不到东西」而恒绿 —— 那正是 AGENTS.md 点名的同义反复。
    expect(FILES.length, '应扫到足量入库文件').toBeGreaterThan(200)
    expect(FILES.some((f) => f.path === 'README.md')).toBe(true)
    // 证明两条用例的正则在**未脱敏前**确实能命中（把它们锁死为有效判据）。
    expect('实测白号 18582895338 第一轮'.match(/1[3-9]\d{9}/)).not.toBeNull()
    expect('yinghaolin521@gmail.com'.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)).not.toBeNull()
    // ⚠️ 豁免清单本身也要被验证，否则白名单可能悄悄放过真号码。
    expect(CONSTRUCTOR_SAMPLES.has('13011111100')).toBe(true)
  })
})