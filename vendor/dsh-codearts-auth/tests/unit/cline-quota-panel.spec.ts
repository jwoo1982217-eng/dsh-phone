import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Cline「订阅额度」按钮与弹窗的**客户端接线**回归。
 *
 * ⚠️ 为什么是源码级断言而不是渲染测试：`plugin-src/client/jet-hub.js` 依赖
 * **宿主注入的 `react`**（esbuild 的 external），本仓库的 node_modules 里
 * 没有 react，故无法在 vitest 里渲染它 —— 这与 `raccoon-client-panel.spec.ts` /
 * `model-bulk.spec.ts` 的处境相同，那些也一律用源码断言锁守卫。
 *
 * ## 本文件在 2026-09-30 被**整体重写**（用户报障：「额度和请求记录没有
 * 1:1 还原参考仓库？」）
 *
 * 用户给的判据是**与参考仓库 `github.com/codeOct/dsh-cline-pass`（main @ abab1dd）
 * 逐项一致**，而旧版断言锁的是**首版自创的形态**，两处直接冲突，故不是「删几条
 * 断言」而是换判据。逐条对照见 `AGENTS.md` 的「与参考实现的逐项对齐」表。
 *
 * ⚠️ **被推翻的旧判据**（不要照着改回去）：
 * | 旧断言 | 参考实现的实际行为 |
 * |---|---|
 * | 百分比数值**不夹取**（「120%」要显示出来） | 参考 `Math.max(0, Math.min(100, percentUsed))` + `Math.round` —— **夹取并取整** |
 * | 正常档用品牌蓝、≥80 黄、≥100 红 | 参考 `usageColor`：≥90 红 / ≥70 黄 / 其余**绿** |
 * | 延迟列单行「首块 X · 共 Y」 | 参考三行：**首字 / 总耗时 / 输出速度（TPS，官方口径）** |
 * | TOKEN 列 `123 + 456`、无 usage 时显示 `0 + 0` | 参考 `↓输入 ↑输出 [⚡缓存] [🧠推理]`，无 usage 显示 **`—`** |
 * | 失败行 `colSpan 4`、无状态点列 | 参考 **5 列含状态点**，失败行空 2 格 + **`colSpan 3`** |
 *
 * 这些断言守住的是**「接线」**（按钮在不在、门控用的是不是能力表、面板挂在哪个
 * 开关后面、弹窗调的是不是那两个端点、UI 是否逐项对齐参考实现）。
 * 端点本身的行为由 `jet-hub-rpc.spec.ts` 的行为级用例覆盖；
 * 能力表的判定由 `credits-capabilities.spec.ts` 覆盖；
 * 本地流水的字段口径由 `cline-request-log.spec.ts` 覆盖。
 */

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, '../..', rel), 'utf8')

describe('Cline 订阅额度：客户端接线', () => {
  const client = read('plugin-src/client/jet-hub.js')
  const styles = read('plugin-src/client/jet-hub-styles.js')
  /**
   * ⚠️ 额度窗口的**纯函数实现**自 2026-10-01 起住在 `plugin-src/client/quota-format.js`。
   *
   * 搬出去的原因是会话输入区的**用量徽标**（`usage-badge.js`）要显示同一份读数，
   * 而 `jet-hub.js` 顶部 `import * as React from 'react'`（react 是宿主注入的
   * external，node_modules 里没有）⇒ 任何 import 它的模块在 vitest 里都跑不起来。
   * 搬移只改**位置**、不改口径：本文件对实现的断言改到 `quotaFormat` 上，
   * 对「面板里怎么用」的断言仍留在 `client` 上。
   */
  const quotaFormat = read('plugin-src/client/quota-format.js')

  it('从能力表导入 supportsSubscriptionQuota', () => {
    expect(client).toContain('supportsSubscriptionQuota,')
    expect(client).toMatch(/from '\.\/credits-capabilities\.js'/)
  })

  /**
   * ⚠️ 门控必须**来自能力表**，不能写成 `provider === 'cline'`：
   * 能力表是与服务端分派对齐的唯一真相源，写死字面量会在将来
   * 「某渠道下线该能力」时静默漂移（表现为按钮还在、点了报 bad-request）。
   */
  it('按钮门控来自能力表（不是写死 provider 字面量）', () => {
    expect(client).toContain('const canShowSubscriptionQuota = supportsSubscriptionQuota(provider)')
    expect(client).toMatch(/canShowSubscriptionQuota\s*\?[\s\S]{0,400}?'订阅额度'/)
  })

  it('按钮文案与提示齐备（tooltip 说明数据来自官方网关）', () => {
    expect(client).toContain("'订阅额度'")
    expect(client).toMatch(/查看 Cline 官方订阅额度窗口/)
  })

  /** 面板只在开关打开时挂载：关闭即不发请求（否则每次进面板都白发两次）。 */
  it('弹窗由 showQuota 控制挂载（关闭时不挂载）', () => {
    expect(client).toContain('const [showQuota, setShowQuota] = React.useState(false)')
    expect(client).toMatch(/showQuota\s*\?[\s\S]{0,200}?React\.createElement\(ClineQuotaPanel/)
    expect(client).toContain('onClose: () => setShowQuota(false)')
  })

  it('弹窗调用 cline.quota 与 cline.requestLog 两个端点', () => {
    expect(client).toMatch(/rpcCall\('cline\.quota',\s*\{\s*provider:\s*'cline'\s*\}\)/)
    expect(client).toMatch(/rpcCall\('cline\.requestLog',\s*\{[\s\S]{0,200}?provider:\s*'cline'/)
  })

  /**
   * ⚠️ 用户要求:**左右箭头**在账号间切换,且**额度窗口与请求记录共享同一个
   * 索引** —— 切到谁,两个区域就一起看到谁。参考实现(dsh-cline-pass)同款
   * (其「额度卡片」就是一次只显示一个账号,用 ‹ › 翻页)。
   */
  it('额度与请求记录共享同一个翻页索引', () => {
    expect(client).toMatch(/const \[viewIndex, setViewIndex\] = React\.useState\(0\)/)
    // 渲染期纯计算 + 越界钳制(不回写索引,账号恢复后还能回到原位)
    expect(client).toMatch(
      /const viewAccount = quota\.length > 0\s*\?\s*quota\[Math\.min\(viewIndex, quota\.length - 1\)\]/,
    )
    expect(client).toContain('viewAccountId')
  })

  /** 环绕:末个账号的右箭头回第一个 —— 单向尽头会让用户以为「后面没了」。 */
  it('箭头翻页环绕(末尾回第一个)', () => {
    expect(client).toMatch(/const stepView = \(delta\) => \{/)
    expect(client).toMatch(/\(\(prev \+ delta\) % quota\.length \+ quota\.length\) % quota\.length/)
  })

  /**
   * 单账号时不渲染箭头(无处可去)。参考实现连**整行名字都不渲染** ——
   * jet-hub 同款；「这是谁的额度」由弹窗副标题补上（见下一条用例）。
   */
  it('单账号不渲染箭头(多账号才渲染)', () => {
    expect(client).toMatch(/quota\.length > 1\s*\?[\s\S]{0,140}?dim-jh-quotaArrow/)
  })

  /**
   * ⚠️ 单账号下账号名行**整个不渲染**（参考实现同款），故身份信息必须另找位置：
   * 挂到弹窗副标题（多账号 = `· {n} 个账号`，单账号 = `· 账号 {名}`），
   * 否则单账号用户看不到「这是谁的额度」。
   */
  it('账号身份挂在弹窗副标题（单账号也看得到是谁的额度）', () => {
    expect(client).toMatch(/const quotaSubtitle = \(\) => \{/)
    expect(client).toMatch(/Cline · \$\{quota\.length\} 个账号/)
    expect(client).toMatch(/Cline · 账号 \$\{only\.nickname \|\| only\.accountId\}/)
    expect(client).toMatch(/dim-jh-modalSubtitle' \}, quotaSubtitle\(\)/)
  })

  /**
   * 窗口顺序**不能**用网关原序：参考实现把三个已知窗口按固定顺序排在前、
   * 未知窗口追加在后 —— 纯按网关原序会让新窗口插到中间，同一账号两次读数的
   * 排列都可能不同。
   */
  it('已知窗口按固定顺序在前、未知窗口追加在后', () => {
    expect(quotaFormat).toMatch(/const QUOTA_WINDOWS = Object\.freeze\(\[/)
    expect(quotaFormat).toContain("['five_hour', '5 小时']")
    expect(quotaFormat).toContain("['weekly', '本周']")
    expect(quotaFormat).toContain("['monthly', '本月']")
    expect(quotaFormat).toMatch(/function quotaWindowsOf\(windows\)/)
    // 已识别窗口按 QUOTA_WINDOWS 顺序取，未识别的原样追加（标签=type，不丢弃）
    expect(quotaFormat).toMatch(/const known = new Map\(windows\.map/)
    expect(quotaFormat).toMatch(/const extra = windows\s*\n?\s*\.filter\(\(win\) => !QUOTA_WINDOWS\.some/)
    // 面板侧只引用，不复制实现
    expect(client).toMatch(/from '\.\/quota-format\.js'/)
    expect(client).toContain('quotaWindowsOf(')
    expect(client).not.toMatch(/const QUOTA_WINDOWS = /)
  })

  /**
   * ⚠️ 百分比**夹取到 0–100 后取整**（参考实现 `Math.max(0, Math.min(100, …))`
   * + `Math.round`）：进度条宽度与百分比文案必须共用**同一个值** ——
   * 两处各算一次是「进度条 100%、文案 120%」这类不一致的来源。
   */
  it('百分比夹取 0–100 后取整（文案与进度条共用同一个值）', () => {
    expect(quotaFormat).toMatch(/function quotaPercentValue\(percent\)/)
    expect(quotaFormat).toMatch(/return Math\.max\(0, Math\.min\(100, n\)\)/)
    expect(quotaFormat).toMatch(/function formatQuotaPercent\(percent\)/)
    expect(quotaFormat).toMatch(/Math\.round\(quotaPercentValue\(percent\)\)/)
    // 宽度与文案都走 quotaPercentValue（不是各算一次）
    expect(client).toMatch(/const percent = quotaPercentValue\(win\.percentUsed\)/)
    expect(client).toMatch(/style: \{ width: `\$\{percent\}%` \}/)
  })

  /**
   * ⚠️ 进度条配色是**三档**（参考实现 `usageColor`）：≥90 红 / ≥70 黄 /
   * 其余**绿**。正常档用品牌蓝会让「用掉九成」与「用掉一成」看起来一样，
   * 额度条就失去警示作用。
   */
  it('进度条三档配色（≥90 红 / ≥70 黄 / 其余绿）', () => {
    expect(quotaFormat).toMatch(/function quotaTone\(percent\)/)
    expect(quotaFormat).toMatch(/if \(percent >= 90\) return 'error'/)
    expect(quotaFormat).toMatch(/if \(percent >= 70\) return 'warn'/)
    expect(quotaFormat).toContain("return 'ok'")
    // 样式层：正常档必须是**绿**（state-success），不是品牌蓝
    expect(styles).toMatch(/\.dim-jh-quotaBarFill \{[^}]*background: var\(--dsw-alias-state-success-primary/)
    expect(styles).toMatch(/\.dim-jh-quotaBarFill\[data-tone="warn"\]/)
    expect(styles).toMatch(/\.dim-jh-quotaBarFill\[data-tone="error"\]/)
  })

  /**
   * 额度窗口是**并排卡片 + 18px 大字百分比**（参考实现 `.cp-usage-item` 的
   * grid 布局与 `.cp-usage-value` 的字级）—— 纵向列表 + 13px 是首版形态。
   */
  it('额度窗口是并排 grid 卡片 + 18px 大字百分比', () => {
    expect(client).toContain("'dim-jh-quotaWindows'")
    expect(styles).toMatch(/\.dim-jh-quotaWindows \{[^}]*display: grid/)
    expect(styles).toMatch(/\.dim-jh-quotaWindows \{[^}]*repeat\(auto-fit, minmax\(170px, 1fr\)\)/)
    expect(styles).toMatch(/\.dim-jh-quotaWindowPercent \{[^}]*font-size: 18px/)
  })

  /**
   * ⚠️ 账号块按**账号 id** 作 key → 切账号时该块**重新挂载**（参考实现同款）。
   * 否则进度条 `width` 的 CSS 过渡会在两个账号的读数之间播放，
   * 看起来像「这个账号的额度在涨」，而那只是动画。
   */
  it('账号块按 id 作 key（切账号重新挂载，进度条不跨账号动画）', () => {
    expect(client).toMatch(/key: entry\.accountId,/)
  })

  /**
   * ⚠️ 「查询失败」与「没有额度窗口」必须**分开渲染**（参考实现的
   * `usageUnavailable` / `usageEmpty` 两句不同文案）：前者是错误（带原因），
   * 后者是事实。合并成一句会让用户以为额度没了。
   */
  it('「查询失败」与「没有额度窗口」分开渲染', () => {
    expect(client).toMatch(/官方未返回额度窗口。/)
    expect(client).toMatch(/暂时读不到官方额度。/)
    expect(client).toMatch(/正在读取订阅额度…/)
  })

  /**
   * ⚠️ 请求记录是**本地流水**（`src/cline-request-log.ts`）：本插件自己发出的
   * 推理请求（时间/模型/上游/TOKEN/延迟），**不是**网关的官方账单 ——
   * 两者的字段与语义都不同，提示文案必须讲清，否则用户以为是同一份。
   */
  it('请求记录来自本地流水(提示讲清与官方账单的区别)', () => {
    expect(client).toMatch(/请求记录是本插件自己发出的请求流水/)
    expect(client).toMatch(/dim-jh-quotaLogHint/)
  })

  /**
   * 表格列对齐参考实现：**5 列**（状态点 | 时间 | 模型/上游 | TOKEN | 延迟）。
   * 首版没有状态点列，宽度也不定，导致「哪一笔失败了」只能看错误文字。
   */
  it('表格 5 列对齐参考实现(状态点/时间/模型上游/TOKEN/延迟)', () => {
    expect(client).toContain("'时间'")
    expect(client).toContain("'模型 / 上游'")
    expect(client).toContain("'TOKEN'")
    expect(client).toContain("'延迟'")
    // 状态点：绿=成功、红=失败（错误消息在 title 里）
    expect(client).toMatch(/function StatusDot\(\{ ok, title \}\)/)
    expect(client).toMatch(/React\.createElement\(StatusDot, \{\s*\n?\s*ok: !failed,/)
    expect(styles).toMatch(/\.dim-jh-quotaDot \{[^}]*border-radius: 50%/)
  })

  /**
   * ⚠️ TOKEN 列是 `↓输入 ↑输出 [⚡缓存] [🧠推理]`（参考实现同款图标格式），
   * 且**未收到 usage 帧时显示 `—`**：「网关没发用量」与「这次花了 0 token」
   * 是两件事，混为一谈会误导。
   */
  it('TOKEN 列带图标格式，未收到 usage 帧显示 —', () => {
    expect(client).toMatch(/function tokenParts\(row\)/)
    expect(client).toMatch(/if \(row\?\.usageReported !== true\) return null/)
    expect(client).toContain("icon: '↓'")
    expect(client).toContain("icon: '↑'")
    expect(client).toContain("icon: '⚡'")
    expect(client).toContain("icon: '🧠'")
    // 无 usage → 破折号（不是 0）
    expect(client).toMatch(/function tokenSummary\(row\) \{[\s\S]{0,120}?return '—'/)
    // 缓存/推理为 0 时**不显示那一项**（0 与「没有」是两件事）
    expect(client).toMatch(/> 0\) \{\s*\n\s*parts\.push\(\{ key: 'cache'/)
    expect(client).toMatch(/> 0\) \{\s*\n\s*parts\.push\(\{ key: 'think'/)
  })

  /**
   * TOKEN 单元格 tooltip = **精确**数字 + 图例（参考实现同款）：
   * 单元格里超过 10 万会缩写成 k/M，tooltip 是唯一保留个位的地方；
   * 而 `—` 的含义只在图例里解释。
   */
  it('TOKEN tooltip 带精确数字与图例(解释 — 的含义)', () => {
    expect(client).toMatch(/function tokenSummaryExact\(row\)/)
    // 未收到 usage 时精确数字为空串（参考实现同款），由图例解释 `—`
    expect(client).toMatch(/if \(parts === null\) return ''/)
    expect(client).toContain(
      "const TOKEN_LEGEND = '↓输入 ↑输出 ⚡缓存 🧠推理；— 表示网关本次未返回用量'",
    )
    expect(client).toMatch(/function tokenTooltip\(row\)/)
    expect(client).toMatch(/title: tokenTooltip\(row\),/)
  })

  /**
   * 延迟列**三行**：首字 / 总耗时 / 输出速度（TPS）。
   *
   * ⚠️ 速率口径 = **DeepSeek 官方（DSH 聊天 UI）的显示规则**（用户 2026-10-01
   * 明确指定，见下一条用例的完整说明）：分母不含首字之前那段
   * （`总耗时 − 首字`），分子是**全部输出 token（含推理）**。
   */
  it('延迟列三行(首字/总耗时/输出速度)', () => {
    expect(client).toMatch(/'首字'/)
    expect(client).toMatch(/'总耗时'/)
    // 官方标签是「输出速度（TPS）」，单元格里用短版「输出速度」。
    expect(client).toMatch(/'输出速度'/)
    expect(client).toMatch(/function latencyParts\(row\)/)
    // 分母起点是「首字之后」（`总耗时 − 首字`），不是 0、也不是首正文块
    expect(client).toMatch(/const decodeMs = total - first/)
  })

  /**
   * ⚠️ 没发生过的时刻给**破折号 `—`**，不是 `0` 也不是半角 `-`
   * （参考实现的 `stamp`/`rate` 同字形）：`0ms` 会被读成「瞬间完成」。
   */
  it('未知耗时用破折号 — （不是 0，也不是半角 -）', () => {
    expect(client).toMatch(/function formatMs\(value\) \{[\s\S]{0,140}?return '—'/)
    // 拿不到用量、或生成阶段不可测时同样是破折号，**不报假数字**
    // （判定落在 ./tokens-per-second.js 的 formatRowTokensPerSecond，逐值断言见那边）
    expect(client).toMatch(/const rate = formatRowTokensPerSecond\(row\)/)
    // 不允许退回半角
    expect(client).not.toMatch(/function formatMs\(value\) \{[\s\S]{0,140}?return '-';/)
  })

  /**
   * ⚠️ 模型名去掉 `cline-pass/` 前缀（参考实现同款）：这段前缀在**每一行**
   * 都一样，是常量，却占掉模型名最需要的宽度（居中文本溢出会**两端都丢**）。
   */
  it('模型名去掉 cline-pass/ 前缀(常量前缀不吃模型名的宽度)', () => {
    expect(client).toMatch(/String\(row\.model \?\? ''\)\.replace\(\/\^cline-pass\\\/\/, ''\)/)
  })

  /**
   * 行 tooltip 把整行事实 restate 一遍（截图/复制时信息不丢），
   * **含推理强度**（参考实现 `entry.effort === '' ? '' : …`：空串则整行不渲染）。
   */
  it('行 tooltip 汇总事实并含推理强度', () => {
    expect(client).toMatch(/推理强度 \$\{row\.effort\}/)
    expect(client).toMatch(/row\.effort \? `推理强度/)
    // 行 tooltip 用**有界** tokenSummary（精确个位只在 TOKEN 单元格 tooltip）
    expect(client).toMatch(/`\$\{row\.upstream \|\| '—'\} · \$\{tokenSummary\(row\)\}`/)
  })

  /**
   * 失败行随行显示（参考实现同款**两个空格 + `colSpan 3`**，让消息从模型列起
   * 横跨到延迟列）—— 收进 tooltip 用户永远看不到。
   */
  it('失败行随行显示错误消息（空 2 格 + colSpan 3）', () => {
    expect(client).toMatch(/row\.error !== undefined/)
    expect(client).toMatch(/colSpan: 3,/)
    expect(client).toContain("'dim-jh-quotaError'")
    expect(styles).toMatch(/\.dim-jh-quotaTable td\.dim-jh-quotaError \{[^}]*white-space: normal/)
  })

  /**
   * 列宽用 **colgroup 提示**（参考实现同款写法）：状态点 16px、时间 82px。
   * ⚠️ 表格是 `table-layout: auto`，所以这是**提示**而非硬约束 ——
   * 内容更宽时列仍能自己长出来（不自造横向滚动）。
   */
  it('列宽用 colgroup 提示（状态点 16px / 时间 82px）', () => {
    expect(client).toMatch(/React\.createElement\(\s*'colgroup', null,/)
    expect(client).toMatch(/'table', \{ className: 'dim-jh-quotaTable' \}, colGroup, tableHead, tableBody/)
    expect(styles).toMatch(/\.dim-jh-quotaTable \.dim-jh-quotaDotCol \{ width: 16px; \}/)
    expect(styles).toMatch(/\.dim-jh-quotaTable \.dim-jh-quotaWhenCol, \.dim-jh-quotaTable \.dim-jh-quotaWhen \{ width: 82px; \}/)
  })

  /**
   * ⚠️ 表格自带 **280px 滚动 + sticky 表头 + 全列居中**（参考实现 `.cp-history`）：
   * 长列表在弹窗内滚、表头始终可见。首版靠弹窗整体滚动，表头会滚出视野。
   */
  it('表格自带滚动区 + sticky 表头 + 全列居中', () => {
    expect(styles).toMatch(/\.dim-jh-quotaTableWrap \{[^}]*max-height: 280px/)
    expect(styles).toMatch(/\.dim-jh-quotaTableWrap \{[^}]*overflow: auto/)
    expect(styles).toMatch(/\.dim-jh-quotaTable th \{[^}]*position: sticky; top: 0/)
    expect(styles).toMatch(/\.dim-jh-quotaTable th, \.dim-jh-quotaTable td \{[^}]*text-align: center/)
  })

  /**
   * ⚠️ td 默认 `overflow: hidden` + 继承的 `nowrap`：TOKEN / 延迟 / 错误三列
   * 必须各自改成 `normal + visible`，否则内容被截断，或把表格撑出横向滚动
   * （参考实现踩过同一个坑）。
   */
  it('TOKEN/延迟列允许折行（不被 td 的 overflow:hidden 吃掉）', () => {
    expect(styles).toMatch(/\.dim-jh-quotaTable td\.dim-jh-quotaTokens \{[^}]*white-space: normal; overflow: visible;/)
    expect(styles).toMatch(/\.dim-jh-quotaTable td\.dim-jh-quotaLoad \{[^}]*white-space: normal; overflow: visible;/)
  })

  /**
   * ⚠️ 内容**必须**放进 `.dim-jh-modalBody`（flex:1; min-height:0; overflow-y:auto）。
   * `.dim-jh-modal` 是 max-height 有限的 flex **列**容器，子项默认不可收缩，
   * 内容直接铺在里面就会**画出弹窗边界之外** —— 首版正是漏了这一层：
   * 额度卡 + 请求表把弹窗撑破，用户报「弹窗位置不对、内容显示不对」。
   * 模型列表弹窗的内容同样在 modalBody 里（见其 error/loading/empty 分支）。
   */
  it('弹窗内容在 .dim-jh-modalBody 滚动区里（不直接铺在 .dim-jh-modal）', () => {
    expect(client).toMatch(/dim-jh-modalBody'[\s\S]{0,80}?renderQuota\(\),[\s\S]{0,40}?renderLog\(\)\)/)
  })

  /**
   * ⚠️⚠️ 速率口径 = **DeepSeek 官方（DSH 聊天 UI）的显示规则**
   * （用户 2026-10-01 明确要求「按照官方速率显示规则来」）。
   *
   * ## 口径的三次演变（别把中间那版当"正确"改回去）
   *
   * 1. **最初**：`outputTokens ÷ (总耗时 − 首字)` —— 与官方一致，但**没有取整**，
   *    用户看到 `11814.8 t/s` 报障（那是短窗口下的真实现象）。
   * 2. **2026-09-30**：我改成「正文 token ÷ 正文阶段 + 250ms 下限」，理由是
   *    「分子分母跨阶段」。**这一版被用户否掉了** —— 官方口径就是这么算的，
   *    改了反而不一致。
   * 3. **现在（官方口径）**：只读核对 `@deepseek-ai/dsh-client-ui-chat` 的
   *    `lib/client.js` 后照抄，落在 **`./tokens-per-second.js`**（纯函数，
   *    逐值断言见 `tests/unit/tokens-per-second.spec.ts`）。
   *
   * 本用例只锁**接线**：面板确实用那个模块、标签是官方的「输出速度」。
   */
  it('输出速度接线到 tokens-per-second 模块（官方口径）', () => {
    expect(client).toMatch(/import \{ formatRowTokensPerSecond \} from '\.\/tokens-per-second\.js'/)
    expect(client).toMatch(/const rate = formatRowTokensPerSecond\(row\)/)
    // 生成阶段 = 首字之后 → 结束（官方 decodeMs）
    expect(client).toMatch(/const decodeMs = total - first/)
    // 官方标签「输出速度（TPS）」，单元格里用短版
    expect(client).toMatch(/'输出速度'/)
    // ⚠️ 不得再减推理 token、不得再有最小窗口下限（那是被否掉的第 2 版）
    expect(client).not.toMatch(/const contentTokens = Math\.max\(0, out - thinking\)/)
    expect(client).not.toMatch(/MIN_RATE_WINDOW_MS/)
    // ⚠️ 也不得退回 09-30 之前的「toFixed(1) t/s」写法（官方单位是 tok/s）
    expect(client).not.toMatch(/toFixed\(1\)\} t\/s/)
  })
})
