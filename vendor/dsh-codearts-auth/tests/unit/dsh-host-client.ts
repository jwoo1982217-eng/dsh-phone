import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

/**
 * 定位宿主 `@deepseek-ai/dsh-client-modules/lib/client.js` 的**唯一实现**。
 *
 * ⚠️ 本仓库的 devDependencies **没有**这个包（它是宿主侧包，只随 DSH 安装），
 * 所以任何「拿宿主真身当判据」的测试都要先找它。历史上这段搜索在
 * `jet-hub-styles-ownership.spec.ts` 与 `client-registration-id.spec.ts` 各有一份
 * —— 本仓库明令禁止「一文件两套同义判据」（PR !62），故收敛到这里。
 *
 * 搜索顺序（命中即返回）：
 * ⓿ `DSH_HOST_CLIENT` 环境变量给出的**绝对路径** —— 给 CI / 干净克隆用的强制口：
 *    它是「我就是要验真身」的显式声明，所以路径不存在时**抛错**而不是回退，
 *    否则会退化成「以为验了、其实跳过了」。其余各级是尽力而为。
 * ① 本仓库的依赖树（`require.resolve`）—— DSH 被装成依赖时的常规路径；
 * ② **运行本测试的那个 node 的全局 `node_modules`**（`dirname(process.execPath)/node_modules`）
 *    —— DSH 以 `npm i -g @deepseek-ai/dsh` 安装时它是 `@deepseek-ai/dsh` 的嵌套依赖；
 * ③ 用户 profile 里随 DSH 装进来的那一份。
 *
 * ⚠️ **不要**把它写成静态 import —— 依赖不存在时会在收集阶段变成 Failed Suite
 * （`cline-icon.spec.ts` 的文件头记过这个教训）。找不到时返回 `null`，
 * 由调用方**明确报告「本次没验到真身」**，而不是静默降级
 * （2026-10 审计 F6：整组静默 skip 的同时 `vitest` 仍 exit 0，等于把「绿」当成了「验过」）。
 *
 * ⚠️ 已知未实测项：①优先于②、②优先于③ 的**排序**只有源码可读，本机全盘只有一份
 * 宿主副本（第 ① 级恒 `MODULE_NOT_FOUND`、第 ③ 级不存在），故不会命中错副本；
 * 但换一台同时装了多个 DSH 的机器时，这里可能拿到与运行时不同版本的那一份。
 */
export const NESTED_HOST_CLIENT = 'node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'

export function locateHostClient(): string | null {
  // ⓿ 显式指定（CI 用）：不给回退，找不到就直接失败 —— 这是「必须验真身」的承诺。
  const explicit = process.env.DSH_HOST_CLIENT
  if (explicit !== undefined && explicit.trim() !== '') {
    const candidate = resolve(explicit.trim())
    if (!existsSync(candidate)) {
      throw new Error(`DSH_HOST_CLIENT 指向的文件不存在：${candidate}`)
    }
    return candidate
  }
  const require = createRequire(import.meta.url)
  const candidates: string[] = []
  // ① 本仓库依赖树
  for (const spec of ['@deepseek-ai/dsh-client-modules/package.json', '@deepseek-ai/dsh/package.json']) {
    try {
      const pkg = require.resolve(spec)
      candidates.push(resolve(dirname(pkg), 'lib/client.js'))
      candidates.push(resolve(dirname(pkg), NESTED_HOST_CLIENT))
    } catch {
      // 未安装，继续找别的位置
    }
  }
  // ② 全局安装（DSH 的常见形态：npm i -g @deepseek-ai/dsh）
  const globalRoot = resolve(dirname(process.execPath), 'node_modules')
  candidates.push(resolve(globalRoot, '@deepseek-ai/dsh-client-modules/lib/client.js'))
  candidates.push(resolve(globalRoot, '@deepseek-ai/dsh', NESTED_HOST_CLIENT))
  // ③ 用户 profile（本插件实际运行时的邻居）
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (home) {
    const dshHome = process.env.DSH_HOME ?? resolve(home, '.dsh')
    for (const profile of ['web', 'desktop', 'tui', 'headless', 'default']) {
      candidates.push(resolve(dshHome, `profiles/${profile}/${NESTED_HOST_CLIENT}`))
    }
  }
  return candidates.find(p => existsSync(p)) ?? null
}