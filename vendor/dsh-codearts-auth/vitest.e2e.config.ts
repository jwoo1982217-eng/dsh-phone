import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    environment: 'node',
    // 每个真实登录用例 240 秒：为人工完成门户
    // 授权留有充裕时间，同时适配整个运行 300 秒的 bash 超时。
    testTimeout: 240_000,
    env: {
      /**
       * ⚠️⚠️ **e2e 必须把自己与「单测」区分开，否则真开窗的 e2e 永远不会通过**
       * （2026-10-16，IKM741 期间实测到的**既有结构性缺陷**）。
       *
       * Vitest **默认**把 `NODE_ENV` 设成 `'test'`（对 e2e config 也一样，已实测
       * 打印确认）。而 `src/login.ts` 的 `openIncognitoWindow` 开头有一个
       * **安全断路器**：`if (process.env.NODE_ENV === 'test') return false`
       * —— 它是 2026-10-13 为「单测真弹用户桌面窗口」那次真实污染加的
       * （见 `tests/unit/officeace-incognito-login.spec.ts` 的 ⑩）。
       *
       * ⇒ 两个正确的东西叠在一起产生了一个**静默失效**：
       * `officeace-incognito-login.e2e.spec.ts` 断言 `openIncognitoWindow(...) === true`
       * 并要人工确认登录页，但它在 `NODE_ENV=test` 下**恒拿到 `false`** ⇒
       * 那条 e2e **从写下的那天起就不可能通过**（实测：该用例与它的对照用例
       * 各跑一次，无痕那条恒红、`openBrowser` 那条恒绿 —— 后者没有断路器）。
       *
       * ⇒ 修法是**配置层**把 e2e 标成 `'e2e'`：断路器的判据（「按运行环境一刀切断，
       * **不按 URL 特征打补丁**」）**逐字保留**，只是给「e2e 是另一种运行环境」
       * 这个既有事实一个名字。副作用是单测侧的保护**完全不变**
       * （`vitest.config.ts` 不设本变量 ⇒ 仍是 `'test'`）。
       */
      NODE_ENV: 'e2e',
    },
  },
})
