/**
 * 图片请求压力探针的共享件（issue !IKITT9）。
 *
 * 拆出来只为一个理由：**同一张图、同一套张数序列**必须用在所有 provider 上，
 * 否则「腾讯撞在 15 张、别家撞在 20 张」这种结论根本不可比。
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ImageRequestTarget } from '../../src/image-budget.js'

/** 2560×1600 的浏览器截图（地址栏 = `cn.bing.com`）。 */
export const FIXTURE_PATH = join(
  fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'test.png',
)

/**
 * ⚠️ **本 fixture 不入库**（`.gitignore` 已忽略 `tests/fixtures/test.png`）。
 *
 * 理由不是体积（2.87 MiB 也确实会让仓库永久膨胀），而是**它是真人桌面截图**：
 * 里面有浏览器标签页的用户名、搜索框里的检索词、整屏中文热搜。
 * 本仓库是公开的（gitee，任何人可 clone），一旦 commit 就**永久留在 git 历史**里 ——
 * 事后删文件、改写历史都清不干净，fork 出去的副本更是收不回。
 *
 * 所以探针在文件缺失时**整体跳过**（而不是报错），CI 与其他开发者不受影响。
 * 要跑图片压力探测，自备一张 ≥2000×1200 且**不含个人信息**的截图放到该路径：
 * 尺寸决定撞墙张数（每图面积 ÷ ≈617 = 视觉 token），内容只用来验证
 * 「缩放后还认不认得出小字」这一条。
 */
export function hasFixture(): boolean {
  return existsSync(FIXTURE_PATH)
}

export const FIXTURE_HINT = '缺少图片探针 fixture '
  + '（tests/fixtures/test.png，刻意不入库：真人桌面截图含隐私）。'
  + '请自备一张 ≥2000×1200 的无个人信息截图。'

/** issue 反推的计价比例，用来把实测边界换算成 token 做交叉验证。 */
export const PIXELS_PER_IMAGE_TOKEN = 617

/** 网关报的那条上限（issue 的失败报文里就是它）。 */
export const GATEWAY_IMAGE_TOKEN_LIMIT = 100_000

/**
 * 张数探测序列。
 *
 * ⚠️ **必须从 0/1 张起逐级加**，这是我第一版探针的实测教训：直接上 15 张
 * （≈57 MiB 请求体）时 qoder 报 `TRANSPORT: fetch failed`、raccoon 报
 * `AUTH 200003 authorization_verify_error` —— 两个都**不是**图片上限的报文，
 * 却会让整轮探测得出「撞墙了」的假结论。逐级加才能把
 * 「传输层 / 鉴权 / 请求体积」与「图片 token 预算」区分开；
 * 0 张基线回答的是「这个账号此刻到底通不通」。
 *
 * fixture 是 4.10M px/张 ≈ 6,639 token/张，按 617 px/token 推 **15 张越界**
 * （buddy 实测正是 15 张报 `100001 tokens > 100000 maximum`）。
 */
export const PROBE_COUNTS = [0, 1, 8, 15, 24]

/**
 * 探测目的只是回答「这家网关有没有类似腾讯的图片预算」，
 * 所以 24 张（≈159K token，已远超腾讯那道 100K）足够定性，
 * 不必跑到 32 张 —— 一次探测要上传十几张 4 MB 原图，额度与时间都不便宜。
 * （raccoon 那条对照用例显式传了自己的完整序列，因为它要量修复的余量。）
 */

/** 撞墙判据：只有图片 token 上限的报文算数，其余失败都说明探测被污染了。 */
export type BurstVerdict = 'overflow' | 'transport' | 'auth' | 'other' | 'ok'

export function classifyFailure(text: string, code?: string): BurstVerdict {
  if (isImageTokenOverflow(text)) return 'overflow'
  if (code === 'TRANSPORT' || /transport error|fetch failed|socket hang|ECONNRESET/i.test(text)) return 'transport'
  if (code === 'AUTH' || /authorization_verify|unauthorized|api 密钥/i.test(text)) return 'auth'
  return 'other'
}

export interface FixtureImage {
  ref: {
    attachmentId: string
    mediaType: 'image/png'
    bytes: number
    width: number
    height: number
  }
  data: Uint8Array
}

function digest(data: Uint8Array, salt: string): string {
  return `sha256-${createHash('sha256').update(data).update(salt).digest('hex')}`
}

export function loadFixture(): FixtureImage {
  const data = new Uint8Array(readFileSync(FIXTURE_PATH))
  // PNG IHDR：宽高在第 16/20 字节（大端）。
  const width = Buffer.from(data.subarray(16, 20)).readUInt32BE(0)
  const height = Buffer.from(data.subarray(20, 24)).readUInt32BE(0)
  return {
    ref: {
      attachmentId: digest(data, 'base'),
      mediaType: 'image/png',
      bytes: data.length,
      width,
      height,
    },
    data,
  }
}

/**
 * 造 count 张**互不相同的 attachmentId**。
 *
 * ⚠️ 必须互异：各适配器的 `collectImages` 都按 `attachmentId` 去重，
 * 复用同一个 id 会把 15 张压成 1 张 —— 探针会「顺利跑完」而实际
 * 一点图片压力都没制造出来，这类空测最难发现。
 */
export function imageBlocks(fixture: FixtureImage, count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'image',
    attachment: { ...fixture.ref, attachmentId: digest(fixture.data, `slot-${i}`) },
  }))
}

/** 报文里是否就是那句「N tokens > M maximum」。 */
export function isImageTokenOverflow(text: string): boolean {
  return /\b\d[\d,]*\s+tokens?\s*>\s*\d[\d,]*\s+maximum/i.test(text)
}

/**
 * 解析宿主自带的附件缩放器 `readRequestImageFile`。
 *
 * ⚠️ 它**不是本插件的依赖**（由 DSH 宿主提供），不能直接 `import`；
 * 也不能为了跑测试把它加进 `package.json` —— 缩放是宿主能力，
 * 插件生产代码只通过 `ctx.attachments` 拿它。
 * 全部候选根落空时抛错：宁可不出结果，也不要在测试里自己重写一遍缩放
 * （那测的就不是生产实现了）。
 */
export async function loadRequestImageFile(): Promise<(
  root: string, attachment: unknown, target: unknown, signal?: AbortSignal,
) => Promise<Record<string, unknown>>> {
  const roots = [
    ...(process.env.DSH_NODE_MODULES ? [process.env.DSH_NODE_MODULES] : []),
    join(dirname(process.execPath), 'node_modules'),
  ]
  const requireFrom = createRequire(import.meta.url)
  for (const root of roots) {
    for (const base of [root, join(root, '@deepseek-ai', 'dsh', 'node_modules')]) {
      try {
        const resolved = requireFrom.resolve('@deepseek-ai/dsh-attachment-local', { paths: [base] })
        const mod = await import(pathToFileURL(resolved).href) as Record<string, unknown>
        if (typeof mod.readRequestImageFile === 'function') return mod.readRequestImageFile as never
      } catch { /* 换下一个候选根 */ }
    }
  }
  throw new Error(
    '未找到 @deepseek-ai/dsh-attachment-local。'
    + '请设 DSH_NODE_MODULES 指向装有 dsh 的 node_modules 目录。',
  )
}

/**
 * 探测请求的 system 提示。
 *
 * ⚠️ **必须传，且两站无条件都带** —— 这不是探针的偷懒，而是
 * `src/account-probe.ts` 已确立的惯例：WorkBuddy 国际版网关强制要求
 * `messages[0]` 是 `role:'system'`，否则回 HTTP 400 + `code 11128`
 * `first message is not system prompt`，而 `displayMsg` 把它**伪装成
 * 「请求被安全策略拦截」**。实测本轮就撞上了：workbuddy 原图与缩放后
 * 都报那句安全拦截，看着像产品坏了，实际是探针少传一个字段。
 * （CodeBuddy 不校验，但判据不该依赖「另一个产品碰巧不校验」。）
 */
export const PROBE_SYSTEM = '你是自动化探针，按要求作答即可。'

export interface BurstResult {
  count: number
  ok: boolean
  /** 模型正文（成功时）。 */
  answer: string
  /** 失败时的错误码（用来验证分类，如 CONTEXT_WINDOW_EXCEEDED）。 */
  code?: string
  /** 失败时的错误文本。 */
  errorText: string
  /** 失败归类：只有 `overflow` 才是图片预算撞墙。 */
  verdict: BurstVerdict
}

/**
 * 用「count 张同一张图 + 一句固定文本」打一轮，按张数序列找到第一个撞墙点。
 *
 * ⚠️ 文本刻意要求模型只回答 `OK`：探针要测的是**网关的准入**，
 * 不是模型能力 —— 让输出尽量短能显著降低消耗。
 */
export async function probeImageBurst(options: {
  label: string
  /**
   * 由调用方构造适配器并发流。`system` 必须透传进 `GenerateOptions.system` ——
   * WorkBuddy 网关要求 `messages[0]` 是 system（见 PROBE_SYSTEM）。
   */
  stream: (messages: unknown[], signal: AbortSignal, system: string) => AsyncIterable<unknown>
  counts?: number[]
  prompt?: string
  system?: string
  timeoutMs?: number
}): Promise<BurstResult[]> {
  const counts = options.counts ?? PROBE_COUNTS
  const prompt = options.prompt
    ?? '下面这些图是同一个页面的重复截图，无需描述内容。只回答 OK。'
  const system = options.system ?? PROBE_SYSTEM
  const fixture = loadFixture()
  const results: BurstResult[] = []
  for (const count of counts) {
    let answer = ''
    let code: string | undefined
    let errorText = ''
    let ok = true
    try {
      for await (const chunk of options.stream(
        [{
          role: 'user',
          content: [{ type: 'text', text: prompt }, ...imageBlocks(fixture, count)],
        }],
        AbortSignal.timeout(options.timeoutMs ?? 300_000),
        system,
      )) {
        const c = chunk as { type?: string; text?: string; failure?: { code?: string } }
        if (c.type === 'text-delta' && typeof c.text === 'string') answer += c.text
        if (c.type === 'finish' && c.failure !== undefined) {
          ok = false
          code = c.failure.code
          errorText = String(c.failure.message ?? '')
        }
      }
    } catch (error) {
      ok = false
      const e = error as { code?: string; message?: string }
      code = typeof e.code === 'string' ? e.code : undefined
      errorText = e.message ?? String(error)
    }
    const estimated = Math.round(count * fixture.ref.width * fixture.ref.height / PIXELS_PER_IMAGE_TOKEN)
    const verdict: BurstVerdict = ok ? 'ok' : classifyFailure(errorText, code)
    console.log(`  [${options.label}] ${count === 0 ? '基线(无图)' : `${count} 张（估算 ≈${estimated} token）`} → `
      + `${ok ? `成功（${answer.trim().slice(0, 40)}）` : `${verdict}：code=${code ?? '?'} ${errorText.slice(0, 120)}`}`)
    results.push({ count, ok, answer: answer.trim(), code, errorText, verdict })
    // 只有真正的图片预算撞墙才值得停在边界上。
    if (verdict === 'overflow') break
    // 其余失败必须**中止并如实标注探测无效** —— 把 `TRANSPORT`／`AUTH`
    // 当成「撞墙」，就会得出「这家网关上限是 N 张」的假结论（我第一版就是这么错的）。
    if (verdict !== 'ok') {
      console.log(`  ⚠️ 探测中止：${verdict} 类失败与图片 token 预算无关，`
        + '不能据此判断该网关的上限。')
      break
    }
  }
  return results
}

/**
 * 用**生产的**缩放器把 fixture 缩到适配器给的目标，并记录每次产出。
 *
 * 探针因此测的是「适配器的目标尺寸 + 附件服务的真实编码器」这条完整链路，
 * 而不是在测试里自己写一遍缩放（那只会自证）。
 * 附件引用固定用 fixture 的真实元信息（`attachmentId` 只是缓存身份的一部分，
 * 探针里所有槽位共用同一份归一化字节即可）。
 *
 * ⚠️ `stats` 是「缩放是否真生效」的**可靠**证据来源。别指望事后 patch
 * `globalThis.fetch` 去嗅探请求体 —— 适配器在**构造时**就捕获了 fetch 引用，
 * 构造后再替换是静默空测（本轮实测到 `sentImageChars` 恒为 0，
 * 差点被误读成「缩放没减少字节 → target 没生效」这个假的产品缺陷）。
 */
export function makeScaleBridge(fixture: FixtureImage): {
  bridge: (
    attachment: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  stats: Array<{ target: ImageRequestTarget; outBytes: number; size: string }>
} {
  const cacheRoot = join(homedir(), '.dsh', 'cache', 'image-e2e')
  const stats: Array<{ target: ImageRequestTarget; outBytes: number; size: string }> = []
  let loader: ReturnType<typeof loadRequestImageFile> | undefined
  const bridge = async (_attachment: unknown, target: ImageRequestTarget) => {
    loader ??= loadRequestImageFile()
    const readRequestImageFile = await loader
    const projected = await readRequestImageFile(
      cacheRoot,
      { ref: fixture.ref, data: fixture.data },
      target,
      undefined,
    )
    stats.push({
      target,
      outBytes: Number(projected.bytes ?? 0),
      size: `${String(projected.width)}x${String(projected.height)}`,
    })
    return {
      data: projected.data as Uint8Array,
      mediaType: String(projected.mediaType),
    }
  }
  return { bridge, stats }
}

/**
 * 先跑 0 张基线，基线不通过就说明「探测前提不成立」，用例必须**跳过**。
 *
 * ⚠️ **这是本探针最容易丢的一条规矩**：本轮把几个用例改造成「只测缩放后」
 * （为了省额度，不再重跑已实测过的原图边界），结果**顺手把 0 张基线也删了** ——
 * 于是 cline 的当日免费额度耗尽（`429 Daily free limit reached... Try again in 20h`）
 * 被记成用例失败，看起来像「缩放没生效」。基线那一条请求几乎不花额度，
 * 却能把「账号不可用」与「图片链路有问题」这两件事彻底分开。
 *
 * 判据刻意**只看基线**：基线通过后，后续任何失败都算真失败（不许跳过）——
 * 否则就成了「一失败就跳过」的静默空测，比误报更糟。
 */
export function assertBaselineUsable(
  baseline: BurstResult | undefined,
  ctx: { skip: () => void },
  label: string,
): boolean {
  if (baseline !== undefined && baseline.ok) return true
  const verdict = baseline?.verdict ?? 'missing'
  console.warn(
    `  ⚠️ [${label}] 0 张基线就失败了（${verdict}：${baseline?.errorText.slice(0, 120) ?? '无结果'}）`
    + ` ⇒ 该账号此刻不可用（凭据过期 / 额度耗尽 / 风控），`
    + `**探测前提不成立，跳过而不是断言失败**。修好账号后重跑。`,
  )
  ctx.skip()
  return false
}

/**
 * 从 `.dsh/jet-hub/state.json` 取该 provider 第一个**启用**账号的 credentialRef。
 *
 * 探针绕开 cordis 运行时直接构造适配器（见本文件顶部理由），所以凭据要自己取。
 */
export function enabledAccountRef(provider: string): string {
  const state = JSON.parse(readFileSync(join(homedir(), '.dsh', 'jet-hub', 'state.json'), 'utf8')) as {
    accounts?: Array<{ provider: string; enabled?: boolean; credentialRef: string }>
  }
  const hit = (state.accounts ?? []).find((a) => a.provider === provider && a.enabled !== false)
  if (hit === undefined) {
    throw new Error(`账号池里没有启用的 ${provider} 账号（请在 Jet Hub 登录/启用后重试）`)
  }
  return hit.credentialRef
}

/**
 * 从 `.credentials.yaml` 取某 ref 的凭据 JSON。
 *
 * ⚠️ **不能按「找 `{` 再配平大括号」手扫**（`buddy-pool-probe` 的老写法）：
 * 凭据是 YAML **单引号标量**，值一长（workbuddy 的有 2,165 字符）就会被
 * 折行成多行 + 缩进，手扫会把裸换行带进 JSON → `Bad control character in
 * string literal`。实测同一份探针里 buddy 的凭据侥幸没折行、workbuddy 的折了，
 * 于是表现为「只有国际版解析失败」—— 极易误判成产品问题。
 */
export function credentialFor(ref: string): Record<string, unknown> {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const keyLine = new RegExp(`^[ \\t]*${ref}:[ \\t]*`, 'm').exec(text)
  if (keyLine === null) {
    throw new Error(`凭据 ${ref} 未找到（该 provider 可能未登录）`)
  }
  return JSON.parse(parseYamlScalar(text.slice(keyLine.index + keyLine[0].length))) as Record<string, unknown>
}

/**
 * 解析 YAML 标量。折行统一折叠为**一个空格**，不实现「空行还原成换行」那条特例：
 * 凭据是 JSON 文本，其语法本身不需要换行；真含换行的字段值会由写入方用
 * `''` 或双引号 `\n` 显式表示，不走折行。少一条分支就少一处错。
 */
function parseYamlScalar(rest: string): string {
  if (rest[0] === "'" || rest[0] === '"') return parseQuoted(rest, rest[0])
  const newline = rest.indexOf('\n')
  return (newline < 0 ? rest : rest.slice(0, newline)).trim()
}

function parseQuoted(rest: string, quote: string): string {
  let out = ''
  let i = 1
  while (i < rest.length) {
    const ch = rest[i]
    if (ch === quote) {
      if (quote === "'" && rest[i + 1] === "'") { out += "'"; i += 2; continue }
      return out.trim()
    }
    if (quote === '"' && ch === '\\') { out += rest[i + 1]; i += 2; continue }
    if (ch === '\n' || ch === '\r') {
      i += 1
      while (i < rest.length && /\s/.test(rest[i])) i += 1
      out += ' '
      continue
    }
    out += ch
    i += 1
  }
  throw new Error(`未闭合的 YAML ${quote === "'" ? '单' : '双'}引号标量`)
}

