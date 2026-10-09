import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 单测隔离：Jet Hub 的文件后端默认落在 `$DSH_HOME/jet-hub/state.json`，
 * 若不在测试环境里改写，用例会污染真实用户的 `~/.dsh`。
 *
 * ⚠️ **但这里的顶层 `mkdtempSync` 只跑一次** —— config 求值时执行，
 * 所有 worker 共享同一个目录，于是并行跑的 spec 会争抢同一个
 * `state.json`，造成偶发假失败（`AccountPool.addAccount` 写入竞态）。
 *
 * 真正的隔离放在 `tests/setup-isolation.ts`（`setupFiles` 对**每个测试
 * 文件**各执行一次，故每个文件独享一个目录）。这里的顶层值仅作
 * **兜底**：万一某个环境没加载 setup 文件，也仍然不会写到 `~/.dsh`。
 */
const fallbackStateDir = mkdtempSync(join(tmpdir(), 'dsh-jet-hub-fallback-'))

/**
 * Qoder 设备身份：**测试里绝不能真的 spawn `runtime-info.exe`**。
 *
 * 那个可执行文件由 Qoder 桌面端分发，单次约 3.8 秒（还有 0.8 秒的暖启动）。
 * 若不禁用：① 整个套件明显变慢；② 用例结果随「开发机是否装了桌面端」而变；
 * ③ 断言会拿到**实时身份**而不是用例准备的 fixture，从而假失败。
 *
 * 指向不存在的路径即等价于「未安装」，代码会退回读 `machine_token.json`
 * （与纯插件登录用户的行为一致），用例因此可精确断言。
 */
const noSuchRuntimeInfo = join(fallbackStateDir, 'no-such-runtime-info')

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    // （PR #64 审查 3 已撤 exclude）：cline-icon / loomy-docs 两个 spec 自带
    // skipIf/existsSync 优雅降级，依赖缺失时「通过 + 跳过」而非失败 ⇒
    // 无需在配置里排除——排除反而把回归价值藏掉了。
    environment: 'node',
    // ⚠️ 必须排在 env 之前生效：它按测试文件重设状态目录（见文件头）。
    setupFiles: ['./tests/setup-isolation.ts'],
    env: {
      DSH_JET_HUB_STATE_DIR: fallbackStateDir,
      QODER_RUNTIME_INFO: noSuchRuntimeInfo,
    },
  },
})
