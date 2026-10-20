/**
 * ZCode 窗口隐藏在 **macOS** 上的回归测试。
 *
 * ## 守的是什么
 *
 * `hideWindowFromTaskbar()` 此前只有 win32 / linux 两个分支，macOS 上窗口照常弹出。
 * 本次补 darwin 分支：用 `osascript` 驱动 System Events 把该 pid 的窗口
 * **最小化**（`set miniaturized of every window to true`）。
 *
 * 选最小化而不是移屏 / 1×1 / headless，是真机逐一验证过的结论（详见
 * `hideWindowMacos` 的 JSDoc 表格）：移屏会被 chromium 直接忽略该启动参数而
 * 窗口压根没动，1×1 与 headless 都会偶发 `F001`，只有最小化既不挡屏幕又 mint 稳定。
 *
 * ## 为什么必须抽成纯函数（否则 CI 测不到）
 *
 * `hideWindowMacos()` 内部要 `spawn('osascript', …)`，在 Linux/Windows 测试机上
 * 根本执行不到，darwin 分支会静默通过。故命令构造抽成纯函数
 * {@link buildMacosMiniaturizeArgs}（**按 pid 匹配，唯一一条路径**）。
 *
 * 该函数不碰文件系统与进程，任意平台都能逐字断言 AppleScript。
 *
 * ## 三条必须同时成立的不变式
 *
 * 1. **只按 pid 匹配**：初版还有一条「按进程名兜底」，**已删除** —— `whose name is`
 *    匹配**任意**同名进程，会最小化用户自己正在用的浏览器。理由与代价见
 *    `hideWindowMacos` 的 JSDoc；契约锁在 `zcode-window-hide-macos-review.spec.ts`。
 * 2. **不得有任何字符串插值**：唯一插值是整数 pid ⇒ 不存在引号/反斜杠转义问题。
 * 3. **失败一律静默**：未授予「辅助功能」权限时 `osascript` 非零退出，
 *    这是「减少打扰」的优化失效，绝不能让 captcha 因此不可用。
 */
import { describe, expect, it } from 'vitest'
import { buildMacosMiniaturizeArgs } from '../../src/zcode-captcha.js'

/** AppleScript 的公共前缀与公共后缀，唯一一条路径共用这套 System Events 句法。 */
const HEAD = 'tell application "System Events" to set miniaturized of every window of'
const TAIL = 'to true'

describe('ZCode 窗口隐藏 · macOS（osascript 最小化）', () => {
  it('★ pid 路径：按 unix id 精确匹配，参数形状为 -e <script>', () => {
    expect(buildMacosMiniaturizeArgs(4242)).toEqual([
      '-e',
      `${HEAD} (first process whose unix id is 4242) ${TAIL}`,
    ])
  })

  it('★ 唯一路径：脚本里不得出现 name is（按名字匹配会误伤用户自己的浏览器）', () => {
    expect(buildMacosMiniaturizeArgs(4242).join(' ')).not.toContain('whose name is')
  })

  it('★ 带 miniaturized 关键字（这是唯一实测稳定的手法）', () => {
    expect(buildMacosMiniaturizeArgs(1).join(' ')).toContain('miniaturized')
  })

  it('★ pid 原样透传，不做四舍五入或补零（unix id 是整数，字符串插值即可）', () => {
    expect(buildMacosMiniaturizeArgs(0)[1]).toContain('unix id is 0)')
    expect(buildMacosMiniaturizeArgs(2147483647)[1]).toContain('unix id is 2147483647)')
  })
})