/**
 * ZCode captcha **窗口任务栏脱敏**的跨平台测试。
 *
 * ## 守的是用户报障（2026-09-29）
 *
 * > captcha 的 chromium 每次刷新页面完成都会在任务栏**闪烁提示**；
 * > 任务栏自动隐藏时会不停浮出，挡住屏幕最下面一排。
 *
 * 根因（Win32 实测）：主窗口缺 `WS_EX_TOOLWINDOW`（`0x80`）——
 * 页面一渲染就获得任务栏按钮，有按钮就有东西可闪。
 *
 * ## ⚠⚠ 跨平台：两个平台**机制本质不同**
 *
 * | | Windows | Linux（X11） |
 * |---|---|---|
 * | 机制 | 窗口**属性**（`SetWindowLongPtr`） | **EWMH 协议**（`_NET_WM_STATE_SKIP_TASKBAR`） |
 * | 生效条件 | 立刻，不需 WM 配合 | **需 WM 支持**，且需外部 `wmctrl` |
 * | Wayland | — | **无效**（无 X11 访问权） |
 *
 * ⇒ Linux 是**尽力而为**：`wmctrl` 在就生效，不在就静默跳过。
 *
 * ## ⚠ 本文件能测什么、不能测什么（如实标注）
 *
 * **能测**（本机就跑）：
 *   - Linux 侧的**纯函数**：`parseWmctrlList`（解析 `wmctrl -lp`）、
 *     `buildLinuxSkipTaskbarArgs`（参数构造）—— 用真实输出格式
 *   - Windows 侧的**源码契约**（`-File` 而非 `-Command`、样式位、守卫等）
 *   - 平台分派：Windows / Linux / macOS 各走哪条路
 *
 * **不能测**（开发机是 Windows，WSL 实例损坏、无 X11 工具）：
 *   - Linux 上 `wmctrl` 的**真实效果** —— 未真机验证，故实现里失败全静默
 *
 * ⚠ Windows 真实行为由 `.tmp-zcode/verify-taskbar-fix.mjs` 端到端验证过
 *（修复后 `inTaskbar=false`、`mint` 仍成功）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLinuxSkipTaskbarArgs, parseWmctrlList } from '../../src/zcode-captcha.js'
import { sourceScope } from '../helpers/source-scope.js'

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/zcode-captcha.ts'),
  'utf8',
)

/**
 * 截取某个函数的源码 —— **恰好是它自己**。
 *
 * ⚠ 这里**不能**手写「找下一个列 0 的 `}`」：那在 CRLF 检出下会返回整个文件
 * 尾部（断言恒真、却分不清命中的是不是这个函数），在 LF 检出下会截到函数体内
 * 第一个列 0 的 `}`（本函数的 PowerShell 脚本内联了一段 C#，其类体闭合括号正好
 * 落在列 0）⇒ Windows 侧 7 条源码契约假失败。**两个方向都错**（issue IKJMG1），
 * 完整缘由见 `tests/helpers/source-scope.ts` 的文件头。
 */
const scope = sourceScope(SRC, 'zcode-captcha.ts')
const fnSource = scope.fn

describe('Linux：parseWmctrlList 解析 wmctrl -lp', () => {
  /** 真实格式（文档语义）：id 桌面号 pid 主机名 标题 */
  const SAMPLE = [
    '0x0320000a  0 12345  myhost 新标签页 - Chromium',
    '0x0340000b  0 12345  myhost Window With   Many   Spaces',
    '0x0360000c  0 99999  myhost Other App Window',
    '0x0380000d  1 12345  myhost Second Desktop',
    '',
  ].join('\n')

  it('★ 只挑出属于目标 pid 的窗口', () => {
    expect(parseWmctrlList(SAMPLE, 12345)).toEqual(['0x0320000a', '0x0340000b', '0x0380000d'])
    expect(parseWmctrlList(SAMPLE, 99999)).toEqual(['0x0360000c'])
  })

  it('★ 标题含**多个连续空格**也不影响（只按前 3 个字段切）', () => {
    /**
     * ⚠ 这条用例**必须**断言到「限段数」这个实现细节，否则测不出差异 ——
     * 我第一版只断言「结果等于 ['0xAB']」，而 `split(/\s+/)`（不限段）
     * 在**前 3 个字段相同**时结果也一样，于是反向验证时改坏了却**仍然通过**。
     *
     * 真正的差异在**标题里的空格**：限段数（`split(/\s+/, 5)`）能把标题
     * 保留成一段，不限段则会被拆成多段。本用例通过**超长标题**把这个
     * 差异暴露出来 —— 不限段时 `fields[2]` 之后全是碎片，虽然 pid 仍在
     * 第 3 位、结果碰巧相同，但**语义**已不同（`fields.length` 会误导）。
     *
     * 故这里直接断言**实现用了限段切分**（对契约的精确锁定），
     * 外加行为断言。
     */
    expect(fnSource('parseWmctrlList')).toMatch(/split\(\/\\s\+\/,\s*5\)/)
    const out = parseWmctrlList('0xAB  0 777  host  A    B     C', 777)
    expect(out).toEqual(['0xAB'])
    // 多行多窗口时也只取正确的
    const multi = [
      '0xAA  0 777 host one',
      '0xBB  0 888 host two',
      '0xCC  0 777 host three   with   spaces',
    ].join('\n')
    expect(parseWmctrlList(multi, 777)).toEqual(['0xAA', '0xCC'])
  })

  it('★ 非 `0x` 开头的行被忽略（防把杂项当窗口）', () => {
    const junk = ['not a window line', '1234 0 12345 host title', '0xGG 0 12345 host t'].join('\n')
    expect(parseWmctrlList(junk, 12345)).toEqual([])
  })

  it('pid 不匹配 / 非法 pid 都返回空', () => {
    expect(parseWmctrlList(SAMPLE, 1)).toEqual([])
    expect(parseWmctrlList('0x1 0 abc host t', Number.NaN)).toEqual([])
  })

  it('空输出与空行不抛错', () => {
    expect(parseWmctrlList('', 12345)).toEqual([])
    expect(parseWmctrlList('\n\n   \n', 12345)).toEqual([])
  })

  it('兼容 CRLF（Windows 上跑测试时的行尾）', () => {
    expect(parseWmctrlList('0x1 0 55 host t\r\n0x2 0 66 host u\r\n', 55)).toEqual(['0x1'])
  })
})

describe('Linux：buildLinuxSkipTaskbarArgs', () => {
  it('★ 必须是 `-i -r <id> -b add,skip_taskbar`', () => {
    expect(buildLinuxSkipTaskbarArgs('0x0320000a')).toEqual([
      '-i', '-r', '0x0320000a', '-b', 'add,skip_taskbar',
    ])
  })

  it('★ 必须带 `-i`（按**窗口 id** 匹配，而不是标题）', () => {
    // 标题里有空格与「-」：chromium 的是「新标签页 - Chromium」，
    // 不带 -i 会被 wmctrl 当标题做模糊匹配，可能命中别的窗口。
    expect(buildLinuxSkipTaskbarArgs('0x1')).toContain('-i')
  })

  it('★ 只加 skip_taskbar，不加 skip_pager（不改变用户既有预期）', () => {
    const args = buildLinuxSkipTaskbarArgs('0x1')
    const state = args[args.indexOf('-b') + 1] ?? ''
    expect(state).toBe('add,skip_taskbar')
    expect(state).not.toContain('skip_pager')
    expect(state).not.toContain('hidden')
  })
})

describe('平台分派：各平台走哪条路', () => {
  it('★ win32 → Windows 实现；linux → Linux 实现；darwin → macOS 实现（osascript 最小化）', () => {
    const src = fnSource('hideWindowFromTaskbar')
    expect(src).toMatch(/platform === 'win32'[\s\S]{0,60}hideWindowWindows\(pid\)/)
    expect(src).toMatch(/platform === 'linux'[\s\S]{0,60}hideWindowLinux\(pid\)/)
    // macOS 走自己的实现，且不得误落到 Windows/Linux 那两条分支上。
    // ⚠ 只传 pid：按进程名兜底会最小化用户自己正在用的浏览器，已删除。
    // 第二参只能是 log 回调，不可能是任何字符串 —— 故 AppleScript 里零字符串插值。
    expect(src).toMatch(/platform === 'darwin'[\s\S]{0,60}hideWindowMacos\(pid, log\)/)
    expect(src).not.toMatch(/darwin'\s*\)\s*hideWindowWindows/)
    expect(src).not.toMatch(/darwin'\s*\)\s*hideWindowLinux/)
    expect(src).not.toMatch(/exeName/)
    expect(src).not.toMatch(/hideWindowMacos\(pid, ['"]/)
  })

  it('★ 整个分派被 try 包住（任何平台失败都不能影响 captcha）', () => {
    const src = fnSource('hideWindowFromTaskbar')
    expect(src).toMatch(/try \{[\s\S]*hideWindowWindows[\s\S]*catch \{/)
  })

  it('★ macOS 藏窗失败必须告警（变异验证：删掉告警调用会红）', () => {
    // ⚠ 这条守的是「失败静默」与「静默到用户无线索」之间的边界：
    // 静默的是**对 captcha 的影响**（不能因此不可用），不是**对用户的可见性**。
    const mac = fnSource('hideWindowMacos')
    expect(mac).toContain("child.on('error'")
    expect(mac).toContain("child.on('close'")
    expect(mac).toMatch(/code !== 0[\s\S]{0,80}warnMacosHideOnce/)
    expect(mac).toMatch(/child\.on\('error'[\s\S]{0,80}warnMacosHideOnce/)
  })

  it('★ 告警只发一次（同一进程里反复 launch 不刷屏）', () => {
    // 一次性闸门是模块级状态，AST 取不到，故断言闸门本身被读写。
    expect(SRC).toMatch(/let macosHideWarned = false/)
    const warn = fnSource('warnMacosHideOnce')
    expect(warn).toMatch(/macosHideWarned\s*\)/) // 读：已告警则跳过
    expect(warn).toMatch(/macosHideWarned = true/) // 写：首次置位
  })

  it('★ 告警文案必须点明「辅助功能权限」与「不影响 captcha」', () => {
    // 用户报「窗口还是弹出来」时，这条文案就是唯一线索 —— 缺任一半都答不上来。
    const warn = fnSource('warnMacosHideOnce')
    expect(warn).toContain('辅助功能')
    expect(warn).toContain('不影响 captcha')
  })

  it('★ 调用点必须受 `hide` 门控（hideWindow:false 的语义是「别动我的窗口」）', () => {
    const src = fnSource('launch')
    expect(src).toMatch(/if \(hide && this\.child\?\.pid !== undefined\)/)
    // ⚠ 不得再把 `basename(executable)` 传进来：那是已删除的进程名兜底用的。
    expect(src).toMatch(/hideWindowFromTaskbar\(this\.child\.pid, this\.log\)/)
    // ⚠ 不得再把 `basename(executable)` 传进来：那是已删除的进程名兜底用的。
    expect(src).not.toMatch(/hideWindowFromTaskbar\(this\.child\.pid, basename/)
  })
})

describe('Windows：源码契约（每条都对应实测踩过的坑）', () => {
  it('★ 必须用 -File（不是 -Command）—— 内联版实测无效且会清坏样式', () => {
    const win = fnSource('hideWindowWindows')
    expect(win).toContain("'-File'")
    expect(win).not.toContain("'-Command'")
    expect(win).toContain('writeFileSync')
  })

  it('★ 脚本以 ASCII 写入（PS 5.1 对无 BOM UTF-8 按 ANSI 解读）', () => {
    const win = fnSource('hideWindowWindows')
    expect(win).toContain("'ascii'")
    const s = win.indexOf('const script = `')
    const e = win.indexOf('`', s + 20)
    expect(/^[\x00-\x7F]*$/.test(win.slice(s, e))).toBe(true)
  })

  it('★ 用 powershell.exe（系统自带），不依赖可选的 pwsh', () => {
    const win = fnSource('hideWindowWindows')
    expect(win).toContain("spawn('powershell.exe'")
    expect(win).not.toMatch(/spawn\('pwsh/)
  })

  it('★ 三个样式位：加 TOOLWINDOW + NOACTIVATE，清 APPWINDOW', () => {
    const win = fnSource('hideWindowWindows')
    expect(win).toContain('$TOOL = 0x80')
    expect(win).toContain('$APP = 0x40000')
    expect(win).toContain('$NOACT = 0x8000000')
    expect(win).toMatch(/\$before -bor \$TOOL -bor \$NOACT/)
    expect(win).toMatch(/-band \(-bnot \$APP\)/)
  })

  it('★ before 为 0 时跳过（防止把窗口样式清成 0）', () => {
    expect(fnSource('hideWindowWindows')).toContain('if ($before -eq 0) { continue }')
  })

  it('★ 只改自己 pid 的窗口', () => {
    const win = fnSource('hideWindowWindows')
    expect(win).toContain('if ([int]$wp -ne $target) { continue }')
    expect(win).toContain('$target = ')
  })

  it('临时脚本用完即删', () => {
    const win = fnSource('hideWindowWindows')
    expect(win).toContain("child.on('exit'")
    expect(win).toContain('safeRemoveDir')
  })
})

describe('Linux：源码契约', () => {
  it('★ 用 wmctrl 并**先按 pid 找窗口**（不能盲改所有窗口）', () => {
    const lin = fnSource('hideWindowLinux')
    expect(lin).toContain("spawn('wmctrl', ['-lp']")
    expect(lin).toContain('parseWmctrlList(')
    // 逐个窗口设置（不是"改全部"）
    expect(lin).toContain('buildLinuxSkipTaskbarArgs(')
  })

  it('★ wmctrl 不存在时静默（不能因优化失败让 captcha 挂掉）', () => {
    const lin = fnSource('hideWindowLinux')
    // spawn 失败走 error 事件
    expect(lin).toContain("list.on('error'")
    // 每个设置子进程也容忍失败
    expect(lin).toMatch(/child\.on\('error'/)
  })

  it('★ 不引入 npm 依赖 / 不手写 X11 协议（体积与风险）', () => {
    // 只用 spawn 调外部 wmctrl，不 import 任何 X11 库
    const lin = fnSource('hideWindowLinux')
    expect(lin).not.toMatch(/from '@|require\('(?!node:)/)
    expect(SRC).not.toMatch(/from 'x11'|from '@types\/x11'|require\('x11'\)/)
  })

  it('捕获输出用 pipe，其余忽略（不污染父进程 stdio）', () => {
    expect(fnSource('hideWindowLinux')).toContain("stdio: ['ignore', 'pipe', 'ignore']")
  })
})
