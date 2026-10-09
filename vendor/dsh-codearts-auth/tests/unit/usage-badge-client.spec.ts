import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * 用量徽标的**客户端接线**回归。
 *
 * ⚠️ 为什么是源码级断言而不是渲染测试：`plugin-src/client/usage-badge.js` 依赖
 * **宿主注入的 `react`**（esbuild 的 external），本仓库的 node_modules 里没有
 * react，故无法在 vitest 里渲染它 —— 与 `cline-quota-panel.spec.ts` /
 * `raccoon-client-panel.spec.ts` 的处境相同。
 *
 * 本文件守住的是「接线」：槽位挂在哪、门控用的是不是**能力表**、轮询与隐藏页
 * 行为、失败是否保留上次读数、按钮是否由能力表门控、依赖是否声明、样式是否齐备。
 * 文案与模式选择由 `badge-model.spec.ts`（纯函数，真实现）覆盖；
 * 宿主侧聚合由 `usage-badge.spec.ts` 覆盖；套餐判定由 `badge-subscription.spec.ts` 覆盖。
 */

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, '../..', rel), 'utf8')

/**
 * 去掉注释后的源码（块注释 + **整行** `//` 注释都要去）。
 *
 * ⚠️ 反面断言（`not.toContain`）必须基于它：本仓库的注释里**大量引用**被禁止的
 * 写法（例如「判定来自能力表而不是 `PROVIDERS.includes()`」「按钮文案不写
 * `签到（仅 …）`」），直接对全文断言会把注释本身判成违规 —— 第一次写这类用例时
 * 就这么红过两次（块注释一次、`//` 行注释一次）。
 *
 * ⚠️ 只去「整行以 `//` 开头」的注释，故字符串里的 `https://…` 不会被误删。
 */
const codeOf = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

describe('用量徽标：槽位接线', () => {
  const index = read('plugin-src/client/index.js')

  it('注入 modelDirectories（当前渠道的唯一来源）', () => {
    expect(index).toContain("export const inject = ['slots', 'connection', 'modelDirectories'")
  })

  it('⚠️⚠️ 徽标宽度必须收敛（否则挤压右侧模型选择器）', () => {
    // 真机报障 2026-10-02：徽标 flex:none + max-width:280px 把模型选择器
    // 压到只剩几十 px，**图标被挤没**（用户要放大到很大才看得见）。
    // 两级收敛（用户定 1+2）：基础宽度有上限，窄屏（<720px）只剩状态点。
    const styles = read('plugin-src/client/jet-hub-styles.js')
    const btn = /\.dim-jh-badgeBtn \{[^}]*max-width:\s*(\d+)px/.exec(styles)
    expect(btn, '应能解析出徽标按钮的 max-width').not.toBeNull()
    // ⚠️ 两个维度都要满足，缺一不可：
    // ① **内容自适应**：.dim-jh-badgeBtn 不设 width，由文字撑开
    //    （短内容就短：Cline • 5积分 仅 93px）；
    // ② **上限兜底**：max-width 必须 ≥ 实测最宽需求，且 ≤ 会挤坏模型选择器的值。
    //
    // 实测（Edge，宿主 UI 字体栈，dsf 1 与 1.5 都量过，差异 <0.4px）：
    // 13 个渠道展示名 × 10 种现实读数（含 123456.78积分 / 9499.84积分 /
    // 94.54MToken / 0积分）共 130 组，最宽需求 **209.34px**
    //（WorkBuddy (国际版) • 123456.78积分）。
    //
    // ⚠️ 下界取 210（刚够最宽需求），上界取 240 —— 实测把上限放到「无上限」时，
    // 极窄 composer（220px）下胶囊会**溢出容器 8.3px**，那正是 2026-10-02
    //「模型选择器图标被挤没」的形态。故既有上限、又不能太小。
    expect(Number(btn![1]), '徽标上限应能装下最长的「渠道名 • 读数」（实测需求 209.34px）')
      .toBeGreaterThanOrEqual(210)
    expect(Number(btn![1]), '徽标上限不得超过 240px（否则窄容器下会溢出、挤压模型选择器）')
      .toBeLessThanOrEqual(240)
    // ⚠️ 反向断言：不得写成固定 width（那会让短内容也占满，
    // 既浪费横向空间，又让「内容自适应」失效）。
    // 只取该规则体本身来判，避免正则跨规则误伤。
    const btnRule = /\.dim-jh-badgeBtn \{([^}]*)\}/.exec(styles)
    expect(btnRule, '应能取到 .dim-jh-badgeBtn 的规则体').not.toBeNull()
    expect(btnRule![1], '胶囊不得设固定宽度（会破坏内容自适应）')
      .not.toMatch(/(^|[;\s])width:/)
    expect(styles, '窄屏应收敛为只剩状态点').toMatch(/@media \(max-width: 720px\)/)
    expect(styles, '需 min-width:0 才能真正收缩/省略').toMatch(/min-width: 0/)
  })

  it('⚠️⚠️ 折叠态必须渲染成**多个** span（否则数字仍会被截掉）', () => {
    // 真实报障 2026-10-03：胶囊显示成「LobsterAI (有道) · 合计 …」，数字被截掉。
    // 根因是**结构**而非宽度：整句塞进一个 overflow:hidden 的 span，省略号
    // 从右往左吃，吃掉的正是用户唯一想看的数字。
    const styles = read('plugin-src/client/jet-hub-styles.js')
    // ⚠️ 反面断言一律用 codeOf（去注释）：本仓库注释里大量引用被禁止的写法，
    // 直接对全文断言会把注释本身判成违规 —— 本次就真踩了（我把「不得复用
    // .dim-jh-badgeValue」写进了注释，于是 not.toContain 把注释当成了违规）。
    const badge = codeOf(read('plugin-src/client/usage-badge.js'))
    // 三段各自独立成 span
    expect(badge).toContain("className: 'dim-jh-badgeText'")
    expect(badge).toContain("className: 'dim-jh-badgeName'")
    expect(badge).toContain("className: 'dim-jh-badgeSep'")
    // ⚠️ 类名是 Reading 而**不是** Value：那个名字已被弹窗里的读数占用，
    // 那条规则带 font-weight:600 且排在样式表更后面 —— 同名会让胶囊里的数字被静默
    // 加粗、并拿到 flex:none 而**无法收缩**（正是本次报障的形态，而且很难看出来）。
    // ⚠️ 断言必须**限定在折叠态那一块**内：弹窗里本来就用 .dim-jh-badgeValue
    //（那是它的正当用途），对整个文件断言 not.toContain 会误伤。
    const collapsedAt = badge.indexOf('const collapsed = React.createElement')
    const collapsedEnd = badge.indexOf('return React.createElement(\'div\'', collapsedAt)
    expect(collapsedAt, '应有折叠态 collapsed 的构造').toBeGreaterThan(-1)
    expect(collapsedEnd, '应能取到折叠态构造的结尾').toBeGreaterThan(collapsedAt)
    const collapsedBlock = badge.slice(collapsedAt, collapsedEnd)
    expect(collapsedBlock, '折叠态读数不得复用弹窗的 .dim-jh-badgeValue 类名')
      .not.toContain('dim-jh-badgeValue')
    expect(collapsedBlock).toContain("className: 'dim-jh-badgeReading'")
    // ⚠️ 反向断言：整句不能再被当作**单个文本子节点**塞进那几个 span。
    // （view.text 仍用于 title / aria-label，故只禁止它以「唯一子节点」的形态出现。）
    expect(badge, '整句不应再作为唯一子节点直接渲染')
      .not.toMatch(/className: 'dim-jh-badgeText' \}, view\.text\)/)
    // 名字进 name、读数进 reading（不是反的）
    expect(badge).toContain('}, view.name)')
    expect(badge).toContain('}, view.reading)')
    expect(badge, '读数不能渲染进名字那个 span（会显示成「200积分 • WorkBuddy」）')
      .not.toMatch(/dim-jh-badgeName' \}, view\.reading\)/)
    // 让位顺序由 flex-shrink 表达：detail(999) > name(99)，而**读数不参与收缩**。
    const shrink = (cls: string) => {
      const rule = new RegExp('\\.' + cls + ' \\{[^}]*flex:\\s*0\\s+(\\d+)\\s+auto').exec(styles)
      expect(rule, '应能解析 .' + cls + ' 的 flex-shrink').not.toBeNull()
      return Number(rule![1])
    }
    expect(shrink('dim-jh-badgeDetail'), '包名最先让位').toBeGreaterThan(shrink('dim-jh-badgeName'))
    // ⚠️⚠️ 读数必须是 flex: none（**完全不收缩**）—— 这是本缺陷的第二个成因，
    // 而且比第一个隐蔽得多：哪怕只分到 0.77px 的收缩，text-overflow: ellipsis
    // 也会命中（触发条件是 scrollWidth > clientWidth，亚像素级就够），
    // 于是最后一个字被换成「…」，视觉上和整段被截一样严重。
    // ⚠️ 而且它**用 clientWidth 量不出来**（取整：53.97 报成 54，判为未截断）——
    // 我第一版就写成 flex: 0 1 auto 并用 clientWidth 断言「读数完整」，
    // 用例全绿而截图里明写着「347.87积…」。故这里锁死 flex: none。
    expect(styles, '读数不得参与收缩（亚像素收缩也会触发省略号）')
      .toMatch(/\.dim-jh-badgeReading \{[^}]*flex:\s*none/)
    expect(styles, '读数不得带 text-overflow: ellipsis')
      .not.toMatch(/\.dim-jh-badgeReading \{[^}]*text-overflow/)
    // 分隔符不参与收缩（否则「•」会先被挤掉）
    expect(styles).toMatch(/\.dim-jh-badgeSep \{[^}]*flex:\s*none/)
    // ⚠️ 间距必须用 margin：flex 容器把 span 之间只含空白的文本节点渲染成零宽。
    expect(styles).toMatch(/\.dim-jh-badgeSep \{[^}]*margin:\s*0 3px/)
  })

  it('⚠️⚠️ 窄屏「只留状态点」的媒体查询必须排在 .dim-jh-badgeText 之后', () => {
    // 两者特异性相同（都是单个类），胜负由**源顺序**决定。媒体查询一旦被排到
    // 「.dim-jh-badgeText { display: flex }」之前，窄屏下 display:none 会被
    // 后面的 display:flex 覆盖 —— 文字重新出现并挤压模型选择器（静默回归，
    // 因为在宽窗口下看不出任何异常）。
    const styles = read('plugin-src/client/jet-hub-styles.js')
    const textRuleAt = styles.indexOf('.dim-jh-badgeText { display: flex')
    const mediaAt = styles.indexOf('@media (max-width: 720px) { .dim-jh-badgeText')
    expect(textRuleAt, '应有 .dim-jh-badgeText { display: flex ... }').toBeGreaterThan(-1)
    expect(mediaAt, '应有隐藏 .dim-jh-badgeText 的窄屏媒体查询').toBeGreaterThan(-1)
    expect(mediaAt, '媒体查询必须晚于 display:flex 规则，否则 display:none 会被覆盖')
      .toBeGreaterThan(textRuleAt)
  })

  it('⚠️⚠️ 当前 SDK 注入 sessions，不等待已删除的 remote.session', () => {
    // `directoryFor(sessionId)` 内部读 `this.ctx.sessions` 与
    // `this.ctx.remote.session`（源码见 @deepseek-ai/dsh-client-ui-model-selection
    // 的 client.js，该包自己的 inject 就是 ["sessions","remote","remote.session"]）。
    // cordis 逐插件校验 inject，漏声明就会抛
    // `cannot get property "remote.session" without inject`
    // ⇒ desktop 徽标永久不显示。
    const m = /export const inject = \[([^\]]*)\]/.exec(codeOf(index))
    expect(m, '应能解析 export const inject').not.toBeNull()
    const list = m![1]!
    for (const svc of ['modelDirectories', 'sessions']) {
      expect(list, `inject 缺少 ${svc}`).toContain(`'${svc}'`)
    }
    expect(list).not.toContain("'remote.session'")
  })

  it('注册到 conversation.input.right（模型选择器旁的 list 槽）', () => {
    expect(index).toContain("ctx.slots.inject('conversation.input.right'")
    expect(index).toContain("name: 'conversation.input.right'")
    expect(index).toContain("id: 'jet-hub-usage'")
  })

  it('目录按会话惰性解析（不缓存 directory 对象）', () => {
    expect(index).toContain('ctx.modelDirectories.directoryFor(sessionId).store')
    expect(index).toMatch(/inject:\s*\(sessionId\)\s*=>/)
  })

  it('注入四个 RPC 包装：读读数 / 写偏好 / 写自动签到开关 / 签到', () => {
    expect(index).toContain("readBadge: (provider, options) => rpcCall('usage.badge'")
    expect(index).toContain("writePreference: (preference) => rpcCall('usage.badgePreference'")
    expect(index).toContain("setAutoCheckin: (enabled) => rpcCall('usage.autoCheckin'")
    // 签名带 runTasks / budgetMs：`credits.claimAll` 同时是「每日首次启动自动签到」
    // 的执行体，成长任务只能由手点按钮时显式开启。
    expect(index).toContain("claimCredits: (provider, runTasks, budgetMs) =>")
    expect(index).toContain("rpcCall('credits.claimAll', { provider, runTasks, budgetMs })")
    // ⚠️ runTasks 绝不能有 `= true` 之类的缺省：那会让开机自动签到每轮都跑一遍
    // 成长任务（单账号 90～270s、全串行）。
    expect(index).not.toMatch(/claimCredits: \(provider, runTasks[^)]*=/)
    expect(index).not.toMatch(/runTasks:\s*true/)
    // ★ 按钮文案必须**按渠道条件化**：有成长任务的渠道要显示成长字样。
    //
    // 理由：成长一轮单账号实测 90～270s 且全串行，而「一键领取积分」这个文案
    // 原本只表示毫秒级的每日签到。让用户点之前不知道要等几分钟，是拿可用性
    // 换代码简洁。
    const hub = read('plugin-src/client/jet-hub.js')
    expect(hub).toMatch(
      /supportsGrowthTasks\s*\?\s*\x27一键领取积分 \+ 成长任务\x27\s*:\s*\x27一键领取积分\x27/
    )
    // 无成长任务的渠道文案必须逐字不变，避免无关渠道被波及。
    expect(hub).toContain('一键领取积分')
    // 成长字样只许出现在这条按钮上，不得再有第二个独立按钮。
    expect(hub).not.toContain('一键完成成长任务')
    expect(hub).not.toContain('一键全部完成任务并领取积分')
  })

  it('渠道展示名复用 jet-hub.js 的 providerLabel（不另抄一份名字表）', () => {
    expect(index).toMatch(/import \{[^}]*providerLabel[^}]*\} from '\.\/jet-hub\.js'/)
    expect(index).toContain('providerLabel,')
  })
})

/**
 * 「一键领取积分」的**重入闸门**（复审 !62 补）。
 *
 * 背景：成长任务一轮单账号实测 90～270s（数十个上游请求），而按钮的
 * `disabled: claiming` 依赖**异步** state（`setClaiming(true)` 要等 re-render
 * 才生效）。同一 tick 内连点两次时，第二次读到的 `claiming` 仍是 `false`
 * ⇒ 两轮全量领取并发跑，对同一账号同一批任务并发 `POST /v2/report` 与 claim，
 * 幂等全押在服务端，并放大风控面。
 *
 * ⇒ 必须用 `useRef` 做**同步**闸门（写 ref 不经 React 调度），
 * 与同文件既有的 `pollRef`（登录重入）同款做法。
 *
 * ⚠️ 与 `usage-badge-client.spec.ts` 的其余用例同理：这里只能做**源码级断言**
 * （`plugin-src/client/jet-hub.js` 依赖宿主注入的 react，vitest 里渲染不了）。
 */
describe('一键领取的重入闸门（成长任务一轮可达数分钟）', () => {
  const hub = read('plugin-src/client/jet-hub.js')
  const hubCode = codeOf(hub)

  it('用 useRef 做同步闸门，而不是拿 claiming（state）当判据', () => {
    expect(hub).toContain('claimInFlightRef = React.useRef(false)')
    // 闸门必须是 claimCredits 的**首个**守卫（在任何 await 之前）：
    // 断言 `if (claimInFlightRef.current)` 出现在函数体内、且早于 setClaiming。
    const fnStart = hubCode.indexOf('const claimCredits = async () =>')
    expect(fnStart).toBeGreaterThan(-1)
    const guard = hubCode.indexOf('if (claimInFlightRef.current)', fnStart)
    const setClaiming = hubCode.indexOf('setClaiming(true)', fnStart)
    expect(guard).toBeGreaterThan(fnStart)
    expect(setClaiming).toBeGreaterThan(guard)
  })

  it('拦住后必须给出提示，不得静默 return（IKJLK3 B 的同款教训）', () => {
    // 用户看到「点了没反应」分不清「没反应」与「正在处理」——成长任务
    // 一轮数分钟，必须明确告知还在跑。
    expect(hub).toContain('上一次领取仍在进行中')
  })

  it('闸门必须无条件释放，不能跟着 mounted 一起判', () => {
    // 若写成 `if (mounted.current) claimInFlightRef.current = false`（或包在
    // `if (mounted.current) { … }` 块里），卸载后闸门永久停在 true
    // ⇒ 切回面板再点永远收到「上一次仍在进行中」——闸门卡死。
    //
    // ⚠️ 判据必须**直接检查该语句所在的行**，不能只用「回看若干字符」的正则：
    // 把闸门与 `if (mounted.current)` 写在**同一行**时，任何向前回看的窗口都
    // 匹配不到（反向验证时实测到了这个漏洞，改坏了却不变红）。
    const guardLines = hubCode
      .split('\n')
      .filter((line) => line.includes('claimInFlightRef.current = false'))
    expect(guardLines.length).toBeGreaterThanOrEqual(1)
    for (const line of guardLines) {
      // 允许「同一行里先有 mounted 判定」以外的任何写法；只禁两种常见误写：
      // ① 与该赋值同行出现 `if (mounted.current)`
      // ② 该赋值被 `if (mounted.current) {` 之后紧邻（同块首句）
      expect(line).not.toMatch(/if \(mounted\.current\)/)
    }
    // 卸载清理那一处（与 pollRef 同块）本就**应该**在 `mounted.current = false`
    // 之后执行 —— 它清闸门是刻意的，故上面只禁「同行带 mounted 判定」，
    // 不禁「位于清理函数内」。
  })

  it('卸载 / 切 provider 时清闸门（否则新面板首次点击被误拦）', () => {
    // 该清理 effect 依赖 provider：切渠道会重跑（mounted 复位为 true）。
    // 闸门若残留 true，新 provider 面板的首次点击会被误判成「仍在进行中」。
    // 断言「清理函数里也把闸门置回 false」——即该赋值出现**两次以上**
    // （finally 一次 + 卸载清理一次）。
    const assignments = hubCode.split('claimInFlightRef.current = false').length - 1
    expect(assignments).toBeGreaterThanOrEqual(2)
    // 且其中一次必须与 pollRef 的清理同处一个清理函数内。
    const cleanupIdx = hubCode.indexOf('clearInterval(pollRef.current); pollRef.current = 0;')
    expect(cleanupIdx).toBeGreaterThan(-1)
    const afterCleanup = hubCode.slice(cleanupIdx, cleanupIdx + 400)
    expect(afterCleanup).toContain('claimInFlightRef.current = false')
  })
})

describe('用量徽标：渲染门控与轮询', () => {
  const badge = read('plugin-src/client/usage-badge.js')
  const badgeCode = codeOf(badge)

  it('门控来自能力表（不是写死 provider 字面量或 PROVIDERS 列表）', () => {
    expect(badge).toContain('if (!supportsCreditBalance(provider)) return null;')
    // ⚠️ 不得改成 `PROVIDERS.includes(provider)`：能力表是与服务端分派对齐的
    // 唯一真相源（漏登记的渠道会静默失去徽标，或反过来对不存在的渠道发请求）。
    expect(badgeCode).not.toContain('PROVIDERS.includes')
    expect(badgeCode).not.toContain('PROVIDERS.some')
  })

  it('没有选中模型时整体不渲染（新会话 / 已寻址 subagent 会话）', () => {
    expect(badge).toMatch(/typeof provider !== 'string' \|\| provider\.length === 0/)
  })

  it('轮询 60 秒，且隐藏标签页跳过、切回立即刷新', () => {
    expect(badge).toContain('export const BADGE_POLL_MS = 60_000;')
    expect(badge).toContain("document.visibilityState === 'hidden'")
    expect(badge).toContain("document.addEventListener('visibilitychange', onVisible)")
    expect(badge).toContain('setInterval(')
  })

  it('读取失败保留上一次成功读数（不把旧数字清空），并记下原因', () => {
    // catch 分支只置失败标记 + 记原因，**不**清 snapshot。
    // ⚠️ 正则写成 `catch (\w*)`：分支现在是 `catch (error)`（要拿错误翻译文案），
    // 旧的 `catch \{` 会在这个无害重构上假失败。
    expect(badge).toMatch(/catch \(\w*\) \{[\s\S]{0,260}?setFailed\(true\)/)
    expect(badgeCode).not.toMatch(/catch \(\w*\) \{[\s\S]{0,260}?setSnapshot\(null\)/)
    // 失败原因必须经 describeBadgeError 翻译（裸的 unknown method 对用户无意义）
    expect(badge).toContain('setReadError(describeBadgeError(error))')
  })

  it('只认领属于当前渠道的响应（并发/切渠道时不会画错）', () => {
    expect(badge).toContain("if (value?.provider !== undefined && value.provider !== provider) return;")
  })

  it('切渠道时先清空旧读数', () => {
    expect(badge).toMatch(/React\.useEffect\(\(\) => \{\s*setSnapshot\(null\)/)
  })

  it('三类读取语义分明：挂载走缓存 / 轮询跳过隐藏页 / 刷新才 force', () => {
    // 挂载（含切渠道后）：不 force、不跳过 —— 走宿主缓存，有缓存就立刻出数
    expect(badge).toMatch(/read\.current = \(\) => \{ void load\(\{ force: true \}\); \};\s*\n\s*void load\(\);/)
    // 轮询与「切回前台」带 poll 标记（只有它们跳过隐藏页）
    expect(badge).toContain('void load({ poll: true })')
    expect(badge).toContain("if (options.poll === true && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;")
    // 请求本身：只有 force 形态才带 { force: true }
    expect(badge).toContain('await readBadge(provider, force ? { force: true } : {});')
    // ⚠️ 挂载**不得**再写成 force（用户报障「反应有点慢」的根因：每次挂载都
    // 绕过宿主 120s 缓存，逐账号重打上游）
    expect(badge).not.toContain('void load(true)')
  })

  it('首屏状态显式传给展示层（不能靠「账号列表为空」推断）', () => {
    expect(badge).toMatch(/loading: snapshot === null && !failed/)
    expect(badge).toMatch(/failed: failed && snapshot === null/)
  })

  it('首屏读数未到时不渲染明细区（否则会说成「该渠道还没有账号」）', () => {
    // 首屏只给一句说明 + 签到按钮，然后 return（不 push 订阅/积分区）
    expect(badge).toContain("key: 'placeholder'")
    expect(badge).toContain('正在读取用量…')
    expect(badge).toMatch(/children\.push\(renderClaim\(\)\);\s*\n\s*return React\.createElement\('div', \{ className: 'dim-jh-badgePop' \}, children\);/)
  })

  it('客户端**不**直接调 credits.balances（那是逐账号打上游的端点）', () => {
    // 该端点由宿主侧 `usage.badge` 内部复用（带 TTL 缓存），客户端直连会让
    // 上游请求数随「轮询次数 × 账号数」放大。
    expect(badgeCode).not.toContain('credits.balances')
    expect(badgeCode).toContain('readBadge(')
  })
})

describe('用量徽标：签到（本渠道 + 全部渠道）', () => {
  const badge = read('plugin-src/client/usage-badge.js')
  const badgeCode = codeOf(badge)

  it('本渠道按钮由能力表门控（WorkBuddy 国际版 / Cline / Raccoon 不渲染）', () => {
    expect(badge).toContain('const canClaimCurrent = supportsDailyCheckin(provider);')
    expect(badge).toMatch(/canClaimCurrent\s*\n?\s*\? React\.createElement\('button'/)
  })

  it('本渠道按钮文案不带渠道名（否则 300px 弹窗里会被省略号截断）', () => {
    // 截图核验发现：`签到（仅 CodeBuddy (腾讯)）` 被截成 `签到（仅 CodeBuddy (…`
    expect(badge).toContain("'签到（本渠道）'")
    // ⚠️ 反面断言必须基于**去注释后的代码**：上面那条解释性注释里就写着被禁的写法
    expect(codeOf(badge)).not.toContain('签到（仅 ')
    // 渠道名改到 title 里，信息不丢（注意源码用的是**全角**括号）
    expect(badge).toContain('只签到当前渠道（${label}）的全部账号')
  })

  it('本渠道没有签到接口时明说原因（用户报障「单渠道签到哪里去了」）', () => {
    // Cline / WorkBuddy 国际版 / Raccoon 打开弹窗只看到「全部渠道签到」，
    // 必须有一句说明，否则用户以为按钮丢了。
    expect(badge).toContain('该渠道没有签到接口，签到请用「全部渠道签到」')
    expect(badge).toMatch(/canClaimCurrent\s*\n\s*\? null\s*\n\s*: React\.createElement\('div', \{ key: 'nocount'/)
  })

  it('「全部渠道签到」串行遍历能力表推导出的渠道集合（不新增后端端点）', () => {
    // 用户 2026-10-02 选 B：弹窗里同时提供「仅本渠道」与「全部渠道」
    expect(badge).toContain('const providers = checkinProviders();')
    // ⚠️ 必须串行 await：真实领积分的写操作，跨渠道并发会触发风控
    expect(badge).toMatch(/for \(let index = 0; index < providers\.length; index \+= 1\)/)
    expect(badgeCode).not.toContain('Promise.all')
    // 逐个渠道调同一个端点，不新增后端接口
    expect(badge).toMatch(/const result = await claimCredits\(id\);/)
    // 进度可见（串行多次请求，不显示进度会像卡住）
    expect(badge).toContain('setClaimProgress({ done: index + 1, total: providers.length })')
    expect(badge).toMatch(/签到中 \$\{claimProgress\.done\}\/\$\{claimProgress\.total\}…/)
  })

  it('全部渠道的结果把每个非零计数与 actionRequired 提示都列出来', () => {
    // 早期只判三个分支 ⇒「活动未开启」的渠道整条消失（设置页 2026-09-26 真实缺陷）
    expect(badge).toContain('summary.alreadyClaimed > 0')
    expect(badge).toContain('summary.inactive > 0')
    expect(badge).toContain('summary.failed > 0')
    expect(badge).toContain("outcome.actionRequired !== true")
    // 单渠道失败不中断后续渠道
    expect(badge).toMatch(/catch \(error\) \{\s*failed \+= 1;/)
  })

  it('全部渠道按钮**不依赖**本渠道读数（首屏/失败态也渲染）', () => {
    expect(badge).toMatch(/children\.push\(renderClaim\(\)\);\s*\n\s*children\.push\(renderFoot\(\)\);/)
  })

  it('签到成功后强制重读（否则要等下一轮轮询才看到新数字）', () => {
    expect(badge).toMatch(/await claimCredits\(provider\)[\s\S]{0,500}?read\.current\(\)/)
    expect(badge).toMatch(/setClaiming\(null\);\s*\n\s*read\.current\(\);/)
  })

  it('签到结果按四态汇总成一句话 + 色调（「今天已领」不算失败）', () => {
    expect(badge).toContain('function summarizeClaim(result)')
    expect(badge).toContain('alreadyClaimed')
    expect(badge).toContain('totalCredit')
    expect(badge).toContain('inactive')
    expect(badge).toMatch(/tone: summary\.failed > 0 \|\| notes\.length > 0 \? 'warn' : 'ok'/)
  })

  it('签到摘要**自动消失**（用户报障「文字久久都不消失」）', () => {
    // 两档时长：成功 8s / 警告与需操作提示 20s
    expect(badge).toContain('export const CLAIM_NOTICE_MS = 8_000;')
    expect(badge).toContain('export const CLAIM_NOTICE_WARN_MS = 20_000;')
    expect(badge).toMatch(/const ms = claimNotice\.tone === 'warn' \? CLAIM_NOTICE_WARN_MS : CLAIM_NOTICE_MS;/)
    expect(badge).toMatch(/setTimeout\(\(\) => setClaimNotice\(null\), ms\)/)
    // ⚠️ 必须清计时器：否则连续两次签到时，第一支计时器会把第二次的摘要提前清掉
    expect(badge).toMatch(/return \(\) => clearTimeout\(timer\);/)
    // ⚠️ 计时的依赖只能是 claimNotice：关掉弹窗后摘要也要按时消失
    expect(badge).toMatch(/\}, \[claimNotice\]\);/)
  })

  it('三态偏好开关写宿主（本地先生效，失败回滚）', () => {
    expect(badge).toContain('BADGE_PREFERENCES.map')
    expect(badge).toContain("'aria-pressed': effectivePreference === item")
    expect(badge).toMatch(/await writePreference\(next\)/)
    expect(badge).toMatch(/catch \(error\) \{\s*setPreference\(null\)/)
  })

  it('点外部与 Esc 都能关闭弹窗（仅在展开时挂监听）', () => {
    expect(badge).toContain("document.addEventListener('mousedown', onDown)")
    expect(badge).toContain("document.addEventListener('keydown', onKey)")
    expect(badge).toMatch(/if \(!open\) return undefined;/)
  })
})

describe('用量徽标：弹窗的紧凑布局（信息一项不少）', () => {
  const badge = read('plugin-src/client/usage-badge.js')
  const styles = read('plugin-src/client/jet-hub-styles.js')

  it('头部一行：色调点 + 渠道名 + 更新时间 + 图标刷新（省掉「刷新」一词占的宽度）', () => {
    expect(badge).toContain("key: 'dot', className: 'dim-jh-badgeDot'")
    expect(badge).toContain("key: 'refresh'")
    expect(badge).toContain("'aria-label': '刷新用量'")
    expect(styles).toMatch(/\.dim-jh-badgeRefresh \{[^}]*width: 20px/)
  })

  it('每个窗口只占**一行**：名称 / 进度条 / 百分比 / 重置倒计时', () => {
    expect(badge).toContain("className: 'dim-jh-badgeWin'")
    expect(badge).toContain("className: 'dim-jh-badgeWinLabel'")
    expect(badge).toContain("className: 'dim-jh-badgeWinReset'")
    // ⚠️ 倒计时允许被省略号截断，故必须留 title 兜底（这是唯一可能看不见的信息）
    expect(badge).toMatch(/className: 'dim-jh-badgeWinReset', title: left/)
    expect(styles).toMatch(/\.dim-jh-badgeWin \{[^}]*display: contents/)
    expect(styles).toMatch(/\.dim-jh-badgeWin \.dim-jh-quotaBar \{[^}]*height: 3px/)
    // ⚠️ 倒计时与百分比都必须可见（不能只藏在 tooltip 里）
    expect(badge).toContain('quotaResetsIn(win?.resetsAt)')
    expect(badge).toContain('formatQuotaPercent(percent)')
  })

  it('额度块「两侧对齐 + 进度条等长 + 文字左右分别对齐」（grid + display:contents）', () => {
    // 用户 2026-10-02 附截图明确口径：「应该是像两边对齐，但是进度条要一样长，
    // 文字部分左右分别对齐」——早先的「整块居中」实现被否掉。
    expect(badge).toContain("className: 'dim-jh-badgeWins'")
    expect(styles).toMatch(/\.dim-jh-badgeWins \{[^}]*display: grid/)
    // ⚠️ 四列共享列宽：标签 max-content（按最宽那个对齐 ⇒ 三行进度条起点一致）
    // + 进度条 minmax(60px,1fr)（吃掉余量 ⇒ 等长）+ 百分比 max-content
    // + 倒计时固定 100px（贴右边缘）
    expect(styles).toMatch(/\.dim-jh-badgeWins \{[^}]*grid-template-columns: max-content minmax\(60px, 1fr\) max-content 100px/)
    // 不得再出现整块居中（会破坏两侧对齐）——⚠️ 只能在该**规则块内**判：
    // styles 是整个样式文件（含设置页），别处合法的 justify-content 会被误伤。
    const winsRule = styles.slice(styles.indexOf('.dim-jh-badgeWins {'), styles.indexOf('}', styles.indexOf('.dim-jh-badgeWins {')))
    expect(winsRule).not.toContain('justify-content')
    // 文字左 / 右分别对齐
    expect(styles).toMatch(/\.dim-jh-badgeWinLabel \{[^}]*text-align: left/)
    expect(styles).toMatch(/\.dim-jh-badgeWinReset \{[^}]*text-align: right/)
    // 每行 display:contents 交给共享 grid ⇒ 等长与列对齐同时成立
    expect(styles).toMatch(/\.dim-jh-badgeWin \{[^}]*display: contents/)
  })

  it('自动签到状态灯在弹窗右上角，且**状态不只用颜色**表达', () => {
    // 用户 2026-10-02：「给用量徽标小窗口右上角增加一个是否自动签到的按钮状态灯，
    // 可选择关闭或者打开。」
    expect(badge).toContain("className: 'dim-jh-badgeAuto'")
    expect(badge).toContain("'data-state': autoState")
    expect(badge).toContain("'data-running': auto?.running === true")
    // 可切换：aria-pressed 跟随开关，点击调 setAutoCheckin
    expect(badge).toMatch(/'aria-pressed': auto\?\.enabled === true/)
    expect(badge).toMatch(/onClick: \(\) => \{ void onToggleAutoCheckin\(\); \}/)
    expect(badge).toContain('await setAutoCheckin(next)')
    // 四态派生：关闭 / 已开未跑 / 今天已跑 / 进行中（进行中显示省略号而不是点）
    expect(badge).toMatch(/const autoState = auto === undefined \|\| auto\.enabled !== true/)
    expect(badge).toMatch(/auto\.ranToday === true \? 'done' : 'on'/)
    expect(badge).toMatch(/auto\?\.running === true\s*\?\s*'…'/)
    // ⚠️ 灯本身有形态差异（关=空心环、开=实心点），不靠颜色单独承载语义
    expect(styles).toMatch(/\.dim-jh-badgeAutoDot \{[^}]*border: 1\.5px solid currentColor/)
    expect(styles).toMatch(/\.dim-jh-badgeAuto\[data-state="on"\] \.dim-jh-badgeAutoDot,[\s\S]{0,120}?background: currentColor; border: 0;/)
    // 与刷新键同尺寸、同主题描边（浅色下靠描边才立得住）
    expect(styles).toMatch(/\.dim-jh-badgeAuto \{[^}]*width: 20px; height: 20px/)
    expect(styles).toMatch(/\.dim-jh-badgeAuto \{[^}]*border: \.5px solid var\(--dsw-alias-border-l2\)/)
    // 进行中用品牌色
    expect(styles).toMatch(/\.dim-jh-badgeAuto\[data-running="true"\] \{ color: var\(--dsw-alias-brand-primary\); \}/)
  })

  it('「（自动）」后缀标在签到按钮文案上（关掉则不显示），不再用上方小胶囊', () => {
    // 用户 2026-10-02 的口径：「直接在原有的全渠道签到后面加一个括号，添加自动二字。
    // 如果没有，只有单渠道，也在后方加一个自动二字。如果自动签到关闭，则不显示这个自动二字。」
    expect(badge).toContain('const withAutoSuffix = (label) => (auto?.enabled === true ? `${label}（自动）` : label);')
    expect(badge).toContain("withAutoSuffix('全部渠道签到')")
    // ⚠️ 关掉时按钮保持原样（后缀函数返回原 label，不是空串）
    expect(badge).toMatch(/: label\);/)
    // ⚠️ 只标在**实际渲染的那个**按钮上：弹窗里「全部渠道签到」无条件渲染，
    // 故「签到（本渠道）」不再重复标（两个都标会被读成两个独立功能）。
    expect(badge).not.toContain("withAutoSuffix('签到（本渠道）')")
    // ⚠️ 上一版那枚右对齐小胶囊已被用户否掉（「感觉有点不是太好看」），
    // 组件与样式都不该再留着它。
    expect(badge).not.toContain('dim-jh-badgeAutoTag')
    expect(badge).not.toContain('dim-jh-badgeClaimHead')
    expect(styles).not.toContain('.dim-jh-badgeAutoTag')
    // 状态灯的悬停提示必须说清「这个按钮是干什么的」
    expect(badge).toContain("const what = '自动签到开关';")
    expect(badge).toMatch(/点击开启后，每天首次启动 DSH 时会自动为全部渠道签到一次/)
    expect(badge).toMatch(/title: autoTitle/)
  })

  it('自动签到状态文字**常驻**（不自动消失），由文字上方的小叉手动关闭', () => {
    // 用户 2026-10-02：「自动签到状态下，下方应该也显示文字状态，这样才能够知道各个
    // 渠道的签到状态。但是自动签到状态下不要给我自动取消文字，给我开放手动关闭文字
    // 显示，在文字上方放个小按钮，点击直接关闭。」
    expect(badge).toContain('function renderAutoStatus()')
    expect(badge).toContain("className: 'dim-jh-badgeAutoStatus'")
    // ⚠️ 小关闭按钮在**文字上方**（closerow 排在 head 之前），且是「×」
    expect(badge).toContain("className: 'dim-jh-badgeAutoCloseRow'")
    expect(badge).toMatch(/\}, '×'\)/)
    const closerAt = badge.indexOf("className: 'dim-jh-badgeAutoCloseRow'")
    const headAt = badge.indexOf("className: 'dim-jh-badgeAutoStatusHead'")
    expect(closerAt).toBeGreaterThan(-1)
    expect(headAt, '关闭按钮必须排在状态文字之前（视觉上在上方）').toBeGreaterThan(closerAt)
    // ⚠️ **绝不接进**那条「按时自动消失」的计时器：两者语义不同
    //（手动签到结果是回执 8s/20s 消失；自动签到状态是状态，只手动关）
    expect(badge).toMatch(/\}, \[claimNotice\]\);/)
    expect(badge).not.toMatch(/setClaimNotice\(null\), [A-Z_]*AUTO/)
    // 逐渠道明细（用户要「知道各个渠道的签到状态」）
    expect(badge).toContain("className: 'dim-jh-badgeAutoChannels'")
    expect(badge).toContain('providerLabel(entry.provider)')
    // 显示条件：开关打开 + 用户没关掉这一轮 + 有内容
    expect(badge).toMatch(/if \(auto\?\.enabled !== true \|\| auto\.dismissed === true\) return null;/)
    // 关闭走独立 RPC（dismiss），不是改开关
    expect(badge).toContain('await dismissAutoCheckin();')
    // ⚠️ `index` 是另一个 describe 里的局部变量，这里自己读一次
    expect(read('plugin-src/client/index.js'))
      .toContain("dismissAutoCheckin: () => rpcCall('usage.autoCheckin', { dismiss: true })")
    expect(styles).toMatch(/\.dim-jh-badgeAutoCloseRow \{[^}]*justify-content: flex-end/)
  })

  it('浅色模式下按钮与线条可见（用主题描边，取消上一轮的「去线条」）', () => {
    // 用户 2026-10-02：「浅色模式下按钮和线条不太明显」
    // 刷新键与签到按钮都要有主题描边（浅色下 layer-2 与弹窗底色几乎同色）
    expect(styles).toMatch(/\.dim-jh-badgeRefresh \{[^}]*border: \.5px solid var\(--dsw-alias-border-l2\)/)
    expect(styles).toMatch(/\.dim-jh-badgeAction \{[^}]*border: \.5px solid var\(--dsw-alias-border-l2\)/)
    // 分段控件容器与选中项也要有描边
    expect(styles).toMatch(/\.dim-jh-badgePref \{[^}]*border: \.5px solid var\(--dsw-alias-border-l2\)/)
    expect(styles).toMatch(/\.dim-jh-badgePrefBtn\[aria-pressed="true"\] \{[^}]*border: \.5px solid/)
    // 分区线用**全不透明**的 border-l2（此前降到 75%，浅色下几乎看不见）
    expect(styles).toMatch(/\.dim-jh-badgeSection \{[^}]*border-top: \.5px solid var\(--dsw-alias-border-l2\);/)
    expect(styles).not.toContain('color-mix(in srgb, var(--dsw-alias-border-l2) 75%, transparent)')
  })

  it('账号行：名字与数值同一行、备注小字，合计并入节标题', () => {
    expect(badge).toContain("className: 'dim-jh-badgeRowName'")
    expect(badge).toContain("className: 'dim-jh-badgeRowNote'")
    expect(badge).toContain("className: 'dim-jh-badgeSectionSum'")
    expect(styles).toMatch(/\.dim-jh-badgeRowHead \{[^}]*justify-content: space-between/)
  })

  it('偏好做成三段等分控件（不再单占一行写「显示偏好」）', () => {
    expect(styles).toMatch(/\.dim-jh-badgePrefBtn \{[^}]*flex: 1/)
    // 解释性文案改到容器 title 上，信息不丢。
    // ⚠️ 断言三档的**语义差别**而不只是「有一句解释」：2026-10-03 语义反转后
    // 「自动」与「只看积分」都显示余额，差别在**是否回落**到订阅 —— title 里
    // 不写清这点，用户会以为两档一样（旧 title 只写「优先显示订阅还是积分」）。
    expect(badge).toContain('显示偏好：')
    expect(badge, 'title 必须说明「自动」会回落').toContain('没有余额读数才显示订阅')
    expect(badge, 'title 必须说明「只看积分」是强制的').toContain('强制只显示余额')
    expect(badge).not.toContain("'显示偏好'")
  })

  it('浮层收窄到 280px、进度条 3px、双层柔和阴影', () => {
    expect(styles).toMatch(/\.dim-jh-badgePop \{[^}]*width: 280px/)
    // 双层柔和阴影
    expect(styles).toMatch(/\.dim-jh-badgePop \{[^}]*box-shadow: 0 1px 2px[^}]*0 8px 24px/)
  })

  it('信息不缺失：时间戳/缓存标记、停用与失败计数、套餐到期都仍在渲染里', () => {
    expect(badge).toContain("value?.cached === true ? ' · 缓存' : ''")
    expect(badge).toContain('另有 ${value.disabledCount} 个账号已停用，未计入')
    expect(badge).toContain('${view.failedCount} 个账号读取失败')
    expect(badge).toContain('扣费截止 ${formatUpdatedAt(group.deductionEndTime)}')
    expect(badge).toContain('本次刷新失败，显示的是上一次读数')
  })
})

describe('用量徽标：依赖与样式', () => {
  it('package.json 声明三个客户端依赖（含提供 modelDirectories 的那个包）', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dsh?: { client?: { platform?: string; inject?: string[] } }
    }
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-model-selection',
    ])
  })

  it('徽标用到的每个样式类都在 jet-hub-styles.js 里定义', () => {
    const badge = read('plugin-src/client/usage-badge.js')
    const styles = read('plugin-src/client/jet-hub-styles.js')
    // ⚠️ 类名允许大写（dim-jh-badgeDot / badgePop / ...），第一次写成只认小写时
    // 只匹配到 1 个类，用例假绿。
    // ⚠️ 一个 className 里可能写**两个**类（如 'dim-jh-badgeSection dim-jh-badgeClaim'），
    // 必须拆开逐个查，否则断言会拿整串去找 `.A B` 而假红。
    const classes = new Set(
      [...badge.matchAll(/className: '([A-Za-z0-9- ]+)'/g)]
        .flatMap((match) => match[1].trim().split(/\s+/)),
    )
    expect(classes.size).toBeGreaterThan(10)
    for (const className of classes) {
      expect(styles, className).toContain(`.${className}`)
    }
  })

  it('样式里的注释**不含反引号**（STYLES 是模板字符串，会被提前闭合）', () => {
    const styles = read('plugin-src/client/jet-hub-styles.js')
    // 只检查徽标那一段：从「用量徽标」注释块到 STYLES 结束
    const start = styles.indexOf('── 用量徽标')
    expect(start).toBeGreaterThan(0)
    const badgeSection = styles.slice(start - 40)
    const commentBlocks = [...badgeSection.matchAll(/\/\*[\s\S]*?\*\//g)].map((match) => match[0])
    expect(commentBlocks.length).toBeGreaterThan(0)
    for (const block of commentBlocks) expect(block).not.toContain('`')
  })
})

describe('用量徽标：号多了以后的两条整理（2026-10-03 用户要求）', () => {
  const badge = read('plugin-src/client/usage-badge.js')
  const styles = read('plugin-src/client/jet-hub-styles.js')

  it('折叠阈值是 5，且「展开其余 N 个」由可见文案如实报数', () => {
    expect(badge).toMatch(/export const CREDITS_COLLAPSED_LIMIT = 5;/)
    expect(badge).toMatch(/展开其余 \$\{hidden\} 个账号/)
    expect(badge).toMatch(/creditsExpanded \? '收起' : /)
  })

  it('折叠只收明细，**不隐藏结论**（合计在节标题、失败数在脚注，都在折叠之外）', () => {
    // 合计那一句在折叠逻辑（ordered/hidden/shown）**之前**算好，与展开状态无关。
    // ⚠️ 起点是 `quotaGroup` 那两行：配额单位（Gemini）的 `sum` 走三分支，
    // 不再是裸的 `const sum = view.groups.map(...)`（见 badge-model.js 的 readingOf）。
    const sumBlock = badge.slice(badge.indexOf('const quotaGroup = view.groups.find'), badge.indexOf('const { shown, hidden } = orderCreditRows('))
    expect(sumBlock.length).toBeGreaterThan(0)
    expect(sumBlock).toContain('view.groups.map')
    expect(sumBlock).not.toContain('creditsExpanded')
    // 脚注（失败账号数所在处）同样不看展开状态
    expect(badge).toMatch(/function renderFoot\(\)/)
    const foot = badge.slice(badge.indexOf('function renderFoot()'), badge.indexOf('function balanceLine'))
    expect(foot.length).toBeGreaterThan(0)
    expect(foot).not.toContain('creditsExpanded')
  })

  it('排序与折叠都走纯函数 orderCreditRows（组件里不再各写一份，逻辑由 badge-model.spec 锁）', () => {
    expect(badge).toMatch(/import \{[\s\S]*?orderCreditRows[\s\S]*?\} from '\.\/badge-model\.js'/)
    expect(badge).toMatch(/orderCreditRows\(accounts, \{/)
    expect(badge).toMatch(/limit: CREDITS_COLLAPSED_LIMIT/)
    // ⚠️ 组件里不得再自带排序实现：两份必然分叉（且组件的实现测不到，因为没装 react）
    expect(codeOf(badge)).not.toMatch(/function balanceOrder\(/)
  })

  it('展开状态随渠道切换重置（否则会显得「折叠时灵时不灵」）', () => {
    const effect = badge.slice(badge.indexOf('// 换渠道时先清空旧读数'), badge.indexOf('}, [provider]);'))
    expect(effect).toContain('setCreditsExpanded(false)')
  })

  it('胶囊在合计不完整时挂一个警示角标，且它与读数同级 flex:none（不能被省略号吃掉）', () => {
    expect(badge).toContain("className: 'dim-jh-badgeWarn'")
    const warn = styles.slice(styles.indexOf('.dim-jh-badgeWarn'), styles.indexOf('.dim-jh-badgeWarn') + 200)
    expect(warn).toMatch(/flex: none/)
    // ⚠️ 顺序断言：警示必须在读数**之后**（先看数字，再看补语）。
    // 用整份源码里的绝对位置比，不要切片 —— 对象字面量里 key 在 className 之前，
    // 按 key 切会切错（第一版就这么写红过）。
    const readingIdx = badge.indexOf("className: 'dim-jh-badgeReading'")
    const warnIdx = badge.indexOf("className: 'dim-jh-badgeWarn'")
    expect(readingIdx).toBeGreaterThan(0)
    expect(warnIdx).toBeGreaterThan(readingIdx)
  })

  it('警示标记 aria-hidden（同一句话已进 aria-label，不重复念），解释走 title', () => {
    const warn = badge.slice(badge.indexOf("key: 'incomplete'"), badge.indexOf("key: 'incomplete'") + 400)
    expect(warn).toContain("'aria-hidden': 'true'")
    expect(warn).toContain('title: view.incompleteNote')
    expect(badge).toMatch(/aria-label': ariaLabel/)
    expect(badge).toMatch(/view\.incompleteNote === '' \? '' : `（\$\{view\.incompleteNote\}）`/)
  })

  it('按钮 title 三段拼接：读数 → 不完整说明 → 失败原因（都要留，空串跳过）', () => {
    const title = badge.slice(badge.indexOf('const title = [view.text'), badge.indexOf('const title = [view.text') + 200)
    expect(title).toContain('view.text')
    expect(title).toContain('view.incompleteNote')
    expect(title).toContain('view.failureReason')
    expect(title).toContain("filter((part) => part !== '')")
  })

  it('弹窗脚注复用同一句话，不另写一份措辞', () => {
    expect(badge).toMatch(/parts\.push\(view\.incompleteNote === '' \? `\$\{view\.failedCount\} 个账号读取失败` : view\.incompleteNote\)/)
  })
})

describe('格式化函数下沉（徽标与设置页共用同一口径）', () => {
  const hub = read('plugin-src/client/jet-hub.js')

  it('jet-hub.js 不再自带数值/窗口格式化实现，改为 import 纯模块', () => {
    expect(hub).not.toMatch(/^function formatUnits\(/m)
    expect(hub).not.toMatch(/^function formatCredits\(/m)
    expect(hub).not.toMatch(/^const QUOTA_WINDOWS = /m)
    expect(hub).toMatch(/from '\.\/credits-format\.js'/)
    expect(hub).toMatch(/from '\.\/quota-format\.js'/)
  })

  it('两个界面用的是同一组函数（不是各写一份）', () => {
    const badge = read('plugin-src/client/usage-badge.js')
    for (const source of [hub, badge]) {
      expect(source).toMatch(/from '\.\/quota-format\.js'/)
      expect(source).toMatch(/from '\.\/credits-format\.js'/)
    }
  })

  it('providerLabel 从 jet-hub.js 导出（渠道名的唯一来源）', () => {
    expect(hub).toContain('export function providerLabel(id)')
  })
})

/**
 * ⚠️ 单位归一的**两侧口径一致**（真实缺陷，2026-10-03）。
 *
 * 宿主把逐账号余额折算成订阅读数（`src/badge-subscription.ts` 的 `unitOf`），
 * 客户端把逐账号余额分组求和（`credits-format.js` 的 `normalizeUnit`）。两处都
 * 要把 `credit` / `credits` / 空串收敛掉，否则「套餐按一个单位、余额按另一个」
 * 会在同一枚徽标里自相矛盾。
 *
 * ⚠️ 客户端代码不能 import 宿主代码（esbuild 的客户端 bundle 没有 Node 依赖），
 * 故只能各写一份 —— 这个用例就是那份「必须逐字等价」的契约。
 */
describe('单位归一：宿主与客户端同一口径', () => {
  /** 抽样要覆盖真实服务端下发过的拼法（逐包实测，见 probe-workbuddy-units.mjs）。 */
  const SAMPLES = ['credit', 'credits', 'Credit', 'CREDITS', '', 'USD', '积分', '通道', 'token', 'Token', 'TOKEN']

  it('normalizeCreditUnit（宿主）与 normalizeUnit（客户端）逐项一致', async () => {
    const { normalizeCreditUnit } = await import('../../src/credits.js')
    const { normalizeUnit } = await import('../../plugin-src/client/credits-format.js')
    for (const unit of SAMPLES) {
      expect(normalizeUnit(unit), unit).toBe(normalizeCreditUnit(unit))
    }
  })

  it('只有 token 单独成类，其余一律归为 credit（与 unitLabel「积分」同源）', async () => {
    const { normalizeUnit, unitLabel } = await import('../../plugin-src/client/credits-format.js')
    for (const unit of SAMPLES) {
      expect(normalizeUnit(unit), unit).toBe(unit === 'token' ? 'token' : 'credit')
      // 归一到 credit 的单位，展示名必须是「积分」，且**只有一种**写法
      expect(unitLabel(normalizeUnit(unit)), unit).toBe(unit === 'token' ? 'Token' : '积分')
    }
  })
})
