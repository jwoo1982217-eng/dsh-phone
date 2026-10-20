/**
 * ★ 一键签到「按单位分列」的**调用点契约**（2026-10-05 复审 PR !56 时新增）。
 *
 * ## 为什么必须有这个文件（它补的正是前一个 PR 的漏洞）
 *
 * `tests/unit/claim-unit-parity.spec.ts` 把 `formatClaimGains` **这个纯函数**锁得很死，
 * 但它只 import 纯函数、**从不看调用点**。于是 PR !56 里 4 个客户端调用点同时
 * 渲染出**双加号**，而**全量 5448 条用例全绿**：
 *
 * ```
 * jet-hub.js     bits.push(`+${amount}`)        →  "++100.00MToken"
 * jet-hub.js     `（共 +${totalAmount}）`        →  "（共 ++100.00MToken, +100积分）"
 * usage-badge.js bits.push(`+${amount}`)        →  "++800积分"
 * usage-badge.js `（共 +${totalAmount}）`        →  "（共 ++100.00MToken, +100积分）"
 * ```
 *
 * 根因是 **`formatClaimGains` 的返回值自带每个单位的 `+`**（这是它名字里
 * `Gains` 的含义，也是它自己的文档红线之一），而调用点「顺手」又拼了一次。
 * 纯函数层面的用例**结构上不可能**发现这种缺陷 —— 它测的是函数的输出，
 * 而 bug 在函数的**使用**上。
 *
 * ## 本文件守四件事
 * 1. **正向锚点**：每条反向断言都配一条正向断言，防止「文件改名 / 代码形态变了」
 *    导致反向断言**恒真**（本仓库已有先例：`zcode-claim-amount.spec.ts` 里那条
 *    `not.toMatch` 因为锚点形态根本不存在而**从未生效过**）。
 * 2. **不得重复拼 `+`**：4 个调用点 + 宿主侧 2 处。
 * 3. **数值与单位之间不留空格**：`+100.00MToken` 而不是 `+100.00M Token`
 *    （同一轮签到的明细行与汇总行不能像两种单位）。
 * 4. **用户报障的期望文案逐字成立**（端到端复刻，见文末）。
 *
 * ⚠️ 断言一律写成**单行**正则：本仓库源码是 **CRLF**，跨行锚点会命中 0 次
 * 而被静默跳过（PR !56 的反向验证首版就栽在这里，3 条多行变异被漏掉）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatClaimGains, formatUnitAmount } from '../../src/credits.js'
import { describeChannel } from '../../src/auto-checkin.js'

const dir = dirname(fileURLToPath(import.meta.url))

/**
 * 读源码并**剥掉整行注释**。
 *
 * ⚠️ 这一步是必需的，不是洁癖：这些源码里大量注释**逐字引用**了「曾经的错误写法」
 * （`// 本行原写作 （共 +${totalAmount}）` 之类）。若不剥离，反向断言会被**注释
 * 自己**命中 —— 本文件首版就是这么红了 4 条，而那不是源码有问题。
 *
 * 剥法按行：剔除 trim 后以 `//` / `*` / `/*` 开头的行（本仓库的注释一律整行书写，
 * 不存在行尾 `//` 注释里塞代码的形态）。
 *
 * ⚠️ 剥注释会**削弱**断言：若某天有人把错误写法只写在注释里，断言会放过它 ——
 * 但那本来就不是缺陷。真正要防的是**可执行代码**里的重复拼 `+`。
 * 每条反向断言都配了正向锚点，防止「锚点不存在 ⇒ 断言恒真」。
 */
function readCode(path: string): string {
  const raw = readFileSync(resolve(dir, path), 'utf8')
  return raw
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
    })
    .join('\n')
}

/** Jet Hub 设置页（含页头「一键签到」遍历全部渠道的 `checkinAll`）。 */
const panelSrc = readCode('../../plugin-src/client/jet-hub.js')
/** 用量徽标（含弹窗里的「签到所有渠道」`onClaimAll` 与单渠道 `summarizeClaim`）。 */
const badgeSrc = readCode('../../plugin-src/client/usage-badge.js')
/** 徽标纯逻辑（折叠态读数 `readingOf` —— 单位标签的另一个拼接点）。 */
const modelSrc = readCode('../../plugin-src/client/badge-model.js')
/** 宿主侧自动签到（落盘的 `lastResult` / 逐渠道 `channels[].text`）。 */
const autoSrc = readCode('../../src/auto-checkin.ts')

describe('★ 调用点契约：formatClaimGains 自带 `+`，调用方不得再拼', () => {
  /**
   * ⚠️ 先把「自带 `+`」这个前提**实测**一遍 —— 后面所有反向断言都建立在这条上。
   * 若哪天有人把 `+` 从函数里挪到调用点，这条会先红，提醒他同步改全部调用点。
   */
  it('前提：formatClaimGains 返回值自带每个单位的 `+`', () => {
    expect(formatClaimGains({ token: 100_000_000, credit: 100 })).toBe('+100.00MToken, +100积分')
    expect(formatClaimGains({ token: 0, credit: 800 })).toBe('+800积分')
    expect(formatClaimGains({ token: 100_000_000, credit: 0 })).toBe('+100.00MToken')
  })

  describe('jet-hub.js（设置页页头「一键签到」）', () => {
    it('① 逐渠道行：`bits.push(amount)` 而**不是** `` bits.push(`+${amount}`) ``', () => {
      // 正向锚点（防恒真）：这行必须真的存在
      expect(panelSrc).toMatch(/bits\.push\(amount\)/)
      // 反向：不得重复拼 `+`
      expect(panelSrc).not.toMatch(/bits\.push\(`\+\$\{amount\}`\)/)
    })

    it('② 汇总行：`` （共 ${totalAmount}） `` 而**不是** `` （共 +${totalAmount}） ``', () => {
      expect(panelSrc).toMatch(/（共 \$\{totalAmount\}）/)
      expect(panelSrc).not.toMatch(/（共 \+\$\{totalAmount\}）/)
    })
  })

  describe('usage-badge.js（用量徽标弹窗）', () => {
    it('① 逐渠道行：`bits.push(amount)` 而**不是** `` bits.push(`+${amount}`) ``', () => {
      expect(badgeSrc).toMatch(/bits\.push\(amount\)/)
      expect(badgeSrc).not.toMatch(/bits\.push\(`\+\$\{amount\}`\)/)
    })

    it('② 汇总行：`` （共 ${totalAmount}） `` 而**不是** `` （共 +${totalAmount}） ``', () => {
      expect(badgeSrc).toMatch(/（共 \$\{totalAmount\}）/)
      expect(badgeSrc).not.toMatch(/（共 \+\$\{totalAmount\}）/)
    })

    it('③ 单渠道摘要 `summarizeClaim`：`` 共 ${amount} ``（两处都不带 `+`）', () => {
      // ⚠️ 这一处**首版就是对的**（PR !56 写作 `共 ${amount}`）—— 留着它是因为
      //    三处手写、两种写法，正是「同一件事各拼各的」的典型温床。
      expect(badgeSrc).toMatch(/个账号领取成功，共 \$\{amount\}/)
      expect(badgeSrc).not.toMatch(/个账号领取成功，共 \+\$\{amount\}/)
    })
  })

  describe('宿主侧 src/auto-checkin.ts（落盘文案）', () => {
    it('describeRun：`` （${amounts}） `` 不带 `+`', () => {
      expect(autoSrc).toMatch(/（\$\{amounts\}）/)
      expect(autoSrc).not.toMatch(/（\+\$\{amounts\}）/)
    })

    it('describeChannel：`` ${summary.claimed} 个 ${amounts} `` 不带 `+`', () => {
      expect(autoSrc).toMatch(/个 \$\{amounts\}`\)/)
      expect(autoSrc).not.toMatch(/个 \+\$\{amounts\}`\)/)
    })
  })

  /**
   * ★ 用量徽标「积分区」**节标题**（2026-10-05 复审新发现的第三处同型缺陷）。
   *
   * 原写法 `quotaGroup === undefined ? '积分' : unitLabel(quotaGroup.unit)` 的
   * **兜底分支写死了「积分」**，而 ZCode 的额度单位是 token ⇒ 浮层里标题写
   * 「积分」、下面每个数值写 `94.54MToken`，**同一屏自相矛盾**。
   *
   * ⚠️ **为什么这条必须守在「调用点」而不是纯函数层**：修法是把判据抽成
   * `creditSectionLabel()` 纯函数（`badge-model.spec.ts` 有 6 条用例锁它），
   * 但**组件可以选择不调用它** —— 若有人把组件改回内联三元，
   * 那些纯函数用例**依然全绿**（这正是「纯函数级用例测不出使用错误」的同一个坑）。
   * 故这里额外断言：**组件必须调用该函数**，且**不得再内联写死「积分」的三元**。
   */
  describe('usage-badge.js 「积分区」节标题必须按单位走', () => {
    it('① 组件调用了 creditSectionLabel（正向锚点）', () => {
      expect(badgeSrc).toMatch(/creditSectionLabel\(/)
    })

    it('② 不得再出现「写死『积分』的三元兜底」', () => {
      // 旧形态的两种写法都要挡住：`? '积分' : unitLabel(...)` 与反向
      expect(badgeSrc).not.toMatch(/=== undefined \? '积分' : unitLabel\(/)
      expect(badgeSrc).not.toMatch(/!== undefined \? unitLabel\([^)]*\) : '积分'/)
    })
  })
})

describe('★ 数值与单位之间不留空格（同一轮签到不能像两种单位）', () => {
  /**
   * 真实缺陷（2026-10-05 复审）：`jet-hub.js` 的**逐账号明细**写作
   * `+${formatUnits(...)} ${unitLabel(unit)}`（带空格），而同一轮签到的**汇总行**
   * 由 `formatClaimGains` 产出 `+100.00MToken`（无空格）—— 两行并列显示成
   * `+100.00M Token` 与 `+100.00MToken`，用户会以为是两种单位。
   *
   * 口径来源：用户报障时给出的期望文案就是 `+100Mtoken`（无空格），
   * 且用量徽标的既有展示（`badge-model.js` 的 `94.54MToken`）同为无空格。
   */
  it('formatUnitAmount（宿主口径）无空格', () => {
    expect(formatUnitAmount(100_000_000, 'token')).toBe('100.00MToken')
    expect(formatUnitAmount(800, 'credit')).toBe('800积分')
  })

  it('客户端 formatClaimGains 同样无空格（与宿主逐字等价）', () => {
    expect(formatClaimGains({ token: 94_539_275, credit: 0 })).toBe('+94.54MToken')
  })

  it('jet-hub.js 逐账号明细：`}${unitLabel(unit)}` 而**不是** `} ${unitLabel(unit)}`', () => {
    // 正向锚点：这行必须真的存在（且确实用了 unitLabel）
    expect(panelSrc).toMatch(/\}\$\{unitLabel\(unit\)\}/)
    expect(panelSrc).not.toMatch(/\} \$\{unitLabel\(unit\)\}/)
  })

  it('usage-badge.js 余额行：`${text}${unitLabel(unit)}` 而**不是** `${text} ${unitLabel(unit)}`', () => {
    expect(badgeSrc).toMatch(/\$\{text\}\$\{unitLabel\(unit\)\}/)
    expect(badgeSrc).not.toMatch(/\$\{text\} \$\{unitLabel\(unit\)\}/)
  })

  /**
   * ★ 穷举断言（2026-10-05 复审补）：**凡数值后面跟单位标签的拼装点，一律不得有空格**。
   *
   * ## 为什么逐点断言不够（真实教训）
   *
   * 上面两条只钉住了**当时发现的那两个**位置。复审收尾时用「列出全部
   * `formatUnits(` 调用行」的宽搜复查，又抓到**第三处**漏网：
   * `usage-badge.js` 的**订阅套餐行**（`100.00M / 200.00MToken` 原本写作
   * `... ?? '?'} ${group.label}`，**带空格**）—— 它渲染的正是 `94.54M Token`，
   * 与同一弹窗积分区的 `94.54MToken` 并列时像两种单位。
   *
   * ⇒ 逐点断言的**覆盖是「已知位置」**，而缺陷可能出现在任何新调用点。
   *   故这里改为**遍历所有客户端源码**：只要出现「`}` 紧跟空白再紧跟 `${`」
   *   且紧随其后是单位标签变量，就判红。新增调用点漏了空格也会被这一条挡住。
   *
   * ⚠️ **必须排除的合法带空格形态**（否则会误报）：
   *   - `jet-hub.js` 的**模型分组标题** `${expanded ? '▾' : '▸'} ${group.label}`
   *     —— 这里的 `group.label` 是「GLM 系列」这类**分组名**，不是单位标签，
   *     且它有 `▾ ` 前缀，本来就该有空格；
   *   - 模板串里本来就有空格的其他文案（如 `` `另有 ${x} 已失效` ``）。
   *   故判据**只认单位标签变量名**（`unitLabel(...)` / `group.label` 中
   *   与 `formatUnits` 同行者），不做泛化的「所有 `${}` 前不得有空格」。
   */
  it('★ 穷举：任何 `formatUnits(...)` 的数值与单位标签之间都不得有空格', () => {
    const offenders = []
    for (const [name, src] of [['jet-hub.js', panelSrc], ['usage-badge.js', badgeSrc], ['badge-model.js', modelSrc]]) {
      src.split('\n').forEach((line, i) => {
        // 只看真正做了格式化拼接的行
        if (!line.includes('formatUnits(')) return
        // 形态：`formatUnits(...) ... }` 之后有空白，再紧跟 `${<标签>}`
        // 且该标签是单位标签（unitLabel / group.label / best.label / g.label）
        const spaced = /\)\s*\?\?\s*'\?'\}\s+\$\{(unitLabel\(|group\.label|best\.label)/.test(line)
          || /\)\}\s+\$\{(unitLabel\(|group\.label|best\.label)/.test(line)
        if (spaced) offenders.push(`${name}:${i + 1}  ${line.trim().slice(0, 120)}`)
      })
    }
    expect(offenders, `以下位置的单位标签前多了空格：\n${offenders.join('\n')}`).toEqual([])
  })

  it('★ 穷举的正向锚点：确实扫到了那些「无空格」的拼接点（防断言恒真）', () => {
    // 若哪天把这些拼接点全删了，上一条会恒真 —— 故这里断言它们真的存在
    expect(panelSrc).toMatch(/\}\$\{unitLabel\(unit\)\}/)
    expect(badgeSrc).toMatch(/\$\{text\}\$\{unitLabel\(unit\)\}/)
    expect(modelSrc).toMatch(/'\?'\}\$\{group\.label\}/)
    // 订阅套餐行（本次补修的那一处）
    expect(badgeSrc).toMatch(/'\.\?'\}\$\{group\.label\}|formatUnits\(group\.total, group\.unit\) \?\? '\?'\}\$\{group\.label\}/)
  })
})

describe('★ 用户报障的期望文案逐字成立（端到端复刻调用点拼装）', () => {
  /**
   * 报障原文：
   * > Zcode 获得的是 token 数量，但是这里显示成获得积分。
   * > 应当显示为「…ZCode（智谱）+100Mtoken（共 +100Mtoken, +100积分）」
   *
   * 本组**按修复后的调用点原样复刻**拼装，逐字断言用户要的形态 ——
   * 这是「修好了没有」的最终判据，而不是对实现的描述。
   *
   * ⚠️ 复刻必须与源码同步：若源码的拼装改了（如又加了个 `+`），本组会红。
   */
  it('设置页页头一键签到的完整文案', () => {
    // 逐渠道：`ZCode（智谱） +100.00MToken，CodeArts（华为云） +100积分`
    const zcodeBits = formatClaimGains({ token: 100_000_000, credit: 0 })
    const codeartsBits = formatClaimGains({ token: 0, credit: 100 })
    const parts = [
      `ZCode（智谱） ${zcodeBits}`,
      `CodeArts（华为云） ${codeartsBits}`,
    ]
    // 汇总：token 与积分**分列**（不跨量纲求和）
    const totalAmount = formatClaimGains({ token: 100_000_000, credit: 100 })
    const text = `一键签到：${parts.join('，')}（共 ${totalAmount}）`

    expect(text).toBe(
      '一键签到：ZCode（智谱） +100.00MToken，CodeArts（华为云） +100积分（共 +100.00MToken, +100积分）',
    )
    // 报障里那串「跨量纲求和」的数字不得再出现
    expect(text).not.toContain('100000100')
    expect(text).not.toContain('+100000000')
    // 双加号不得出现（本次复审修的正是它）
    expect(text).not.toContain('++')
  })

  it('自动签到落盘文案（宿主 describeChannel / describeRun）', () => {
    // 逐渠道：`1 个 +100.00MToken`
    expect(describeChannel({
      claimed: 1, totalCredit: 100_000_000, alreadyClaimed: 0, inactive: 0, failed: 0,
      totalByUnit: { token: 100_000_000, credit: 0 },
    })).toBe('1 个 +100.00MToken')
  })
})

describe('★ 反向验证：本文件确实能抓住「重复拼 +」与「空格」两类回归', () => {
  /**
   * ⚠️ 这组用例本身是**元测试**：它证明上面那些 `not.toMatch` 不是恒真的
   * —— 把错误形态喂给同一个正则，必须命中。
   *
   * 写法上刻意**复用上面用的正则形状**（把 `\`+` 换成已知的错误串），
   * 这样一旦有人把上面的正则写歪（例如转义错误导致永不命中），这里会一起红。
   */
  it('双加号形态确实能被正则命中（证明 not.toMatch 有效）', () => {
    const wrongCallsite = 'if (amount !== null) bits.push(`+${amount}`);'
    expect(wrongCallsite).toMatch(/bits\.push\(`\+\$\{amount\}`\)/)

    const wrongSummary = '? `一键签到：${parts}（共 +${totalAmount}）`'
    expect(wrongSummary).toMatch(/（共 \+\$\{totalAmount\}）/)
  })

  it('带空格形态确实能被正则命中（证明 not.toMatch 有效）', () => {
    const wrongDetail = '+ `+${formatUnits(outcome.credit, unit)} ${unitLabel(unit)}`,'
    expect(wrongDetail).toMatch(/\} \$\{unitLabel\(unit\)\}/)

    const wrongBalance = 'return `${text} ${unitLabel(unit)}`;'
    expect(wrongBalance).toMatch(/\$\{text\} \$\{unitLabel\(unit\)\}/)
  })
})
