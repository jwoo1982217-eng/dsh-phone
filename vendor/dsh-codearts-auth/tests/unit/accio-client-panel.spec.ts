/**
 * Accio（阿里）Jet Hub 客户端面板的断言。
 *
 * ## 为什么这一层必须是「源码文本 + 跨文件一致性」
 *
 * 本仓库的客户端是**无构建期类型检查**的裸 `React.createElement` 调用
 * （`react` 只在 esbuild 的 `external` 里、由宿主注入，`node_modules` 里没有它），
 * 所以「引用了不存在的符号」「传错 prop 名」这类错误编译期发现不了 ——
 * 只能靠这里的文本断言 + `pnpm build:client` 的语法检查兜住
 * （与 `opencode-client-panel.spec.ts` 同一取舍）。
 *
 * ⚠️ 但**纯文本断言会假绿**：改个写法、写段注释就能喂绿。故本文件里凡是
 * 「判据本身」的断言（正向分支、桶名、不接重登录）都锚定在**跨文件真相源**上：
 * `src/provider-registry.ts` / `src/accio-credits.ts`。
 *
 * ## ⚠️ 展示形态：与 Loomy **同形**（2026-10-13 改，用户报障）
 *
 * 用户报障原文（附截图对比）：「accio 的显示和别的 provider 没统一，例如 loomy 的」。
 *
 * accio 原先**另起一个独立区块**（`AccioDailyPanel`）显示三类桶 —— 与别家不一致。
 * 现改为与 loomy 同形：**积分行直接进账号卡片**，三类桶由 `CreditBalanceRow` 的
 * `formatNamedPoolLine` 逐池列出（`每日 199 · 每月 0 · 推荐 0`），
 * 「每日额度 ⋯ 后刷新」作为**同一行内**的附注。
 *
 * ⚠️ 下方仍保留「**没有**死控件」的断言 —— 那件事与本改动无关，仍然成立：
 * 「刷新每日额度」按钮需要宿主侧新增「重新登录既有账号」的 RPC
 * （`account.create` 每次都新造账号 id ⇒ 会造幽灵账号），在接线之前渲染它
 * 就是一个**骗人的控件**。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import { PROVIDER_ICONS } from '../../plugin-src/client/provider-icons.js'
import {
  CREDITS_CAPABILITIES,
  supportsCreditBalance,
  supportsDailyCheckin,
} from '../../plugin-src/client/credits-capabilities.js'
// ⚠️ 互斥性用例要**用真实数据**证明「两条分池线确实会撞车」（见该用例的注释）。
import { DAILY_POOL_NAMES } from '../../plugin-src/client/credit-expiry.js'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = resolve(here, '../../plugin-src/client')
const jetHub = readFileSync(resolve(CLIENT_DIR, 'jet-hub.js'), 'utf8')
const styles = readFileSync(resolve(CLIENT_DIR, 'jet-hub-styles.js'), 'utf8')
const accioCreditsSrc = readFileSync(resolve(here, '../../src/accio-credits.ts'), 'utf8')
const registrySrc = readFileSync(resolve(here, '../../src/provider-registry.ts'), 'utf8')

/**
 * 取一个**顶层函数声明**的函数体（到下一个顶层 `function ` 为止）。
 *
 * ⚠️ `indexOf` 的结果**必须先断言 `>= 0`** 再拿去切片：`-1` 会让
 * `slice(-1)` 静默切到「最后一个字符」，后续断言于是变成对一段无关文本的
 * 检查 —— 这正是本仓库记录的「找不到却全绿」形态。
 *
 * ⚠️⚠️ 找「下一个顶层 function」**必须用行尾无关的正则**，不能用
 * `indexOf('\nfunction ')`：本仓库 `core.autocrlf=true`，客户端源码在工作区是
 * **CRLF**，`'\nfunction '` 恒匹配不到 ⇒ `-1` ⇒ 回退成 `source.length` ⇒
 * 切出**整个文件尾部** ⇒ 后面的否定断言恒真（**假绿**，不是假红 —— 最坏的一种）。
 * 见 `tests/unit/source-scope.spec.ts`（issue IKJMG1）的同一形态。
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `未找到 function ${name}(`).toBeGreaterThanOrEqual(0)
  // ⚠️ `\r?\n` 兼容 CRLF 与 LF。
  const next = /\r?\nfunction /.exec(source.slice(start + 1))
  return next === null ? source.slice(start) : source.slice(start, start + 1 + next.index)
}

/**
 * 断言某个片段**确实存在**，并返回它（配合下面的「不存在」断言使用）。
 *
 * ⚠️ 非空断言的理由（本仓库的 `indexOf >= 0` 规则）：若片段找不到，
 * `expect(x).not.toContain(...)` 这类**否定**断言会**恒真** —— 一段根本不存在的
 * 文本当然不含被禁字符串。先在这里把「片段存在」断言掉，后面的否定断言才有意义。
 */
function requireFragment(source: string, fragment: string, label: string): string {
  const at = source.indexOf(fragment)
  expect(at, `未找到片段（${label}）：${fragment}`).toBeGreaterThanOrEqual(0)
  return fragment
}

describe('★ 图标', () => {
  it('accio 有图标', () => {
    expect(PROVIDER_ICONS.accio).toBeTruthy()
  })

  it('⚠️ registry 的 id 集合与图标表**逐一相等**（新增 provider 忘加图标会红）', () => {
    // ⚠️ 写成 `toEqual` 而不是「registry ⊆ icons」：后者漏掉「图标表多了一条
    // registry 没有的孤儿」这一侧。集合相等才对得上 provider-icons.js 文件头
    // 那句「条数 = registry 的 id 数」。
    const registryIds = PROVIDER_REGISTRY.map((d) => d.id).sort()
    const iconIds = Object.keys(PROVIDER_ICONS).sort()
    expect(iconIds).toEqual(registryIds)
  })

  it('accio 的 logoClass 与 registry 一致，且样式表给了白底容器', () => {
    expect(descriptorOf('accio')?.logoClass).toBe('accio')
    expect(styles).toMatch(/\.dim-jh-providerIcon\.accio\s*\{/)
  })
})

describe('★ 能力登记（从 registry 派生，不得手抄）', () => {
  it('balance: true、dailyCheckin: false', () => {
    expect(CREDITS_CAPABILITIES.accio).toEqual({ balance: true, dailyCheckin: false })
    expect(supportsCreditBalance('accio')).toBe(true)
    expect(supportsDailyCheckin('accio')).toBe(false)
  })

  it('⚠️ 因此通用「一键领取积分」对 accio 必然不渲染（dailyCheckin 是唯一闸门）', () => {
    expect(supportsDailyCheckin('accio')).toBe(false)
    // 宿主侧如实登记：Accio 没有签到端点。
    expect(accioCreditsSrc).toMatch(/没有签到端点/)
  })

  it('⚠️ registry 的注释**不得**再声称面板已有「刷新每日额度」入口', () => {
    // 那条承诺在本提交里**未兑现**（需要宿主 RPC）。注释若继续那么写，
    // 下一个读代码的人会去面板里找一个不存在的按钮。
    const start = registrySrc.indexOf("id: 'accio'")
    expect(start, '未找到 registry 的 accio 条目').toBeGreaterThanOrEqual(0)
    const entry = registrySrc.slice(start, registrySrc.indexOf("id: 'aggregate'", start))
    expect(entry, '未找到 accio 条目正文').not.toBe('')
    // 必须如实写明「尚未实现」，并保留 dailyCheckin 的理由。
    expect(entry).toMatch(/尚未实现|未实现|未接线/)
    expect(entry).toMatch(/没有签到端点/)
    // 「登录时发放」这个事实必须仍在（它是 dailyCheckin: false 的理由）。
    expect(entry).toMatch(/登录/)
  })
})


describe('★ accio 走通用积分行（与 Loomy 同形）', () => {
  it('⚠️ 按 provider **正向**分支（本仓库明确反对排除法/else 链）', () => {
    expect(jetHub).toMatch(/provider === 'accio'/)
    // 排除法形态必须不存在：`provider !== 'accio'` 会让「将来新增 provider
    // 时忘了登记」落进 accio 分支（或反之），且失败方向不可预测。
    expect(jetHub).not.toMatch(/provider !== 'accio'/)
  })

  it('⚠️ 专属区块已删除，且通用积分行对 accio 不再关掉', () => {
    const normalized = jetHub.replace(/\r\n/g, '\n')
    // ① 旧的专属面板必须彻底消失（组件、挂载点、样式类名）。
    expect(jetHub, 'AccioDailyPanel 组件必须已删除').not.toMatch(/function AccioDailyPanel/)
    expect(jetHub, '不得再有它的挂载点').not.toMatch(/createElement\(AccioDailyPanel/)
    expect(jetHub, '不得再有 accioPanel 变量').not.toMatch(/\baccioPanel\b/)
    expect(styles, '专属样式类必须已删除').not.toMatch(/\.dim-jh-accioPanel\b/)
    // ② 通用积分行必须**恢复**（原先写的是 `canLoadCredits && !accioPanel`）。
    expect(normalized, 'showCredits 不得再排除 accio')
      .not.toMatch(/showCredits:\s*canLoadCredits\s*&&\s*!/)
  })

  it('⚠️ 三类桶逐池列出：走 formatNamedPoolLine（不是两桶形状的 formatPoolSplitLine）', () => {
    // ⚠️ 三层都要在：import 进来、在 CreditBalanceRow 里按 provider 选中、真的渲染。
    expect(jetHub, '必须 import formatNamedPoolLine').toMatch(/formatNamedPoolLine,/)
    const row = functionBody(jetHub, 'CreditBalanceRow')
    requireFragment(row, 'namedPoolText', 'CreditBalanceRow 必须为 accio 取命名池文案')
    expect(row, '必须按 provider 正向分支选它').toMatch(/provider === 'accio'/)
    expect(row, '必须真的渲染它').toMatch(/namedPoolText\s*\n?\s*\?/)
  })

  /**
   * ⚠️⚠️ **两条分池线必须互斥**（真实缺陷，2026-10-13，用户报障附截图）。
   *
   * ## 缺陷形态
   *
   * `findDailyPool` 认的当日池名是 `['每日赠送', '每日积分']` —— 其中
   * **`每日积分` 恰好就是 accio 的每日桶名**。于是 `formatPoolSplitLine`
   * 对 accio 也会算出 `长期 0 · 每日 199`，与 `formatNamedPoolLine` 的
   * `每日 199 · 每月 0 · 推荐 0` **同时渲染** ⇒ 卡片上 `每日 199` 出现两遍。
   *
   * ## 为什么上一轮没抓到（本仓库的通用教训）
   *
   * 上面那条用例只断言了「`namedPoolText` 存在且被渲染」——**没有断言
   * `poolSplitText` 对 accio 为空**。所以「两条都在」这种**重复渲染**的形态
   * 照样全绿。⇒ 判据必须是**双向**的：既要在，也要**另一条不在**。
   *
   * ⚠️ 下面**用真实数据先证明「两者确实会撞车」**，再断言源码互斥 ——
   * 只断言源码形态的话，若将来 `DAILY_POOL_NAMES` 改了，这条用例会变成
   * 「守着一个已不存在的原因」，而真实数据那条会立刻暴露。
   */
  it('⚠️⚠️ 两条分池线互斥：accio 不得同时走 formatPoolSplitLine（否则每日出现两遍）', () => {
    // ── ① 先用真实池名证明「撞车」是真的（不是假想的） ──
    const accioDailyLabel = /\{ key: 'daily', label: '([^']+)' \}/.exec(accioCreditsSrc)?.[1]
    expect(accioDailyLabel, '未从 src/accio-credits.ts 读到 daily 桶展示名').toBeDefined()
    // ⚠️ 宿主下发的池名必须**仍在** findDailyPool 的识别集里 —— 这正是撞车的原因。
    //    若哪天 accio 换了桶名、或该集合删掉了它，本断言会红，提示「互斥的
    //    理由已变」，而不是静默保留一段无用的互斥代码。
    expect(
      DAILY_POOL_NAMES,
      `accio 的每日桶名 "${accioDailyLabel}" 必须在 findDailyPool 的识别集里（这就是撞车的原因）`,
    ).toContain(accioDailyLabel)

    // ── ② 再断言源码里两条线互斥 ──
    const row = functionBody(jetHub, 'CreditBalanceRow')
    requireFragment(row, 'poolSplitText', 'CreditBalanceRow 必须有 poolSplitText')
    // accio ⇒ poolSplitText 必须为 null（两条线互斥）。
    expect(
      row,
      '⚠️ accio 必须先短路成 null，不能落到两桶形状（否则与本行的命名池重复渲染）',
    ).toMatch(/poolSplitText\s*=\s*provider === 'accio'[\s\S]{0,120}?\?\s*null\s*:/)
  })

  it('⚠️ 倒计时作为**同一行内**的附注（不再另起区块）', () => {
    const row = functionBody(jetHub, 'CreditBalanceRow')
    requireFragment(row, 'accioResetNote', 'CreditBalanceRow 必须有 accio 倒计时文案')
    // 倒计时必须仍由宿主下发的 cycleEndTime 现算（不写死 86400）。
    const seconds = functionBody(jetHub, 'accioResetSeconds')
    expect(seconds, '倒计时必须读后端下发的 cycleEndTime').toMatch(/cycleEndTime/)
    // ⚠️ 不得把 86400 写死进客户端：它是**实测读数**，上游改刷新周期后会与
    //    真实重置时刻脱节，且没有任何报错。
    // ⚠️ 断言范围收在 accio 自己的两个函数体内，而不是整份 jet-hub.js ——
    //    别处有**既有**的 `86400000`（毫秒/天换算，与 accio 无关），会假失败。
    expect(seconds).not.toMatch(/86400/)
    expect(row, '积分行不得写死 86400').not.toMatch(/86400/)
  })

  it('⚠️ 倒计时不可读时整行不渲染（不编造一个倒计时）', () => {
    // 取不到每日桶 / 时刻不可解析时必须返回 null，而不是 0 或某个默认值。
    expect(functionBody(jetHub, 'accioResetSeconds')).toMatch(/return null/)
    expect(functionBody(jetHub, 'formatAccioResetCountdown'), '不可读的秒数必须返回 null')
      .toMatch(/return null/)
  })

  it('⚠️ 每日桶按**池名**定位，且池名与宿主逐字一致', () => {
    const row = functionBody(jetHub, 'CreditBalanceRow')
    requireFragment(row, 'accioResetSeconds', '积分行必须用池名定位每日桶')
    // 池名必须与宿主 `src/accio-credits.ts` 的 label 逐字一致，
    // 否则倒计时那一行会永远不出现（静默失效）。
    const dailyLabel = /\{ key: 'daily', label: '([^']+)' \}/.exec(accioCreditsSrc)?.[1]
    expect(dailyLabel, '未从 src/accio-credits.ts 读到 daily 桶的展示名').toBe('每日积分')
    expect(jetHub).toContain(`'${dailyLabel}'`)
  })

  it('⚠️ 必须写明「登录时发放」「24 小时」「不累积」，并给出**今天真能用**的手动路径', () => {
    // 三条缺一不可：少了「登录时」用户会去找领取按钮；
    // 少了「24 小时 / 不累积」用户会以为可以攒着。
    const note = jetHub.slice(jetHub.indexOf('const ACCIO_DAILY_REWARD_NOTE'))
    requireFragment(note, 'ACCIO_DAILY_REWARD_NOTE', '说明常量必须存在')
    expect(note).toMatch(/登录时/)
    expect(note).toMatch(/24 小时/)
    expect(note).toMatch(/不累积/)
    expect(note, '必须给出「删除该账号后重新登录」这条手动路径')
      .toMatch(/删除该账号后重新登录|删除.*重新登录/)
    // ⚠️ 说明常量必须**真的被渲染**（不是只定义不用）—— 它现在是倒计时那一行的
    //    tooltip（`title`），用户 hover 就能看到。
    expect(functionBody(jetHub, 'CreditBalanceRow'), '说明必须挂在倒计时行的 title 上')
      .toMatch(/ACCIO_DAILY_REWARD_NOTE/)
    // 它不得被写成「一键领取」这种误导性措辞 —— 那描述的是一个不存在的操作。
    expect(jetHub).not.toMatch(/一键领取每日/)
  })

  it('⚠️ **不得**渲染「刷新每日额度」死控件，也不得接 account.create 重登录', () => {
    // ── 这条是 reduced scope 的核心闸门，与本轮 UI 统一无关，仍然成立 ──
    // 现有 RPC 面上没有「重新登录**既有**账号」的出口：`account.create` 每次
    // 都用 `${provider}-${shortId()}` 现造 id 与 ref。接上它 = 多一条幽灵账号
    // 且原账号额度一点没刷新 ⇒ 宁可没有控件，也不做一个骗人的控件。
    //
    // ⚠️ 先把「积分行确实存在」断言掉：否则下面所有否定断言在一段**不存在**的
    //    文本上都恒真（本仓库的「找不到却全绿」形态）。
    const row = functionBody(jetHub, 'CreditBalanceRow')
    requireFragment(row, 'dim-jh-creditValue', '积分行的值节点')
    // ⚠️ 断言范围收在**积分行函数体**内，而不是整份 jet-hub.js：别处的注释会
    //    解释「为什么不做这个按钮」，那是诚实记录、不是控件。
    expect(row, '积分行内不得渲染任何按钮').not.toMatch(/createElement\('button'/)
    // ⚠️ 判据是**按钮文案**形态（引号开头），不是裸子串：倒计时那一行的 tooltip
    //    里合法地写着「距服务端刷新每日额度还剩的时间」，裸子串会假失败。
    expect(row, '不得把「刷新每日额度」渲染成文案').not.toMatch(/'刷新每日额度/)
    // 旧实现的按钮文案（带金额）必须彻底消失。
    expect(jetHub, '旧按钮文案必须已删除').not.toMatch(/刷新每日额度（200 积分）/)
    expect(jetHub, '确认弹窗必须已删除').not.toMatch(/AccioDailyRefreshDialog/)
    expect(jetHub, '不得保留重登录的执行函数').not.toMatch(/accioDailyRefresh/)
    expect(row, '不得调用 account.create').not.toMatch(/account\.create/)
    expect(row, '不得调用 credits.claim').not.toMatch(/credits\.claim/)
  })
})

describe('★ 样式', () => {
  it('⚠️ 注入的 <style> 必须署名 data-plugin（否则被别的插件认领后连带删除，IKK764）', () => {
    expect(styles).toMatch(/style\.dataset\.plugin = PLUGIN_ID/)
    expect(styles).toMatch(/style\.dataset\.pluginCss = STYLE_TAG_ID/)
  })

  it('⚠️ 模板字符串反引号恰好 2 个（注释里写反引号会提前闭合 STYLES）', () => {
    // STYLES 是模板字符串：注释里写字面反引号会提前闭合它，esbuild 报的错
    // 却指向注释那一行，看起来像 CSS 写错。整份文件只允许首尾那两个。
    const count = (styles.match(/`/g) ?? []).length
    expect(count, 'STYLES 之外多了一对反引号（大概率在注释里）').toBe(2)
  })

  it('⚠️ accio 图标底色仍在（只删了专属积分区的样式）', () => {
    // ⚠️ 删样式时最容易连带删掉图标那条 —— 它是**仍在使用**的。
    expect(styles, '图标底色必须保留').toMatch(/\.dim-jh-providerIcon\.accio\b/)
    expect(styles, '专属积分区的样式必须已删除').not.toMatch(/\.dim-jh-accioBuckets\b/)
  })
})
