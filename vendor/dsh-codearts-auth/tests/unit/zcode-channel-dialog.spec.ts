/**
 * 渠道选择的**位置**契约（用户 2026-10-03 明确要求）。
 *
 * > 登录渠道gui流程应该在新建账号出来后的窗口中选择然后再弹出国际版国内版不同的认证页面。
 *
 * ## 这条测试守什么
 *
 * PR #38 把渠道 `<select>` 放在「+ 新建账号」按钮**旁边**。那是**两个入口共用的
 * 一个开关** —— 改了它，也不知道会不会影响正在跑的那一轮登录（授权页已经开了，
 * 改渠道也没用）。
 *
 * ⇒ 搬进「点按钮后弹出的对话框」后，「选渠道」与「发起登录」是**同一个原子动作**。
 *
 * ⚠ 纯源码契约：这类 UI 位置没有单测能真正跑起来（要起 React 树），
 *   而它恰恰是最容易被"顺手改回去"的地方 —— 改回去不会有任何测试失败。
 *
 * ## ⚠ 入口只剩一个（Gitee issue IKJLHQ）
 *
 * 第二个入口曾是官方「设置 → 模型 → 模型卡片」里的 ZCode 账号区
 * （`plugin-src/client/zcode-card.js`）。它靠占用 keyed 槽
 * `settings.models.provider-card` 的 `llm-pi-ai` key 实现，而该 key 与其它
 * 第三方 pi-ai 扩展**物理互斥**（同 key 的第二个注册者被 `SlotCore.register`
 * 抛错、渲染侧每个 key 只取 ledger 里首个 live 条目）—— 已整体移除，
 * ZCode 账号管理现在只在 Jet Hub 页。本文件最后两条用例把这条红线钉住。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dir = dirname(fileURLToPath(import.meta.url))
const panel = readFileSync(resolve(dir, '../../plugin-src/client/jet-hub.js'), 'utf8')
const entry = readFileSync(resolve(dir, '../../plugin-src/client/index.js'), 'utf8')
const styles = readFileSync(resolve(dir, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

describe('★ 渠道选择在「新建账号弹窗」里，不在按钮旁', () => {
  it('★ zCode 面板仍改为「点按钮 → 开弹窗」（不再直接调 createAccount）', () => {
    // ⚠ 2026-10-03 之后 jet-hub.js 侧改成了**按 provider 分支**（Gitee issue IKJLK3 A1/A2/A3）：
    //   「+ 新建账号」按钮存在于**每一个** provider 的面板里，而弹窗是 zCode 专用的。
    //   无条件开弹窗 ⇒ 在 CodeArts 面板也弹出「添加 ZCode 账号」（A1），
    //   opencode 则要点完 ZCode 弹窗才看到自己的 API key 表单（A3）。
    //   ⇒ 这里守的**不变式**收敛成「zCode 面板仍必须先弹窗选渠道」，
    //     判据本身由 `new-account.js` 的 `newAccountAsksChannel` 承担。
    expect(panel, 'jet-hub.js 的 zcode 分支应开弹窗')
      .toMatch(/if \(newAccountAsksChannel\(provider\)\) setPendingLogin\(false\)/)
  })

  it('★ 有 pendingLogin 状态（弹窗开着 + 要 forceNew 不可能不同步）', () => {
    expect(panel).toMatch(/const \[pendingLogin, setPendingLogin\] = React\.useState\(undefined\)/)
  })

  it('★ 弹窗含渠道选择与两个选项', () => {
    expect(panel, '缺弹窗遮罩').toContain('dim-jh-zcDialogMask')
    expect(panel, '缺国内选项').toContain("value: 'bigmodel'")
    expect(panel, '缺国际选项').toContain("value: 'zai'")
  })

  it('★ ★ 渠道不再渲染在按钮旁（按钮的 onClick 里不得直接调 createAccount）', () => {
    // 这是本次改动的**核心**：按钮直接调 createAccount ⇒ 渠道无处可选
    expect(panel, 'jet-hub.js 按钮仍在直接调 createAccount').not.toMatch(
      /onClick: \(\) => void createAccount\(false\)/,
    )
  })

  it('★ 渠道仍随 account.create 发出（搬位置不改数据通路）', () => {
    // ⚠ 这是 PR #38 已打通的通路，本次只改 UI 位置，**不得**弄丢
    // ⚠ 2026-10-03：jet-hub.js 侧的载荷构造搬进了 `new-account.js` 的
    //   `buildCreateAccountPayload`（同一份模块被 `tests/unit/new-account-dialog.spec.ts`
    //   真跑覆盖）。故这里断言**调用点**传了渠道，而不是文件里有那个字面量。
    expect(panel).toMatch(/buildCreateAccountPayload\(provider, zcodeProvider\)/)
    // ⚠ 断言的是 `account.create` 的**载荷里真的带它**，不是「文件里出现过这个词」——
    //   后者会在载荷被删、而弹窗里还留着同名 state 时误判为通过（反向验证抓到过）。
    expect(panel).toMatch(/rpcCall\('account\.create',[\s\S]{0,200}?zcodeProvider/)
  })

  it('★ ★ 弹窗是**条件渲染**的（不是常驻），且条件是 pendingLogin', () => {
    // ⚠ 只查「有没有 zcDialogMask」不够：把条件写成 `false` 后文本仍在，
    //   弹窗却永远不渲染（反向验证的变异 2 就是这样溜过去的）。
    // ⚠ 2026-10-03：jet-hub.js 侧的条件多了一条 `|| !newAccountAsksChannel(provider)`
    //   （非 zcode 面板即使状态被置开也不渲染，见 IKJLK3 A1）。
    //   这里守的不变式是「**仍然挂在 pendingLogin 上**」——把前半句匹配成
    //   `pendingLogin === undefined ... ? null :` 即足够，不必贴死整个表达式。
    expect(panel, '弹窗未挂在 pendingLogin 条件上')
      .toMatch(/pendingLogin === undefined[\s\S]{0,80}?\? null : (React\.createElement|h)\(/)
  })

  it('★ 国际选项文案保留（删了就只剩国内）', () => {
    expect(panel, '国际选项文案缺失').toContain('z.ai（chat.z.ai，国际版）')
  })

  it('★ 「确定」才发起登录（点确定 → createAccount()，无参）', () => {
    // ⚠ 撤掉「登录其他账号」后 createAccount 不再收 forceNew（用户 2026-10-02）
    expect(panel, '确定回调不得再传 forceNew').not.toMatch(/createAccount\(forceNew\)/)
  })

  it('★ 弹窗样式齐备（否则弹出来是透明的无边框块）', () => {
    for (const cls of [
      'dim-jh-zcDialogMask',
      'dim-jh-zcDialog ',
      'dim-jh-zcDialogTitle',
      'dim-jh-zcDialogHint',
      'dim-jh-zcDialogActions',
    ]) {
      expect(styles, `缺样式 ${cls.trim()}`).toContain(`.${cls.trim()}`)
    }
  })

  it('★ styles 是模板字符串：反引号数必须恰为 2（多了会提前闭合）', () => {
    // AGENTS.md 红线：CSS 注释内出现反引号会「提前闭合模板」，
    // 报错看起来像 CSS 写错、实际是 JS 语法问题。
    const ticks = (styles.match(/`/g) ?? []).length
    expect(ticks, 'styles 反引号数不为 2，模板字符串可能被破坏').toBe(2)
  })
})

/**
 * Gitee issue IKJLHQ 的红线。
 *
 * `settings.models.provider-card` 是 **keyed** 槽，其 `key` 的语义是
 * 「这张卡片的 `settingsNs`」—— 官方按 `entryKey = row.entry.settingsNs` 精确查表
 * （`dsh-client-ui-settings-models` 的 `renderSlot(..., { entryKey })`），
 * 且 `entriesOfSlot` 对每个 key 只返回 **ledger（注册顺序）里的首个 live 条目**：
 *
 * - 同 key + 同 priority 的第二个 `register` **抛错**（`already has an entry for key`）；
 * - 换 priority 只能免掉那次抛错，仍然只有一个 winner，**不构成共存**；
 * - 换一个"独立 key"（如 `llm-pi-ai-zcode`）会让**我们自己的卡片**不再被查表命中。
 *
 * zcode 没有自己的适配器家族（`dsh-llm-pi-ai` 把所有 route 目录行的 `settingsNs`
 * 统一设成 `llm-pi-ai`），所以想「就近」把账号 UI 放进官方卡片，就只能抢这个 key，
 * 而抢的结果是同装 `@linxin666/dsh-client-ui-model-capabilities` 的用户
 * **模型能力编辑面板静默消失**（对方把 register 包在 try/catch 里吞掉错误）。
 *
 * ⇒ 账号管理只放 Jet Hub 页。这几条用例防止有人"顺手把就近卡片加回来"。
 */
describe('★ IKJLHQ：不得再占用 settings.models.provider-card 的 llm-pi-ai key', () => {
  // ⚠ 判据必须是「**没有 inject/register 这个槽**」，不能断言「文件里没有这个字符串」——
  //   index.js 的文件头注释里就写着这个名字（那正是解释为什么不注册的依据）。
  const SLOT_RE = /slots\.inject\(\s*['"]settings\.models\.provider-card['"]/
  const REGISTER_RE = /slots\.register\([\s\S]{0,120}?['"]settings\.models\.provider-card['"]/

  it('★ 客户端入口不再注册 provider-card 槽', () => {
    expect(entry, 'index.js 仍在 inject settings.models.provider-card').not.toMatch(SLOT_RE)
    expect(entry, 'index.js 仍在 register settings.models.provider-card').not.toMatch(REGISTER_RE)
    expect(entry, 'index.js 仍引用已删的卡片组件').not.toMatch(/zcode-card/)
  })

  it('★ 卡片组件文件已删除，且无人 import 它', () => {
    const cardPath = resolve(dir, '../../plugin-src/client/zcode-card.js')
    expect(existsSync(cardPath), 'zcode-card.js 还在（账号管理应只在 Jet Hub 页）').toBe(false)
    expect(panel, 'jet-hub.js 仍引用 zcode-card').not.toMatch(/zcode-card/)
    expect(styles, 'jet-hub-styles.js 仍引用 zcode-card').not.toMatch(/zcode-card\.js/)
  })

  it('★ 全仓客户端源码不再注入/注册该槽（防新增第二个占用者）', () => {
    for (const name of ['index.js', 'jet-hub.js', 'usage-badge.js', 'zcode-carrier.js']) {
      const src = readFileSync(resolve(dir, '../../plugin-src/client/', name), 'utf8')
      expect(src, `${name} 仍在 inject 该槽`).not.toMatch(SLOT_RE)
      expect(src, `${name} 仍在 register 该槽`).not.toMatch(REGISTER_RE)
    }
  })

  it('★ 说明「为什么不能注册」的红线注释仍在（删组件时别把依据一起删了）', () => {
    expect(entry, 'index.js 缺少 IKJLHQ 的互斥说明')
      .toMatch(/IKJLHQ[\s\S]{0,2000}llm-pi-ai/)
  })
})
