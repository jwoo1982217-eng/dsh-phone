import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  groupProviders,
  nextProviderOrderAfterDrop,
  providerSwitchRows,
  providerSwitchState,
  providerToggleSummary,
  sortOpenProvidersByOrder,
  summarizeProviderToggle,
} from '../../plugin-src/client/provider-toggle.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')
const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

/** 最小供应商定义（只用到 id，与真实 PROVIDERS 的结构一致）。 */
const P = (id) => ({ id, label: id })

/**
 * 取 `ProviderSwitchPanel` 组件的整段源码（到 `JetHubPage` 之前）。
 *
 * 本仓库的单测环境里没有 react，组件无法渲染 —— 结构与类名只能做源码级断言，
 * 而**判定**（谁该禁用、为什么禁用、顺序怎么排）全部在 `provider-toggle.js` 里，
 * 由下面的真实用例覆盖。两者分工不同，不是拿字符串匹配凑数。
 */
function panelBody(): string {
  const start = source.indexOf('function ProviderSwitchPanel(')
  expect(start, '找不到 ProviderSwitchPanel 组件').toBeGreaterThan(-1)
  // ⚠️ 结束锚点取「下一个顶层组件声明」，**不能**硬编码 `JetHubPage`：
  // 在两者之间插入任何组件（如 GatewayPanel），硬编码的 slice 都会把别人的
  // 源码一并吞进来，于是「本弹窗恰好一个 label / checkbox」这类计数断言会
  // 假性失败（2026-10-02 加网关弹窗时实测）。
  const rest = source.slice(start)
  const offset = rest.slice(1).search(/^(?:export )?function /m)
  return offset === -1 ? rest : rest.slice(0, offset + 1)
}

describe('groupProviders（左侧分组）', () => {
  it('按 closed 分成两组，且保持传入顺序', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    const statuses = {
      a: { closed: false },
      b: { closed: true },
      c: { closed: false },
      d: { closed: true },
    }
    const { open, closed } = groupProviders(providers, statuses)
    expect(open.map(p => p.id)).toEqual(['a', 'c'])
    expect(closed.map(p => p.id)).toEqual(['b', 'd'])
  })

  it('组内顺序就是传入顺序，不重排（用户认知顺序必须稳定）', () => {
    const providers = [P('z'), P('a'), P('m')]
    const { open } = groupProviders(providers, {})
    expect(open.map(p => p.id)).toEqual(['z', 'a', 'm'])
  })

  it('状态缺失的供应商归入「已打开」（宁多勿少，避免一次失败看成全被关）', () => {
    const providers = [P('a'), P('b')]
    const { open, closed } = groupProviders(providers, { a: { closed: true } })
    expect(open.map(p => p.id)).toEqual(['b'])
    expect(closed.map(p => p.id)).toEqual(['a'])
  })

  it('closed 只认显式 true（与黑名单「非 true 即打开」的判据一致）', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: 1 }, b: { closed: 'true' }, c: { closed: undefined } }
    expect(groupProviders(providers, statuses).open.map(p => p.id)).toEqual(['a', 'b', 'c'])
    expect(groupProviders(providers, statuses).closed).toEqual([])
  })

  it('statuses 为 null / 非对象时不抛错，全部归入已打开', () => {
    const providers = [P('a'), P('b')]
    expect(groupProviders(providers, null).open).toHaveLength(2)
    expect(groupProviders(providers, null).closed).toHaveLength(0)
    expect(groupProviders(providers, 'bogus').open).toHaveLength(2)
  })

  it('providers 非数组时返回两个空组（不抛错）', () => {
    const { open, closed } = groupProviders(null, {})
    expect(open).toEqual([])
    expect(closed).toEqual([])
  })
})

describe('providerSwitchState（开关三形态）', () => {
  it('有模型且未全关 → 已打开（checked=true），可点击', () => {
    const s = providerSwitchState({ models: { total: 30, disabled: 13 }, closed: false })
    expect(s).toEqual({ checked: true, disabled: false, reason: null })
  })

  it('全部模型已关闭 → checked=false（开关呈关闭态），仍可点击以重新打开', () => {
    const s = providerSwitchState({ models: { total: 17, disabled: 17 }, closed: true })
    expect(s.checked).toBe(false)
    expect(s.disabled).toBe(false)
  })

  it('① 没有任何模型 → 禁用并给出原因（「不关闭模型就不关闭供应商」）', () => {
    const s = providerSwitchState({ models: { total: 0, disabled: 0 }, closed: false })
    expect(s.disabled).toBe(true)
    expect(s.checked).toBe(true)
    expect(s.reason).toContain('没有可关闭的模型')
  })

  it('② 状态未知（undefined）→ 禁用并说明原因', () => {
    const s = providerSwitchState(undefined)
    expect(s.disabled).toBe(true)
    expect(s.reason).toBeTruthy()
  })

  it('③ 状态非对象（异常输入）→ 禁用而不是抛错', () => {
    expect(providerSwitchState(null).disabled).toBe(true)
    expect(providerSwitchState('bogus').disabled).toBe(true)
  })

  it('models 字段缺失时视为 0 → 禁用（不误判为可操作）', () => {
    expect(providerSwitchState({ accounts: { total: 1 } }).disabled).toBe(true)
  })

  it('total 为负数等非法值 → 禁用（不给用户一个无效的操作入口）', () => {
    expect(providerSwitchState({ models: { total: -5 } }).disabled).toBe(true)
  })
})

describe('summarizeProviderToggle（结果文案）', () => {
  it('关闭：报告实际关闭的模型与停用的账号数', () => {
    expect(summarizeProviderToggle(false, { models: 17, accounts: 1 }))
      .toBe('已关闭 17 个模型，已停用 1 个账号')
  })

  it('打开：报告实际打开的模型与启用的账号数', () => {
    expect(summarizeProviderToggle(true, { models: 17, accounts: 2 }))
      .toBe('已打开 17 个模型，已启用 2 个账号')
  })

  it('⚠️ 变更数为 0 时不得谎报「已停用 N 个」（幂等操作要照实说）', () => {
    expect(summarizeProviderToggle(false, { models: 5, accounts: 0 }))
      .toBe('已关闭 5 个模型，没有账号需要停用')
  })

  it('两侧都为 0 时如实说明无事可做', () => {
    expect(summarizeProviderToggle(true, { models: 0, accounts: 0 }))
      .toBe('模型本就全部打开，账号本就全部启用')
  })

  it('res 缺失 / 字段非数字时不抛错，按 0 处理', () => {
    expect(summarizeProviderToggle(false, null)).toBe('没有模型需要关闭，没有账号需要停用')
    expect(summarizeProviderToggle(false, { models: 'x', accounts: null }))
      .toBe('没有模型需要关闭，没有账号需要停用')
  })
})

/**
 * 「供应商开关」弹窗的行数据。
 *
 * 弹窗要渲染的是「供应商定义 × 状态表」的拼接结果（顺序、勾选态、禁用态与原因、
 * 影响面计数），这些判定必须在纯逻辑层，不能留在渲染层 —— 否则左侧分组与弹窗
 * 两处各写一遍，迟早出现「左侧说它关了、弹窗里它还是开的」。
 */
describe('providerSwitchRows（弹窗行数据）', () => {
  it('⚠️ 已打开在前、已关闭在后，与左侧分组同一判据', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    const statuses = {
      a: { closed: false, models: { total: 3, disabled: 0 } },
      b: { closed: true, models: { total: 2, disabled: 2 } },
      c: { closed: false, models: { total: 1, disabled: 0 } },
      d: { closed: true, models: { total: 4, disabled: 4 } },
    }
    const rows = providerSwitchRows(providers, statuses)
    expect(rows.map(r => r.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(rows.map(r => r.checked)).toEqual([true, true, false, false])
  })

  it('每行带出影响面计数，供界面显示「模型 N（已关 M）· 账号 X（启用 Y）」', () => {
    const rows = providerSwitchRows([P('a')], {
      a: { closed: false, models: { total: 12, disabled: 3 }, accounts: { total: 5, enabled: 2 } },
    })
    expect(rows[0].models).toEqual({ total: 12, disabled: 3 })
    expect(rows[0].accounts).toEqual({ total: 5, enabled: 2 })
  })

  it('⚠️ 状态缺失时计数是 null 而不是 0（「不知道」与「确实是 0」必须能区分）', () => {
    const rows = providerSwitchRows([P('a')], {})
    expect(rows[0].models).toBeNull()
    expect(rows[0].accounts).toBeNull()
    expect(rows[0].disabled).toBe(true)
    expect(rows[0].reason).toBe('状态尚未读取')
  })

  it('没有可关闭模型的供应商被禁用并给出原因（服务端也会拒绝这个动作）', () => {
    const rows = providerSwitchRows([P('a')], { a: { models: { total: 0, disabled: 0 } } })
    expect(rows[0].disabled).toBe(true)
    expect(rows[0].reason).toBe('该供应商没有可关闭的模型')
    // 仍然显示为「打开」：未知/无事可做的东西不该被画成被关闭。
    expect(rows[0].checked).toBe(true)
  })

  it('label 缺失时回退到 id（界面上不会出现空行）', () => {
    const rows = providerSwitchRows([{ id: 'codearts' }], { codearts: { models: { total: 1 } } })
    expect(rows[0].label).toBe('codearts')
  })

  it('statuses 为 null / 非对象、providers 非数组时都不抛错', () => {
    expect(providerSwitchRows([P('a')], null).map(r => r.disabled)).toEqual([true])
    expect(providerSwitchRows([P('a')], 'bogus')[0].reason).toBe('状态尚未读取')
    expect(providerSwitchRows(null, {})).toEqual([])
  })

  it('⚠️ 与 groupProviders 的结论必须一致（两处判据不能漂移）', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: true, models: { total: 2 } }, b: { models: { total: 2 } } }
    const { open, closed } = groupProviders(providers, statuses)
    const rows = providerSwitchRows(providers, statuses)
    expect(rows.filter(r => r.checked).map(r => r.id)).toEqual(open.map(p => p.id))
    expect(rows.filter(r => !r.checked).map(r => r.id)).toEqual(closed.map(p => p.id))
  })
})

describe('providerToggleSummary（页头与弹窗的计数）', () => {
  it('给出 open / closed / total 与 known', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: true }, b: { closed: false }, c: { closed: true } }
    expect(providerToggleSummary(providers, statuses))
      .toEqual({ open: 1, closed: 2, total: 3, known: true })
  })

  it('⚠️ 状态没读回来时 known=false 且计数为 0 —— 界面据此**不显示**计数', () => {
    // 「已打开 0、已关闭 0」会被读成「一个供应商都没有」，而真实原因只是
    // provider.status 还没回来（或失败了）。
    expect(providerToggleSummary([P('a'), P('b')], null)).toEqual({
      open: 2, closed: 0, total: 2, known: false,
    })
    expect(providerToggleSummary([P('a')], undefined).known).toBe(false)
  })

  it('closed 只认显式 true（与分组、行数据三处同一口径）', () => {
    const providers = [P('a'), P('b')]
    const statuses = { a: { closed: 'true' }, b: { closed: 1 } }
    expect(providerToggleSummary(providers, statuses)).toMatchObject({ open: 2, closed: 0 })
  })

  it('providers 非数组时 total 为 0 且不抛错', () => {
    expect(providerToggleSummary(null, {})).toEqual({ open: 0, closed: 0, total: 0, known: true })
  })
})

describe('供应商开关的接线（源码级回归）', () => {
  it('引用了纯逻辑模块，而不是在本文件里另写一份判定', () => {
    expect(source).toContain("from './provider-toggle.js'")
    expect(source).toContain('groupProviders(')
    expect(source).toContain('providerSwitchRows(')
    expect(source).toContain('providerToggleSummary(')
  })

  it('rail 渲染出两个分组标题并带计数', () => {
    expect(source).toContain('dim-jh-railGroup')
    expect(source).toContain('dim-jh-railGroupTitle')
    expect(source).toContain('`已打开 (${open.length})`')
    expect(source).toContain('`已关闭 (${closed.length})`')
  })

  /**
   * ⚠️ 这条锁的是本次改动的**核心要求**：开关不得再挂在左侧供应商行尾。
   * 它曾与「选择要看哪个供应商」这个高频无害动作挤在同一行 —— 一个破坏性批量
   * 操作挂在导航栏上，既容易误点，也让窄栏长出了控件。
   */
  it('⚠️ 左侧供应商行里不再有开关（只剩一个 tab 按钮）', () => {
    const start = source.indexOf('const renderProviderRow = (p) => {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('const renderRail = () =>'))
    expect(body).not.toContain("React.createElement('input'")
    expect(body).not.toContain("type: 'checkbox'")
    expect(body).toContain("role: 'tab'")
    // 行容器仍不挂 onClick：点击只属于 tab 按钮。
    expect(body).toContain("className: 'dim-jh-providerRow'")
    expect(body).not.toMatch(/dim-jh-providerRow'[^}]*onClick/)
  })

  it('开关搬进弹窗：页头按钮点开，关闭即不挂载', () => {
    // ⚠️ 按钮文字是「供应商」而不是「供应商开关」：页头要排成一排，
    // 5 个字会把「关闭」挤到第二行。完整语义由 tooltip 与弹窗标题承担。
    expect(source).toContain("}, '供应商')")
    expect(source).toContain('title: (providerSummary.known')
    expect(source).toContain('setShowProviderSwitches(true)')
    // ⚠️ 不跨行断言：源文件是 CRLF，含 `\n` 的字面量匹配不上。
    expect(source).toContain('? React.createElement(ProviderSwitchPanel')
    expect(source).toContain('onClose: () => setShowProviderSwitches(false)')
  })

  it('两个全屏弹窗互斥：点开一个必须先关掉另一个', () => {
    // 供应商开关与网关都是 position:fixed 的全屏覆盖层，同时打开会叠在一起，
    // 而 ESC 只关掉后挂载的那个 —— 剩下一个关不掉的弹窗挡住整个设置页。
    // ⚠️ 取块方向是**向前**：`setShowGateway(false)` 写在
    // `setShowProviderSwitches(true)` 之前（先关对方、再开自己），从后往前找会漏。
    const supplierEnd = source.indexOf("}, '供应商')")
    const gatewayEnd = source.indexOf('}, gatewayButtonLabel(gatewayStatus))')
    expect(supplierEnd).toBeGreaterThan(-1)
    expect(gatewayEnd).toBeGreaterThan(-1)
    expect(source.slice(supplierEnd - 600, supplierEnd)).toContain('setShowGateway(false)')
    expect(source.slice(gatewayEnd - 600, gatewayEnd)).toContain('setShowProviderSwitches(false)')
  })

  it('弹窗行是 <label> + **恰好一个** checkbox（第二个会让「点行名」激活错控件）', () => {
    const body = panelBody()
    expect(body.match(/React\.createElement\('label'/g) ?? []).toHaveLength(1)
    expect(body.match(/type: 'checkbox'/g) ?? []).toHaveLength(1)
    expect(body).toContain("role: 'switch'")
    expect(body).toContain('checked: row.checked')
    expect(body).toContain('disabled: row.disabled || busy')
  })

  it('弹窗复用模型列表那套结构与类名，不另起一套', () => {
    const body = panelBody()
    for (const cls of [
      'dim-jh-modalOverlay', 'dim-jh-modalHead', 'dim-jh-modalHint',
      'dim-jh-modalBody', 'dim-jh-modelList', 'dim-jh-modelRow',
      'dim-jh-modelInfo', 'dim-jh-modelName', 'dim-jh-modelId', 'dim-jh-switch',
    ]) {
      expect(body, `弹窗缺少与模型列表共用的类名 ${cls}`).toContain(cls)
    }
    // ESC 关闭挂在 document 上：焦点可能落在任意一个开关上。
    expect(body).toContain("document.addEventListener('keydown', onKeyDown)")
  })

  it('已关闭的行整行淡出（data-disabled 表达「已关闭」，点不动才用 input disabled）', () => {
    expect(panelBody()).toContain("'data-disabled': row.checked ? 'false' : 'true'")
  })

  it('状态没读回来时不显示计数，也不谎报「已打开 0」', () => {
    expect(source).toContain('providerSummary.known')
    const body = panelBody()
    expect(body).toContain('summary.known')
    expect(body).toContain('statusFailed ?')
  })

  it('状态未就绪时退化为不分组平铺（不阻断账号管理）', () => {
    expect(source).toContain('if (providerStatuses === null)')
  })

  it('关闭前必须确认，且文案给出影响面', () => {
    expect(source).toContain('确认关闭「${label}」？')
    expect(source).toContain('取消则不做任何变更')
  })
})

describe('供应商开关的样式约束（源码级回归）', () => {
  /**
   * ⚠️ 这条锁的是用户报障「去掉开关后右边有片空白」。
   *
   * !25 时代这里是 `minmax(0, 1fr) auto` 两列（第二列放行尾开关）。开关搬到弹窗后，
   * 那列虽然 0 宽，**8px 的列间距却照样计入** —— 卡片右侧就多出一条看着像
   * 「rail 没铺满」的空白。所以这里断言「只有一列」，而不是「首列是 1fr」。
   * 首列仍必须是 `minmax(0, 1fr)`（不能是裸 `1fr`）：grid 项 min-width 默认 auto，
   * 长供应商名会把行撑宽、撑出 rail。
   */
  it('⚠️ .dim-jh-providerRow 只有**一列**（开关搬走后不得留下空列与列间距）', () => {
    expect(styles).toMatch(/\.dim-jh-providerRow \{[^}]*grid-template-columns: minmax\(0, 1fr\);/)
    expect(styles).not.toMatch(/\.dim-jh-providerRow \{[^}]*grid-template-columns:[^;]*auto/)
  })

  it('.dim-jh-providerRow 内的 .dim-jh-provider 允许收缩（min-width: 0）', () => {
    expect(styles).toMatch(/\.dim-jh-providerRow \.dim-jh-provider \{[^}]*min-width: 0/)
  })

  /**
   * 228px 是「给右侧让位」与「最长行不出省略号」的交点（用户先要收窄、
   * 随后报障「workbuddy国际版有省略号」—— 两个诉求在这条宽度上才同时成立）：
   * 可用文字宽 = 228 − 12(rail padding) − 2(边框) − 20(按钮 padding) − 30(图标)
   *                  − 8(图标间距) − 15(滚动条) = **143px**
   * 最长行 WorkBuddy (国际版) 实测要 141px（!25 实测表：200px + 开关时标签剩 77px、
   * 该行超宽 64px ⇒ 77 + 64 = 141）。
   * ⚠️ 再往回收就会截断；要更窄只能改短 label，而那会与 RaccoonProduct 等
   * displayName 的跨文件一致性断言冲突（见 raccoon-client-panel.spec.ts）。
   */
  it('rail 228px：省出开关那 8px 空列后，仍刚好不截断最长行', () => {
    expect(styles).toMatch(/\.dim-jh-rail \{ width: 228px;/)
    // 图标间距与按钮 padding 各收窄 2px 是「用开销换文字宽度」的一部分，别改回去。
    expect(styles).toMatch(/\.dim-jh-provider \{[^}]*gap: 8px; padding: 8px 10px/)
  })

  it('弹窗里的开关保持 flex: none（目标控件不参与收缩）', () => {
    expect(styles).toMatch(/\.dim-jh-switch \{[^}]*flex: none/)
  })

  /**
   * ⚠️ 页头按钮必须排成一排（用户报障：加了开关入口之后「关闭」掉到第二行）。
   * 两处配合缺一不可：brand 让出宽度、按钮组不参与收缩。
   */
  it('页头按钮排成一排：按钮组独占整行 + 极窄窗口仍换行', () => {
    // ⚠️ 左侧标题块（.dim-jh-brand）已于 2026-10-07 删除，按钮组改为 flex: 1
    // 独占整行（原先靠 brand 让出宽度 + flex: none 不收缩）。
    expect(styles).toMatch(/\.dim-jh-headerActions \{[^}]*flex: 1 1 auto/)
    // 极窄窗口的兜底仍在：换行好过溢出到窗口外点不到。
    expect(styles).toMatch(/\.dim-jh-headerActions \{[^}]*flex-wrap: wrap/)
  })

  /**
   * ⚠️ 页头左侧标题必须**保持删除**（两次删除，都不要加回来）：
   *
   * ① 副标题「提供商凭据与多账号管理」（.dim-jh-brandDesc）—— 2026-10-06：
   *    页头按钮太多，副标题既显示不全又挤占页头高度。
   * ② 标题本体「Jet Hub」（.dim-jh-brand / .dim-jh-brandName）—— 2026-10-07：
   *    页头一排已有 7 个按钮，标题只占宽度、不带任何操作。用户报障截图里
   *    「Jet Hub」还被折成两行（缺 white-space: nowrap），纯占地方。
   *
   * 这条是**反向断言**：初版删掉了 DOM 节点但没删 CSS、也没改这条用例，
   * 于是「样式已无引用」这种残留不会被任何测试发现 —— 加回来就重新占位。
   *
   * ⚠️ 语义不丢：`aria-label="Jet Hub Provider 设置"` 仍在 .dim-jh-page 上，
   * 宿主左侧导航也有「Jet Hub」项 —— 刻意用 `not.toMatch` 禁死 DOM 用法。
   */
  it('页头左侧标题块已整块移除：DOM 与样式表都不得再有', () => {
    // ⚠️ 只匹配**代码用法**（className 字面量 / CSS 规则），不匹配注释 ——
    // 上面注释故意保留「曾有标题」这段历史，读到就红会逼后人删掉它。
    expect(source).not.toMatch(/className: 'dim-jh-brandDesc'/)
    expect(styles).not.toMatch(/\.dim-jh-brandDesc\s*\{/)
    // 标题本体同样已删除：DOM 用法与 CSS 规则都要一并清掉。
    expect(source).not.toMatch(/className: 'dim-jh-brand'/)
    expect(source).not.toMatch(/className: 'dim-jh-brandName'/)
    expect(styles).not.toMatch(/\.dim-jh-brand\s*\{/)
    expect(styles).not.toMatch(/\.dim-jh-brandName\s*\{/)
    // 语义兜底必须还在：删了标题不能把可访问名一起删掉。
    expect(source).toContain("'aria-label': 'Jet Hub Provider 设置'")
  })
})

describe('供应商弹窗的自定义排序（2026-10-06 拖拽需求）', () => {
  describe('sortOpenProvidersByOrder（已打开组重排）', () => {
    it('order 内的按数组序排前，未列出的按声明顺序稳定补后', () => {
      const open = [P('a'), P('b'), P('c'), P('d')]
      expect(sortOpenProvidersByOrder(open, ['c', 'a']).map(p => p.id))
        .toEqual(['c', 'a', 'b', 'd'])
      expect(sortOpenProvidersByOrder(open, ['d', 'c', 'b', 'a']).map(p => p.id))
        .toEqual(['d', 'c', 'b', 'a'])
    })

    it('order 为 null / 空 / 未定义 → 完全保持声明顺序（未自定义的语义）', () => {
      const open = [P('z'), P('a'), P('m')]
      expect(sortOpenProvidersByOrder(open, null).map(p => p.id)).toEqual(['z', 'a', 'm'])
      expect(sortOpenProvidersByOrder(open, []).map(p => p.id)).toEqual(['z', 'a', 'm'])
      expect(sortOpenProvidersByOrder(open, undefined).map(p => p.id)).toEqual(['z', 'a', 'm'])
    })

    it('order 里的已关闭 / 未知 id 被跳过（不产生空洞，也不抛错）', () => {
      // 'x' 不在已打开组里（可能已关闭或来自旧版本），跳过即可。
      expect(sortOpenProvidersByOrder([P('a'), P('b'), P('c')], ['x', 'b', 'a']).map(p => p.id))
        .toEqual(['b', 'a', 'c'])
      expect(sortOpenProvidersByOrder([P('a'), P('b')], ['x', 'y']).map(p => p.id))
        .toEqual(['a', 'b'])
    })

    it('不修改入参数组（组件层依赖纯函数语义）', () => {
      const open = [P('a'), P('b'), P('c')]
      sortOpenProvidersByOrder(open, ['c', 'a'])
      expect(open.map(p => p.id)).toEqual(['a', 'b', 'c'])
    })
  })

  describe('nextProviderOrderAfterDrop（拖拽落点 → 完整顺序）', () => {
    it('before / after 两个方向都生效（由指针落点决定，与账号拖拽一致）', () => {
      // 把 a 拖到 b 之后：b 的位置放 a
      expect(nextProviderOrderAfterDrop(['a', 'b', 'c'], ['d'], 'a', 'b', 'after'))
        .toEqual(['b', 'a', 'c', 'd'])
      // 把 c 拖到 a 之前
      expect(nextProviderOrderAfterDrop(['a', 'b', 'c'], ['d'], 'c', 'a', 'before'))
        .toEqual(['c', 'a', 'b', 'd'])
    })

    it('无已关闭 id 时只返回 open 段（与 orderAfterDrop 逐字相同）', () => {
      expect(nextProviderOrderAfterDrop(['a', 'b', 'c'], [], 'a', 'c', 'after'))
        .toEqual(['b', 'c', 'a'])
    })

    it('已关闭组按声明顺序缀尾（未自定义顺序时的既有口径）', () => {
      expect(nextProviderOrderAfterDrop(['a', 'c'], ['b', 'e', 'd'], 'c', 'a', 'after'))
        .toEqual(['a', 'c', 'b', 'e', 'd'])
    })

    it('源与目标相同 → null（无需变更，调用方不提交）', () => {
      expect(nextProviderOrderAfterDrop(['a', 'b'], ['c'], 'a', 'a', 'before')).toBeNull()
    })
  })

  // ⚠️ 回归：PR #63 初版把已关闭 id 无条件缀尾，导致「关闭期间又拖一次」
  // 后旧位置永久丢失，重开时回不到用户排过的地方（PR 描述承诺「回到原位」）。
  describe('已关闭 id 在拖拽后保留原位（回归：关闭期间再拖一次）', () => {
    const IDS = ['a', 'b', 'c', 'd', 'e']

    /** 按面板真实路径走一遍：渲染 → 取 open/closed 段 → 拖拽 → 提交。 */
    const dropThrough = (order: string[] | null, closed: string[], s: string, t: string, p: 'before' | 'after') => {
      const providers = IDS.map(id => ({ id, label: id }))
      const statuses = Object.fromEntries(IDS.map(id => [
        id, { closed: closed.includes(id), models: { total: 3 } },
      ]))
      const rows = providerSwitchRows(providers, statuses, order)
      return nextProviderOrderAfterDrop(
        rows.filter(r => r.checked).map(r => r.id),
        rows.filter(r => !r.checked).map(r => r.id),
        s, t, p,
        // ⚠️ 必须把当前 order 传进去：已关闭 id 的位置由「它在**旧** order 里
        // 前面有几个已打开项」确定，漏传就退化成「按展示序缀尾」= 修复前行为。
        order,
      )
    }
    const renderIds = (order: string[] | null, closed: string[]) => {
      const providers = IDS.map(id => ({ id, label: id }))
      const statuses = Object.fromEntries(IDS.map(id => [
        id, { closed: closed.includes(id), models: { total: 3 } },
      ]))
      return providerSwitchRows(providers, statuses, order).map(r => r.id)
    }

    it('关闭某供应商后再次拖拽，该供应商重开时仍回到用户排过的位置', () => {
      // ① 用户把 d 拖到 b 之后 → a b d c e
      const first = dropThrough(null, [], 'd', 'b', 'after')
      expect(first).toEqual(['a', 'b', 'd', 'c', 'e'])
      // ② 关闭 d，在剩下 4 个里再拖一次（e 拖到 a 之后）→ a e b d c
      const second = dropThrough(first, ['d'], 'e', 'a', 'after')
      // ③ 重开 d：d 的锚点仍是「前面有 2 个已打开项」→ 跟在 b 之后，
      //    即它相对 a/e/b 的位置没变。❌ 修复前 d 会被甩到数组末尾。
      expect(renderIds(second, [])).toEqual(['a', 'e', 'b', 'd', 'c'])
      expect(second!.indexOf('d')).toBeLessThan(second!.indexOf('c'))
    })

    it('多个已关闭 id 各自保留原位，且不丢失、不重复', () => {
      let order = dropThrough(null, [], 'd', 'b', 'after')      // → a b d c e
      order = dropThrough(order, ['d', 'e'], 'c', 'a', 'after')  // 关闭 d/e，c 拖到 a 之后
      const all = renderIds(order, [])
      expect(all).toHaveLength(IDS.length)
      expect(new Set(all).size).toBe(IDS.length)
      // 语义是「贴着**旧顺序里的直接前驱**」：d 的前驱是 b → d 紧跟 b；
      // e 的前驱是 c（它在旧顺序里排最末）→ e 紧跟 c。
      // ⚠️ 断言必须落在前驱 id 上（不是「第 N 个 open」）—— 计数会漂移，前驱不会。
      expect(all.indexOf('d')).toBe(all.indexOf('b') + 1)
      expect(all.indexOf('e')).toBe(all.indexOf('c') + 1)
    })

    it('关闭组仍按声明顺序沉底（自定义顺序不覆盖关闭组的展示）', () => {
      let order = dropThrough(null, [], 'd', 'b', 'after')
      order = dropThrough(order, ['d', 'e'], 'c', 'a', 'after')
      // 展示侧只读 open 段并按声明序排关闭组：d、e 恒在末尾且 d 在 e 之前
      expect(renderIds(order, ['d', 'e'])).toEqual(['a', 'c', 'b', 'd', 'e'])
    })

    it('旧顺序缺失（未自定义）时退化为缀尾，不抛错', () => {
      // 无 oldOrder 可依据：已关闭 id 只能按展示顺序缀尾。
      expect(nextProviderOrderAfterDrop(['a', 'b'], ['c'], 'a', 'b', 'after'))
        .toEqual(['b', 'a', 'c'])
    })

    it('旧顺序里的未知/已删除 id 不产生空洞（跨版本增删 provider）', () => {
      // open=['a','b','c']；closed=['z']；旧顺序 x a b c 里混有已删除的 'x'。
      // 期望：'x' 既非 open 也非 closed → 被忽略；z 的前驱是 b → 插到 b 之后。
      const next = nextProviderOrderAfterDrop(
        ['a', 'b', 'c'], ['z'], 'c', 'a', 'after', ['x', 'a', 'b', 'c'],
      )
      expect(next).toEqual(['a', 'c', 'b', 'z'])
      // 关键不变量：没有重复、没有把已删除的 'x' 带回来
      expect(new Set(next).size).toBe(next!.length)
      expect(next).not.toContain('x')
    })

    it('前驱被拖到别处后，已关闭 id 仍跟住它（而非按计数漂移）', () => {
      // 旧顺序 a b d c e：d 的前驱是 b。
      // 这次把 b 拖到最前 → open 段 b a c，d 必须紧跟 b。
      const next = nextProviderOrderAfterDrop(
        ['a', 'b', 'c'], ['d'], 'b', 'a', 'before', ['a', 'b', 'd', 'c', 'e'],
      )
      expect(next).toEqual(['b', 'd', 'a', 'c'])
    })

    it('连续多个已关闭 id 共享同一前驱时，保持它们在旧顺序里的相对次序', () => {
      // ⚠️ 回归：逐个 splice 到前驱之后会让后一个挤到前一个**前面**
      // （b,d,e 变成 b,e,d，与旧序相反）—— 必须按前驱分组整块插入。
      const next = nextProviderOrderAfterDrop(
        ['a', 'b', 'c'], ['d', 'e'], 'c', 'a', 'after', ['a', 'b', 'd', 'e', 'c'],
      )
      // d 与 e 的前驱都是 b → 整块插在 b 之后，且保持 d 在 e 之前
      expect(next).toEqual(['a', 'c', 'b', 'd', 'e'])
    })

    it('跟不住的已关闭 id 沉尾（前驱缺失或为已删除的 id）', () => {
      // 前驱在旧顺序里不存在（跨版本新增的 provider）
      expect(nextProviderOrderAfterDrop(['a', 'b'], ['x'], 'a', 'b', 'after', ['a', 'b']))
        .toEqual(['b', 'a', 'x'])
      // 前驱是个已被删除的 id
      expect(nextProviderOrderAfterDrop(['a', 'b'], ['x'], 'a', 'b', 'after', ['zz', 'a', 'b']))
        .toEqual(['b', 'a', 'x'])
    })
  })

  describe('providerSwitchRows 的 order 参数（弹窗行数据）', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    // ⚠️ closed 供应商必须带 models.total：providerSwitchState 先判
    // 「没有可关闭的模型 → 禁用且 checked=true」，走不到 closed 判定
    // （真实 provider.status 恒带模型计数，测试数据必须同形）。
    const statuses = { c: { closed: true, models: { total: 3 }, accounts: { total: 1 } } }

    it('已打开组按 order 重排，已关闭组恒按声明顺序沉底（用户口径：逻辑不变）', () => {
      const rows = providerSwitchRows(providers, statuses, ['d', 'a'])
      expect(rows.map(r => r.id)).toEqual(['d', 'a', 'b', 'c'])
      // 关闭组的位置在最后，且开关呈现仍是「已关闭」
      expect(rows[3]!.checked).toBe(false)
    })

    it('order 未指定时与既有行为完全一致（向后兼容，rail 同源）', () => {
      expect(providerSwitchRows(providers, statuses).map(r => r.id))
        .toEqual(['a', 'b', 'd', 'c'])
      expect(providerSwitchRows(providers, statuses, null).map(r => r.id))
        .toEqual(providerSwitchRows(providers, statuses).map(r => r.id))
    })
  })

  describe('弹窗拖拽的接线（源码级回归）', () => {
    it('面板消费 order / onCommitOrder，并经 nextProviderOrderAfterDrop 提交', () => {
      const body = panelBody()
      expect(body).toContain('providerSwitchRows(providers, statuses, order)')
      expect(body).toContain('nextProviderOrderAfterDrop(')
      expect(body).toContain('onCommitOrder(next)')
      // ⚠️ 已关闭的行不得可拖：它恒按默认顺序沉底，能拖而不能落只会误导。
      expect(body).toContain('if (!row.checked || !dragEnabled) return { enabled: false };')
    })

    it('页面层走 provider.getOrder / provider.setOrder（宿主持久化）', () => {
      expect(source).toContain("rpcCall('provider.getOrder', {})")
      expect(source).toContain("rpcCall('provider.setOrder', { order: next })")
      // 顺序状态必须住宿主侧：客户端没有也不该有 localStorage（与既有架构一致）。
      expect(source).not.toContain('localStorage')
    })

    it('拖拽提交失败时不做乐观更新（回读保持与服务端一致）', () => {
      expect(source).toContain('await loadProviderOrder();')
    })

    it('行拖拽的视觉状态与账号卡片同款（淡出 + 插入线）', () => {
      // ⚠️ 必须带 `.dim-jh-modal` 作用域：`.dim-jh-modelRow` 是共享类名
      // （ModelToggle / GatewayPanel 也在用），挂 position:relative 作用域过宽。
      expect(styles).toContain('.dim-jh-modal .dim-jh-modelRow[data-dragging="true"]')
      expect(styles).toContain('.dim-jh-modal .dim-jh-modelRow[data-dropBefore="true"]::before')
      expect(styles).toContain('.dim-jh-modal .dim-jh-modelRow[data-dropAfter="true"]::after')
      // 插入线是 absolute 定位，行必须有 relative 锚点。
      expect(styles).toMatch(/\.dim-jh-modal \.dim-jh-modelRow \{ position: relative; \}/)
      // 反向断言：不得留下无作用域的全局规则
      expect(styles).not.toMatch(/^\.dim-jh-modelRow \[data-dragging/m)
    })

    // ⚠️ 回归（PR #63 复审发现）：初版 onDrop 漏传 oldOrder，已关闭 id 的位置
    // 在「关闭期间又拖一次」后永久丢失 —— 这条断言锁住调用点的实参个数。
    it('⚠️ onDrop 必须把当前 order 作为 oldOrder 传给 nextProviderOrderAfterDrop', () => {
      const body = panelBody()
      expect(body).toMatch(
        /nextProviderOrderAfterDrop\(openIds, closedIds, sourceId, row\.id, dropPosition, order\)/,
      )
    })
  })

  // ⚠️ 回归（PR #63 复审发现）：初版没有排序提交锁。不做乐观更新 ⇒ RPC 返回前
  // 界面顺序未变，再拖一次会基于旧顺序计算并把上一次的移动静默覆盖。
  describe('排序提交的互斥（防止连续拖拽互相覆盖）', () => {
    it('提交期间整体冻结拖拽（reordering 并入 dragEnabled）', () => {
      const body = panelBody()
      expect(body).toMatch(/busyIds\.size === 0[\s\S]{0,80}!reordering;/)
    })

    it('互斥用 ref 而非 state（两次 drop 可落在同一渲染周期内）', () => {
      // ⚠️ 局限（已知）：这是**存在性**断言，锁住「ref 声明 + 早退 + finally 释放」
      // 三处关键代码都在。它防不住「把锁挪进永不调用的死函数」这类伪装 ——
      // 单测环境没有 react，无法渲染组件做行为验证，这是架构性缺口。
      // 真正的行为保障是「拖拽提交期间整体冻结」那条（本组第 1 条）。
      expect(source).toContain('const reorderLockRef = React.useRef(false);')
      expect(source).toContain('if (reorderLockRef.current) return;')
      // 释放路径必须在 finally：失败时也要解锁，否则一次失败后拖拽永久失效。
      expect(source).toMatch(/finally \{[\s\S]{0,200}reorderLockRef\.current = false;/)
    })
  })

  // ⚠️ 回归（PR #63 复审发现）：失败提示原本只渲染在页面层，而弹窗遮罩是
  // fixed + z-index 3000，拖拽时完全看不到 —— 等于静默失败。
  describe('排序保存失败的提示必须可见', () => {
    it('弹窗内渲染 notice（复用既有样式，不新增 CSS）', () => {
      const body = panelBody()
      // ⚠️ 断言「无条件渲染」而非 `notice && notice.inModal`：弹窗开着时
      // toggleProvider 的结果提示在页面层同样被遮罩盖住，按 inModal 过滤会
      // 让「切换供应商」也变成静默无反馈。
      expect(body).toMatch(/^\s*notice\s*$/m)
      expect(body).not.toMatch(/notice\s*&&\s*notice\.inModal/)
      expect(body).toContain("className: 'dim-jh-probeNotice'")
    })

    it('页面层在弹窗打开时跳过渲染（避免遮罩内外重复出现两条）', () => {
      // 弹窗是 fixed + z-index 3000 的覆盖层，页面层那条必然被盖住 ⇒ 只在
      // 弹窗关闭时（不挂载）才由页面层渲染。
      expect(source).toMatch(/showProviderSwitches\s*\?[\s\S]{0,600}notice: providerNotice/)
      // 弹窗关闭时页面层仍要能显示（非 inModal 的那些，如切换结果）
      expect(source).toContain('providerNotice && !providerNotice.inModal')
    })

    it('失败分支标记 inModal（供页面层在弹窗关闭后决定是否延后展示）', () => {
      // ⚠️ 必须**剥掉注释**再匹配：这段代码附近有一整段说明「为什么要 inModal」
      // 的注释，直接对原文做宽窗口匹配可能被注释里的字面量喂饱。
      const codeOnly = source
        .split(/\r?\n/)
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
      expect(codeOnly).toMatch(/保存排序失败[\s\S]{0,240}inModal:\s*true/)
    })
  })

  // ⚠️ 2026-10-06 续作：主页 rail 跟随自定义排序 + 打开 Jet Hub 默认选中
  // 自定义序第一位的供应商（用户需求，本机已验收）。
  describe('自定义顺序的贯穿展示（主页 rail + 默认选中）', () => {
    it('主页 rail 的已打开组按 providerOrder 排序（closed 组恒声明序沉底）', () => {
      // ⚠️ renderRail 在 JetHubPage 里（ProviderSwitchPanel 之后），panelBody()
      // 的结束锚切不到它 —— 用整份 source 断言。
      expect(source).toContain('sortOpenProvidersByOrder(open, providerOrder)')
      // 关闭组不参与自定义排序（用户口径：「这个逻辑不变」）。
      expect(source).toContain("group(`已关闭 (${closed.length})`, closed, 'closed')")
    })

    it('默认选中卡片 = 自定义序第一位（providerTouchedRef 一次性纠偏）', () => {
      // 三处关键代码齐全：ref 声明 + 纠偏 effect + selectProvider 置 touched。
      expect(source).toContain('const providerTouchedRef = React.useRef(false);')
      expect(source).toContain('providerTouchedRef.current = true;')
      // 纠偏 effect 必须先查 touched，用户点过就不再接管。
      expect(source).toMatch(/if \(providerTouchedRef\.current\) return;/)
      // 「已打开」过滤：首位已关闭时跳到下一个 open（否则渲染出空面板）。
      expect(source).toMatch(
        /providerOrder\.find\(id => providerStatuses === null \|\| providerStatuses\?\.\[id\]\?\.closed !== true\)/,
      )
    })
  })
})
