import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  accountLabel,
  avgPerfText,
  avgPerfTooltip,
  channelCardTitle,
  channelLabel,
  channelOrder,
  entryTokenText,
  formatDuration,
  formatEntryTime,
  formatTps,
  formatTtft,
  formatTokenCount,
  filterChannelsBySelection,
  hasAnyData,
  historyHeatmapCells,
  historyTitle,
  HISTORY_RANGES,
  ledgerSubtitle,
  rangeDaysOf,
  tokenSummaryText,
  todayDayKey,
} from '../../plugin-src/client/token-ledger-panel.js'

/** 源码契约测试用：定位仓库根下的 src/ 与 plugin-src/。 */
const here = dirname(fileURLToPath(import.meta.url))
/**
 * 面板源码全文（**模块级**：多个 describe 都要读它 —— 放进单个 describe 里
 * 会让后面的用例拿到 undefined 却不报错，只在 `client.slice` 处才炸）。
 */
const client = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')

describe('formatTokenCount', () => {
  it('千分位：<10K 精确显示', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1234)).toBe('1,234')
    expect(formatTokenCount(9999)).toBe('9,999')
  })

  it('K / M 单位：大数紧凑，去尾随 0', () => {
    expect(formatTokenCount(10_000)).toBe('10K')
    expect(formatTokenCount(12_345)).toBe('12.35K')
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(94_540_000)).toBe('94.54M')
  })

  it('垃圾值按 0 处理（负数/NaN/非数）', () => {
    expect(formatTokenCount(-5)).toBe('0')
    expect(formatTokenCount(Number.NaN)).toBe('0')
    expect(formatTokenCount(undefined as never)).toBe('0')
  })
})

describe('tokenSummaryText / entryTokenText', () => {
  it('汇总：默认只显示总处理量，拆分放在悬浮详情', () => {
    expect(tokenSummaryText({ inputTokens: 1200, outputTokens: 340 })).toBe('总处理 1,540')
    expect(tokenSummaryText({ inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, reasoningTokens: 56 }))
      .toBe('总处理 2,340')
    expect(tokenSummaryText({ inputTokens: 1200, outputTokens: 340, cacheWriteTokens: 9 }))
      .toBe('总处理 1,540')
    // 0 值段省略（不渲染恒 0 的装饰数字）
    expect(tokenSummaryText({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 }))
      .toBe('总处理 3')
  })

  it('明细行：未收到 usage 显示 —，与「用了 0」严格区分', () => {
    expect(entryTokenText({ usageReported: false, inputTokens: 0, outputTokens: 0 })).toBe('—')
    expect(entryTokenText({ usageReported: true, inputTokens: 0, outputTokens: 0 })).toBe('总处理 0')
    expect(entryTokenText(null)).toBe('—')
    expect(entryTokenText(undefined)).toBe('—')
  })
})

describe('formatDuration / formatEntryTime', () => {
  it('耗时：0/负数 → —，<1s 毫秒，≥1s 一位小数', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(320)).toBe('320ms')
    expect(formatDuration(4200)).toBe('4.2s')
  })

  it('时间：HH:MM:SS；垃圾时间戳 → —', () => {
    const d = new Date(2026, 9, 5, 8, 7, 9)
    expect(formatEntryTime(d.getTime())).toBe('08:07:09')
    expect(formatEntryTime(Number.NaN)).toBe('—')
  })
})

describe('渠道维度', () => {
  it('channelLabel / channelOrder：直连在前', () => {
    expect(channelLabel('direct')).toBe('直连')
    expect(channelLabel('gateway')).toBe('网关')
    expect(channelOrder('direct', 'gateway')).toBeLessThan(0)
    expect(channelOrder('gateway', 'direct')).toBeGreaterThan(0)
    expect(channelOrder('direct', 'direct')).toBe(0)
  })

  it('channelCardTitle：渠道名 + 请求数', () => {
    expect(channelCardTitle({ channel: 'gateway', totals: { requests: 7 } })).toBe('网关 · 7 次请求')
    expect(channelCardTitle(null)).toBe('直连 · 0 次请求')
  })

  it('filterChannelsBySelection：null = 全部；否则按渠道', () => {
    const channels = [
      { channel: 'direct', totals: { requests: 1 } },
      { channel: 'gateway', totals: { requests: 2 } },
    ]
    expect(filterChannelsBySelection(channels, null)).toHaveLength(2)
    expect(filterChannelsBySelection(channels, 'gateway')[0]!.channel).toBe('gateway')
    expect(filterChannelsBySelection(channels, 'direct')[0]!.channel).toBe('direct')
    expect(filterChannelsBySelection(undefined, null)).toEqual([])
  })
})

describe('空状态', () => {
  it('hasAnyData：有明细才 true；ledgerSubtitle 说明明细与存盘的差别', () => {
    expect(hasAnyData({ entries: [{ ts: 1 }] })).toBe(true)
    expect(hasAnyData({ entries: [] })).toBe(false)
    expect(hasAnyData(null)).toBe(false)
    const subtitle = ledgerSubtitle()
    // 第 2 期：明细重启清空，但日累计已落盘 —— 两者都要说清。
    expect(subtitle).toContain('重启')
    expect(subtitle).toContain('存盘')
  })
})

describe('账号维度（第 2 期）', () => {
  it('accountLabel：空串给「未归属」，其余原样', () => {
    expect(accountLabel('')).toBe('未归属')
    expect(accountLabel(undefined)).toBe('未归属')
    expect(accountLabel('qoder-bb211a53')).toBe('qoder-bb211a53')
  })
})

/**
 * ⚠️ 均值口径必须**显式说明**（真实缺陷，用户 2026-10-07 报障「982.5 tok/s」）。
 *
 * 症状：lobsterai 的速率显示 982.5 tok/s，远超该模型的合理区间。根因是
 * `decodeMs` 塌缩到个位数毫秒（服务端已修），但**均值口径**本身仍需交代：
 * 算术平均对离群样本敏感，不给口径用户无从判断某天的高值是真快还是被拉高。
 */
describe('均值口径说明', () => {
  it('avgPerfTooltip 说明了解码时长门槛与「均值对离群样本敏感」', () => {
    const tip = avgPerfTooltip()
    // 门槛数值必须写出来（用户要能核对服务端判据）。
    expect(tip).toContain('100ms')
    // 「算术平均」与「敏感」两句都在：缺任一句都无法解释异常值。
    expect(tip).toContain('算术')
    expect(tip).toContain('敏感')
    // 口径要指明分子分母，不能只说「速率」。
    expect(tip).toContain('输出 token')
    expect(tip).toContain('首块')
  })

  it('★ 全部均值格必须挂口径 tooltip（7 处调用点不得漏）', () => {
    // 收敛到 perfCell 一个 helper：逐个调用点各写一份 title 时必然会漏。
    expect(client).toMatch(/const perfCell = \(row\) =>/s)
    expect(client).toMatch(/className: 'dim-jh-ledgerPerf',\s*title: avgPerfDetailTooltip\(row\)/)
    // 不得再有裸的 avgPerfText 调用（那是没有 tooltip 的漏网渲染）。
    const rawCalls = client.match(/className: 'dim-jh-ledgerPerf' \}, avgPerfText\(/g) ?? []
    expect(rawCalls).toEqual([])
    // 7 个均值渲染点全部经由 perfCell（明细模型行 + 汇总 4 处 + 历史日树 3 处）。
    expect((client.match(/perfCell\(/g) ?? []).length).toBe(7)
    // ⚠️ 余下那处 ledgerPerf 是历史区的「合计」格（无均值、无需口径说明）——
    // 刻意不要求它挂 tooltip，故不能断言 ledgerPerf 全文只出现一次。
    expect(client).toContain('总处理 ')
  })

  it('弹窗提示用户可悬停查看完整口径', () => {
    // ⚠️ 判据必须锚在「Token 用量」那处弹窗：全文件有 13 处 modalHint
    // （多个弹窗复用），按位置切片会切到别的弹窗上去。
    const modalIdx = client.indexOf("'aria-label': 'Token 用量'")
    expect(modalIdx).toBeGreaterThan(-1)
    const hint = client.slice(modalIdx, client.indexOf('dim-jh-modalBody', modalIdx))
    expect(hint).toContain('悬停数字查看 Token 拆分与性能口径')
  })

  it('弹窗说明 tooltip 必须作为 props 传入，不能作为 React 子节点', () => {
    const modalIdx = client.indexOf("'aria-label': 'Token 用量'")
    const modal = client.slice(modalIdx, client.indexOf('dim-jh-modalBody', modalIdx))
    // React 不允许把普通对象渲染为子节点；放错 createElement 参数会令整个页面崩溃。
    expect(modal).toMatch(/React\.createElement\('p',\s*\{\s*className: 'dim-jh-modalHint',\s*title:/)
  })
})

describe('首字用时与速率（第 3 期）', () => {
  it('formatTtft：缺失/0 → —；有值按耗时格式化', () => {
    expect(formatTtft(undefined)).toBe('—')
    expect(formatTtft({})).toBe('—')
    expect(formatTtft({ ttftMs: 0 })).toBe('—')
    expect(formatTtft({ ttftMs: 850 })).toBe('850ms')
    expect(formatTtft({ ttftMs: 2900 })).toBe('2.9s')
  })

  it('formatTps：缺失/非正 → —；有值带单位', () => {
    expect(formatTps(undefined)).toBe('—')
    expect(formatTps({ tps: 0 })).toBe('—')
    expect(formatTps({ tps: 52.3 })).toBe('52.3 tok/s')
    expect(formatTps({ tps: 100 })).toBe('100 tok/s')
  })

  it('avgPerfText：两边都无 → —；单边有值时另一边占位', () => {
    expect(avgPerfText(undefined)).toBe('—')
    expect(avgPerfText({})).toBe('—')
    expect(avgPerfText({ avgTtftMs: 850 })).toBe('首字 850ms')
    expect(avgPerfText({ avgTps: 48.2 })).toBe('均值 48.2 tok/s')
    expect(avgPerfText({ avgTtftMs: 1200, avgTps: 51.5 })).toBe('首字 1.2s · 均值 51.5 tok/s')
  })
})

describe('历史视图（第 4 期）', () => {
  it('HISTORY_RANGES / rangeDaysOf：窗口 key → 天数；未知 key 回退全部(0)', () => {
    expect(HISTORY_RANGES.map((r) => r.key)).toEqual(['today', '7d', '30d', 'all'])
    expect(rangeDaysOf('today')).toBe(1)
    expect(rangeDaysOf('7d')).toBe(7)
    expect(rangeDaysOf('30d')).toBe(30)
    expect(rangeDaysOf('all')).toBe(0)
    expect(rangeDaysOf('bogus')).toBe(0)
  })

  it('todayDayKey：与服务端 utc8DayKey 同形（YYYY-MM-DD）', () => {
    expect(todayDayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('historyHeatmapCells：补齐缺失日期、按用量分档并标记真实今天', () => {
    const history = [
      { day: '2026-10-07', totals: { requests: 1, inputTokens: 25, outputTokens: 25 } },
      { day: '2026-10-09', totals: { requests: 3, inputTokens: 100 } },
    ]
    const cells = historyHeatmapCells(history, 5, '2026-10-09')
    expect(cells.map((cell) => cell.day)).toEqual([
      '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
    ])
    expect(cells.map((cell) => cell.tokens)).toEqual([0, 0, 50, 0, 100])
    expect(cells.map((cell) => cell.level)).toEqual([0, 0, 2, 0, 4])
    expect(historyHeatmapCells(undefined, 1, todayDayKey())[0]?.isToday).toBe(true)
    expect(historyHeatmapCells(undefined, 5, '2026-01-05').every((cell) => !cell.isToday)).toBe(true)
  })

  it('historyTitle：窗口 key → 标题；未知回退「全部」', () => {
    expect(historyTitle('7d')).toBe('历史用量 · 近 7 天')
    expect(historyTitle('bogus')).toBe('历史用量 · 全部')
  })
})

/**
 * ⚠️ 历史视图的**响应体字段名契约**（真实缺陷的闸门）。
 *
 * 症状（用户 2026-10-07 报障）：过了 00:00 打开「Token 用量」，「今日」窗口
 * 右侧合计显示「284 次请求」，主体却显示「还没有历史用量」。数据在响应里，
 * 柱子却是空的 —— 空状态文案还反过来说「今天发起的请求明天就能在这里看到」。
 *
 * 根因：RPC 响应体的天数数组在 `history` 键（与 `totals` 平级，见
 * `RpcUsageTokenLedgerHistoryResponse`），客户端读的是 `history?.days` ⇒ 恒
 * undefined ⇒ `historyDays` 恒为 `[]`。`totals` 读对了，所以合计照常显示 ——
 * **两者一好一坏正是这个 bug 的指纹**。
 *
 * 为什么两侧单测都拦不住：`token-ledger.spec.ts` 只测服务端函数返回
 * `{ days, totals }`（服务端内部形状，对 RPC 字段名无约束），
 * `token-ledger-panel.spec.ts` 只测纯函数热力图数据（喂数组，不碰响应体）。
 * 跨进程的那一层**两侧都够不着** —— 只能断言源码字面量。
 *
 * 判据用**字段名的存在性**（`history.history` / `history.days`）而非整段字面量：
 * 改格式、换引号、加注释都不该假失败，但字段名改错必须变红。
 */
describe('历史视图 · RPC 响应体字段名契约', () => {
  it('客户端读的是 `history.history`（RPC 的真实字段名），不是 `history.days`', () => {
    expect(client).toMatch(/Array\.isArray\(history\?\.history\)/)
    // ⚠️ 旧读法必须**显式禁死**：它是本缺陷的写法，留着就会二次复发。
    expect(client).not.toMatch(/history\?\.days/)
  })

  it('服务端 RPC 构造的响应体确实带 `history` 键', () => {
    const rpc = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
    expect(rpc).toMatch(/RpcUsageTokenLedgerHistoryResponse\s*=\s*\{\s*history:/)
  })

  it('类型声明的字段名与客户端一致（`history`，非 `days`）', () => {
    const types = readFileSync(resolve(here, '../../src/types.ts'), 'utf8')
    const block = types.slice(types.indexOf('interface RpcUsageTokenLedgerHistoryResponse'))
    expect(block).toMatch(/^\s*history: TokenLedgerHistoryDay\[\]/m)
    expect(block).not.toMatch(/^\s*days:/m)
  })
})

describe('历史用量删除 · 范围隔离契约', () => {
  it('客户端二次确认后只调用单日历史删除 RPC，并在确认文案中声明保留明细与其他日期', () => {
    expect(client).toMatch(/usage\.tokenLedgerDeleteDay',\s*\{\s*day\s*\}/)
    expect(client).toMatch(/只清除这一天的日累计，不会清除实时明细、其他日期或账号设置/)
    expect(client).toMatch(/删除此日/)
  })

  it('服务端只接受有效日期键，并委托给历史账本删除入口', () => {
    const rpc = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
    expect(rpc).toMatch(/case 'usage\.tokenLedgerDeleteDay'/)
    expect(rpc).toMatch(/isValidTokenLedgerDayKey\(req\?\.day\)/)
    expect(rpc).toMatch(/deleteTokenLedgerDay\(req\.day\)/)
  })
})

/** 热力图渲染接线契约：数据分档、四行样式与用户指定的简洁布局。 */
describe('用量热力图 · 渲染接线与样式契约', () => {
  const styles = readFileSync(resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

  it('渲染热力图数据，并将档位交给色阶样式', () => {
    expect(client).toMatch(/historyHeatmapCells\(historyDays,\s*heatmapDays,\s*heatmapEndDay\)/)
    expect(client).toMatch(/'data-level': String\(cell\.level\)/)
  })

  it('固定四行，且不渲染星期标签或少/多图例', () => {
    expect(styles).toMatch(/\.dim-jh-ledgerHeatmap\s*\{[^}]*grid-template-rows:\s*repeat\(4,/s)
    expect(client).not.toContain('dim-jh-ledgerHeatmapWeekdays')
    expect(client).not.toContain('dim-jh-ledgerHeatmapLegend')
  })

  it('用量档位提高时颜色变深并增强青色发光', () => {
    expect(styles).toMatch(/\.dim-jh-ledgerHeatmapCell\[data-level="4"\]\s*\{[^}]*background:\s*#0e7490[^}]*box-shadow:/s)
  })

  it('⚠️ 样式文件仍是合法的单段模板字符串（STYLES 内不得出现反引号）', () => {
    // 该文件用模板字符串承载 CSS：注释里写一个反引号就会提前闭合、esbuild 报错。
    // ⚠️ 只查**配对**不够（2026-10-07 两次事故的反例）：像 space-between 这样
    // 「一对反引号包一个词」在 JS 语法上完全合法、backtick 计数仍是偶数，
    // 却是 esbuild 真正报错的那一种。故再断言 STYLES 的 CSS 段里**一个反引号
    // 都没有**（整文件只允许首尾各一个）。
    const backticks = (styles.match(/`/g) ?? []).length
    expect(backticks % 2).toBe(0)
    // STYLES = ` ... ` 的内容段（首个与末个反引号之间）不得含任何反引号。
    const start = styles.indexOf('`')
    const end = styles.lastIndexOf('`')
    const css = styles.slice(start + 1, end)
    expect(css).not.toMatch(/`/)
  })
})
