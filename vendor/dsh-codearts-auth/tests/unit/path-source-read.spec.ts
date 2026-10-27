import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * ★★ **仓库路径含空格时，源码级断言的路径判据必须仍然可读**（Issue IKLBSH A3）。
 *
 * ## 为什么需要这个 spec（它是「假守卫」的补丁）
 *
 * A3 的缺陷是：`new URL('.', import.meta.url).pathname` 对空格做百分号编码
 *（`%20`），而既有代码只 `replace(/^\/([A-Za-z]:)/, '$1')` 修盘符前缀、**不修
 * `%20`** ⇒ 含空格路径下 `readFileSync` 恒 ENOENT，且 vitest 报成
 * **整份 spec 收集失败**（不是单条用例失败）⇒ 看起来像测试基建坏了。
 *
 * 我已把 4 个 spec 的 6 处改成 `fileURLToPath`。但**对抗性审计实测证伪了它的
 * 可验证性**：在本机当前路径（**不含空格**）下，把 6 处全部改回
 * `URL.pathname` ⇒ 那 3 个 spec **98 条全绿**。
 * 即：**修复是真的，但守卫的覆盖度是零** —— 这是一条**结构性**判据，
 * 变异验证在本机测不出来（该结论已记进 `docs/agent-notes/dev-tasks.md`）。
 *
 * ## 本 spec 的做法：不靠变异，**直接构造含空格的路径**
 *
 * 审计员的活体复现（复制整个仓库到含空格目录 + junction `node_modules`）代价太高
 * 且要写几十 MB、还会污染用户磁盘。这里改用**等价的最小判据**：
 *
 * 1. **直接对比两个函数的解码行为**（这是缺陷的本体，与仓库大小无关）；
 * 2. **真实建一个含空格的临时目录**并在其中做一次 `readFileSync`，
 *    证明「按 `fileURLToPath` 得到的路径可读、按 `pathname` 得到的不可读」；
 * 3. **扫源码**：`tests/` 下任何 `import.meta.url).pathname` 的用法都判违规 ——
 *    这是**结构性**断言，在**任意**路径下都能生效（含空格与否都会红），
 *    正好补上「本机路径无空格时变异测不出来」的缺口。
 *
 * ⚠️ 第 3 条是本 spec 的**主要价值**：它把「A3 会不会复发」从
 * 「只有含空格路径的人能发现」变成「所有人都会红」。
 */
describe('★★ 源码级断言的路径判据必须用 fileURLToPath（Issue IKLBSH A3）', () => {
  it('★ 判据本体：URL.pathname 不解码 %20，fileURLToPath 解码（缺陷就是这个差）', () => {
    const url = 'file:///D:/Vibe%20coding/repo/tests/unit/x.spec.ts'
    // 缺陷侧：空格留在编码形态里 —— 拿去 readFileSync 必然 ENOENT。
    expect(new URL('.', url).pathname).toContain('%20')
    // 修复侧：正确解码。
    const decoded = fileURLToPath(new URL('.', url))
    expect(decoded).not.toContain('%20')
    expect(decoded).toContain('Vibe coding')
  })

  it('★★ 活体：含空格的目录里，fileURLToPath 的路径可读、URL.pathname 的不可读', () => {
    const base = mkdtempSync(join(tmpdir(), 'iklbsh-'))
    // 目录名里**带空格**（这是触发条件；不带空格时两者等价，测不出差别）。
    const spaced = join(base, 'a dir with spaces')
    mkdirSync(spaced)
    try {
      const target = join(spaced, 'probe.txt')
      writeFileSync(target, 'ok', 'utf8')
      const fileUrl = pathToFileURL(target).href
      expect(fileUrl, '临时目录名含空格 ⇒ pathToFileURL 应当编码它').toContain('%20')
      // ① fileURLToPath：可读
      expect(readFileSync(fileURLToPath(fileUrl), 'utf8')).toBe('ok')
      // ② URL.pathname（**缺陷侧**）：不可读 —— 这一格是「阳性对照」，
      //    若哪天 Node 改了 pathname 的行为，它会红，提醒我们重新审视整段结论。
      const viaPathname = new URL(fileUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1')
      expect(viaPathname).toContain('%20')
      expect(() => readFileSync(viaPathname, 'utf8')).toThrow()
    } finally {
      // ⚠️ 必须清理：本 spec 会在用户临时目录里 `mkdir`，不清理会越积越多。
      try { rmSync(base, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
    }
  })

  it('★★ 结构性守卫：tests/ 下不得再出现 `import.meta.url).pathname`（任意路径下都会红）', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    // ⚠️ 起点用 `fileURLToPath`（本 spec 自身就是该纪律的示范）。测试目录结构是
    // `tests/unit/<本文件>`，故上一层是 `tests/`。
    const testsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    // ⚠️ **必须排除本文件自己**：它的用例标题与报错文案里**必然**出现那串被禁写法
    //（否则没法把「禁止什么」说清楚）。排除自己是守卫类 spec 的惯例 ——
    // 实测漏了这一步会立刻自伤（本 spec 第一版就是这么红的）。
    const SELF = resolve(fileURLToPath(import.meta.url))
    const files = (await fs.readdir(testsDir, { recursive: true }))
      .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
      .filter((f) => resolve(testsDir, f) !== SELF)
    const offenders = []
    for (const file of files) {
      const source = await fs.readFile(path.join(testsDir, file), 'utf8')
      // 只匹配**用法**（`import.meta.url).pathname`），不匹配注释里讨论它的文字 ——
      // 本仓库注释大量引用被禁止的写法（既有 `codeOf` 先例）。
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      if (/import\.meta\.url\)\.pathname/.test(code)) offenders.push(file)
    }
    expect(
      offenders,
      '这些文件用 URL.pathname 取路径（含空格路径下 readFileSync 恒 ENOENT，且报成整份 spec 收集失败）。改用 fileURLToPath(new URL(".", import.meta.url))',
    ).toEqual([])
    // 反向：确认扫描真的扫到了文件（否则「零违规」是空集假绿）。
    expect(files.length).toBeGreaterThan(100)
  })
})
