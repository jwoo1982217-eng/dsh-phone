import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  IDENTITY_FILES,
  assertRegistrationIdFromFiles,
  checkRegistrationId,
  declaredValue,
  readRegisteredId,
} from '../../plugin-src/client/registration-id-check.mjs'
import { locateHostClient } from './dsh-host-client.js'

/**
 * 「客户端注册 id == 宿主包名」的**行为**守卫（Gitee issue IKLUME）。
 *
 * ## 真实缺陷
 *
 * 上游把包名从 `dsh-codearts-auth` 改成 `dsh-providers-hub`（0.2.0-rc.11）时，
 * `plugin-src/client/build.mjs` 的 `loaderId` 与 `jet-hub-styles.js` 的 `PLUGIN_ID`
 * **一起**留在了旧名上。宿主那侧从来没有变：它按**加载行名解析出的包名**建 client entry
 * （`dsh-client-modules` 的 `resolveSource()` → `reconcilePackage(packageName, …)`
 *  → `compose()` 的 `entry.id`），于是前端产物注册 `dsh-codearts-auth`、
 * 宿主等 `dsh-providers-hub` ⇒ 该 entry 永远 import 不到，启动即
 * `N entry did not activate`，桌面端落进恢复模式并把插件自动禁用。
 *
 * ## ⚠️ 为什么判据不看源码文本
 *
 * 上一版守卫用正则读 `build.mjs` / `jet-hub-styles.js` 里的字面量，再断言它等于包名。
 * 变异验证实测它同时具备三类假红与两类假绿：
 *
 * | 形态 | 变异 | 结果 |
 * |---|---|---|
 * | 假红 | `build.mjs` 改从 `package.json` 读包名（issue 自己推荐的修法） | 红 |
 * | 假红 | `const loaderId = "dsh-providers-hub"`（改双引号，行为等价） | 红 |
 * | 假红 | 真定义上方多一行**写着旧名的**注释（产物其实是对的） | 红 |
 * | 假绿 | 注释写新名、真定义写旧名、且不重建 ⇒ 断言的**真定义**根本不生效 | **全绿** |
 * | 假绿 | 只动产物：`id: "wrong-id", // was id: "dsh-providers-hub"` | **全绿** |
 *
 * ⚠️ 第三行原先写作「注释里写**新名**也红」—— **那是错的**（2026-10 第二轮
 * 对抗审计实测：旧正则 `/const loaderId = '([^']+)'/` 取**首个**匹配，注释放新名时
 * 读到的就是新名，照常绿）。写成旧名才会红，且那时是「产物对、断言红」的假红。
 *
 * 本文件把身份判据换成**端到端装载**：拿**真实的** `lib/client/jet-hub.js` 字节，
 * 交给**真实的**宿主加载器按包名装载。它对引号形态、注释诱饵、产物陈旧免疫；
 * 对头部**形态重构**（单行/多行）也免疫 —— 因为回读用的是
 * `readRegisteredId()` 的正则而不是逐字节锚定（审计 S6 曾让逐字节版假红 2 条）。
 *
 * ## ⚠️ 宿主真身读不到时怎么办
 *
 * 本仓库 devDependencies **不含** `@deepseek-ai/dsh-client-modules`（它是宿主侧包，
 * 只随 DSH 安装）。找不到时那**两条**需要宿主的用例整组 skip，并在控制台**显式告警**
 * ——绝不静默降级成「自己复刻一份宿主逻辑」，那是拿对宿主行为的想象当判据。
 * 不需要宿主的断言（产物 id 回读、闸门本体）**刻意留在 skip 组之外**，
 * 使干净克隆/CI 上仍有一部分真的在验（审计 F6：原先整组 7 条一起消失，`vitest` 仍 exit 0）。
 * 需要强制验真身时用 `DSH_HOST_CLIENT=<绝对路径>` 显式指定。
 *
 * 同侧的**安装期**闸门在 `plugin-src/client/build.mjs`（`pnpm add git+…` 走
 * `prepare → build:all`，**不跑 vitest**，故测试守卫在安装路径上不生效）——
 * 它的判据与本文件的第 8、9 节**共用同一个模块**，不再各写一份。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')

/** ⚠️ 权威来源是包名；本文件**刻意**不写死包名（但从 `package.json` 派生这件事本身没有守卫，见文件末注）。 */
const MANIFEST = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  name?: unknown
  dsh?: { client?: { inject?: unknown } }
}
const PACKAGE_ID = MANIFEST.name
if (typeof PACKAGE_ID !== 'string' || PACKAGE_ID.length === 0) {
  throw new Error('package.json 缺少 name —— 无法确定客户端注册 id')
}

const BUNDLE_PATH = resolve(REPO_ROOT, 'lib/client/jet-hub.js')
const STYLES_PATH = resolve(REPO_ROOT, IDENTITY_FILES.styles)
const PATCH_PATH = resolve(REPO_ROOT, IDENTITY_FILES.patch)
const BUILD_PATH = resolve(REPO_ROOT, 'plugin-src/client/build.mjs')

const HOST_CLIENT = locateHostClient()
if (HOST_CLIENT === null) {
  console.warn(
    '[client-registration-id] ⚠️ 未找到宿主 @deepseek-ai/dsh-client-modules/lib/client.js'
    + ' —— 本文件需要宿主真身的两条用例会整组跳过（其余断言照常执行）。'
    + '本次**没有**验证「真实产物能被真实加载器按包名装载」。'
    + '要强制验真身，请设 DSH_HOST_CLIENT=<该文件的绝对路径>。',
  )
}

interface Registration {
  id: string
  factory: (req: (spec: string) => unknown) => unknown
}

interface ClientModuleSystem {
  prefetch: (id: string) => Promise<void>
  importError: (id: string) => unknown
}

/**
 * 执行宿主的浏览器 bundle（它的首行就是 `window.__ModuleLoader__.load({ id, factory })`），
 * 取出它**自己注册的** `createClientModuleSystem` —— 用的是宿主真身，不是复刻。
 */
function loadHostApi(): { createClientModuleSystem: (...args: unknown[]) => ClientModuleSystem } {
  const path = HOST_CLIENT!
  const source = readFileSync(path, 'utf8')
  let captured: Registration | undefined
  new Function('window', source)({ __ModuleLoader__: { load: (r: Registration) => { captured = r } } })
  if (captured === undefined) throw new Error('宿主 bundle 没有注册自己（加载器包装形态变了？）')
  const hostRequire = createRequire(pathToFileURL(path).href)
  return captured.factory((spec: string) => hostRequire(spec)) as {
    createClientModuleSystem: (...args: unknown[]) => ClientModuleSystem
  }
}

/**
 * 造一个只含「本插件一行」的 boot 图，并按宿主的方式装载给定的产物文本。
 *
 * `loadBundle` 是宿主注入的「把 URL 变成已注册 factory」的传输层；这里用
 * **直接执行产物文本**替代网络 —— 产物在模块顶层只会调 `__ModuleLoader__.load(...)`，
 * 它的 `factory` 此刻并不执行，因此不需要 `react` 等外部依赖在场。
 */
function loadBundleIntoHost(bundleText: string): { system: ClientModuleSystem; executed: () => number } {
  const injected = MANIFEST.dsh?.client?.inject
  const inject = Array.isArray(injected) ? injected.filter((x): x is string => typeof x === 'string') : []
  const boot = {
    rev: 'rev-1',
    entries: [{
      id: PACKAGE_ID,
      url: `/plugins/${PACKAGE_ID}/client.js?rev=rev-1`,
      rev: 'rev-1',
      inject,
      external: [],
    }],
    batches: [{ phase: 'application', url: '/batch.js?rev=rev-1', rev: 'rev-1', entries: [PACKAGE_ID] }],
  }
  // 宿主 boot 桥：mode 为 queue 时收进队列，接管后转 live。
  const target: { mode: string; pendingQueue: Registration[]; load: (r: Registration) => void } = {
    mode: 'queue',
    pendingQueue: [],
    load: (r) => { target.pendingQueue.push(r) },
  }
  let executed = 0
  const system = loadHostApi().createClientModuleSystem(
    target,
    { id: '@deepseek-ai/dsh-client-modules/client', exports: {} },
    {
      boot,
      staticModules: {},
      loadBundle: async () => {
        executed += 1
        new Function('window', bundleText)({ __ModuleLoader__: target })
      },
    },
  )
  return { system, executed: () => executed }
}

// ─────────────────────────────────────────────────────────────────────────────
// 不需要宿主真身的断言（干净克隆 / CI 上仍然在验）
// ─────────────────────────────────────────────────────────────────────────────

describe('产物注册 id（不需要宿主真身）', () => {
  it('⚠️ 产物必须是「已构建的那一份」—— 从最终文本回读的注册 id 等于包名', () => {
    const bundleText = readFileSync(BUNDLE_PATH, 'utf8')
    // ⚠️ 这里**刻意**不锚定头部的逐字节形态（两行？缩进几个空格？）：
    // 那种断言会把行为等价的写法重构判成红（审计 S6 实测 2 条假红），
    // 而它想拦的「注释诱饵」「产物陈旧」由下面这条正则的回读天然覆盖 ——
    // 注释里的 `id: "…"` 不构成 `__ModuleLoader__.load({` 这处调用。
    expect(
      readRegisteredId(bundleText),
      '产物里 `__ModuleLoader__.load({ id: … })` 注册的 id 必须就是包名（否则宿主永远 import 不到）',
    ).toBe(JSON.stringify(PACKAGE_ID))
  })

  it('⚠️ 接线：build.mjs 必须顶层无条件调用安装期闸门（没有分支可以短路）', () => {
    const source = readFileSync(BUILD_PATH, 'utf8')
    expect(source, 'build.mjs 必须 import 共享判据（不得自己再写一份）')
      .toContain("from './registration-id-check.mjs'")
    // 行首顶格 ⇒ 它必须是顶层语句，不可能被包在 `if (…)` 里（审计 F3 的变异
    // 正是把闸门条件改成 `if (false)`，当时 21/21 全绿）。
    expect(source, 'build.mjs 必须顶层无条件调用 assertRegistrationIdFromFiles')
      .toMatch(/^assertRegistrationIdFromFiles\(\{ rootDir: packageRoot \}\);$/m)
    // 防回退：那句 `wrapped.startsWith(header)` 是恒真式，等于什么都没查（审计 F1）。
    // ⚠️ 判据必须**先剥掉注释行**：下面这段说明里恰好逐字提到了那个表达式，
    // 不剥注释就会让本条断言被自己的注释判红 —— 活的「注释诱饵」示例
    //（本文件头上那句「一条注释就能让源码正则守卫恒绿」说的就是这件事）。
    const codeLines = source.split(/\r?\n/).filter(line => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    expect(codeLines.join('\n'), '不得再引入恒真的产物自检').not.toContain('startsWith(header)')
  })

  /**
   * ⚠️ 这一组是**判据本体的反向验证**：闸门与它读的文件都在，但判据本身要是坏的
   * （读错变量、正则失效、把合法写法判红），安装路径上就只剩一个假的安心感。
   * 用临时目录构造最小仓库，不碰真实工作区。
   */
  describe('安装期闸门本体（build.mjs 与单测共用的那一份判据）', () => {
    const created: string[] = []
    afterAll(() => {
      for (const dir of created) rmSync(dir, { recursive: true, force: true })
    })

    function fixture(options: {
      name: string
      pluginId?: string
      patchName?: string
      patchSuffix?: string
      literalOwner?: boolean
    }): string {
      const root = mkdtempSync(resolve(tmpdir(), 'iklume-identity-'))
      created.push(root)
      const stylesPath = resolve(root, IDENTITY_FILES.styles)
      mkdirSync(dirname(stylesPath), { recursive: true })
      writeFileSync(resolve(root, IDENTITY_FILES.manifest), JSON.stringify({ name: options.name }), 'utf8')
      const owner = options.literalOwner === true
        ? `style.dataset.plugin = '${options.pluginId ?? options.name}'`
        : 'style.dataset.plugin = PLUGIN_ID'
      writeFileSync(stylesPath, `const PLUGIN_ID = '${options.pluginId ?? options.name}'\n${owner}\n`, 'utf8')
      writeFileSync(
        resolve(root, IDENTITY_FILES.patch),
        `- insert:\n    - id: codearts-auth\n      name: '${options.patchName ?? options.name}'${options.patchSuffix ?? ''}\n`,
        'utf8',
      )
      return root
    }

    it('三处一致的最小仓库必须通过（否则闸门会误伤正常构建）', () => {
      expect(() => assertRegistrationIdFromFiles({ rootDir: fixture({ name: 'dsh-example' }) })).not.toThrow()
    })

    it('⚠️ 合法 YAML 的行尾注释不得判红（审计 F4：真实 yaml 解析器读到的值是对的）', () => {
      const root = fixture({ name: 'dsh-example', patchSuffix: ' # 加载行' })
      expect(() => assertRegistrationIdFromFiles({ rootDir: root })).not.toThrow()
    })

    it('包名换了而另外两处没跟（改名漏改）必须以 issue 原文报错', () => {
      const root = fixture({ name: 'dsh-renamed-again' })
      writeFileSync(resolve(root, IDENTITY_FILES.manifest), JSON.stringify({ name: 'dsh-renamed-again' }), 'utf8')
      writeFileSync(
        resolve(root, IDENTITY_FILES.styles),
        "const PLUGIN_ID = 'dsh-example'\nstyle.dataset.plugin = PLUGIN_ID\n",
        'utf8',
      )
      writeFileSync(
        resolve(root, IDENTITY_FILES.patch),
        "- insert:\n    - id: codearts-auth\n      name: 'dsh-example'\n",
        'utf8',
      )
      expect(() => assertRegistrationIdFromFiles({ rootDir: root }))
        .toThrow(/客户端注册 id 自检失败（issue IKLUME）/)
    })

    it('⚠️ 声明对、但署名使用点写死字面量 —— 闸门必须拦（审计 F2 原先完全看不见）', () => {
      const problems = checkRegistrationId({
        loaderId: 'dsh-example',
        stylesSource: "const PLUGIN_ID = 'dsh-example'\nstyle.dataset.plugin = 'dsh-codearts-auth'\n",
        patchSource: "- insert:\n    - id: codearts-auth\n      name: 'dsh-example'\n",
      })
      expect(problems, '声明正确不代表署名正确').toHaveLength(1)
      expect(problems[0]).toContain('署名必须用 PLUGIN_ID 变量')
    })

    it('包名首尾带空白时，必须指出真因是 package.json（审计 F9：原先两条都在指责另外两处）', () => {
      const problems = checkRegistrationId({
        loaderId: 'dsh-example ',
        stylesSource: "const PLUGIN_ID = 'dsh-example'\nstyle.dataset.plugin = PLUGIN_ID\n",
        patchSource: "- insert:\n    - id: codearts-auth\n      name: 'dsh-example'\n",
      })
      expect(problems[0], '第一条必须是「包名带空白」。').toContain('首尾带空白')
    })

    it('cordis.patch.yml 里没有加载行时必须 fail-closed', () => {
      const problems = checkRegistrationId({
        loaderId: 'dsh-example',
        stylesSource: "const PLUGIN_ID = 'dsh-example'\nstyle.dataset.plugin = PLUGIN_ID\n",
        patchSource: '- insert:\n    - id: codearts-auth\n',
      })
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('没有找到**可识别的**加载行 name:')
    })
  })

  /**
   * ⚠️ `cordis.patch.yml` 的 `name:` 是宿主解析包名的**输入**：宿主把 patch 行挂到
   * profile 目录这个解析基准上（`dsh-app-boot` 的 `prepareProfilePatches(…,
   * pathToFileURL(dirname(absoluteConfigPath))…)`），行名解析不到就**导入失败**，
   * 记 `N entry did not activate`、桌面端把插件自动禁用 —— 而 profile 里只有旧名时
   * 恰恰解析不到（实测 `require.resolve('dsh-providers-hub/package.json')` →
   * `MODULE_NOT_FOUND`）。改名前它**零守卫**（`git grep cordis.patch.yml tests/` = 0）。
   *
   * 本条与安装期闸门**共用同一份判据**：原先两边各写一份正则、语义还不一样
   * （闸门要求「每一处都等于包名」、这里要求「恰好一处」），审计实测已给出相反结论。
   */
  it('⚠️ 真实仓库必须完整通过安装期闸门（三处身份载体一致）', () => {
    const problems = checkRegistrationId({
      loaderId: PACKAGE_ID,
      stylesSource: readFileSync(STYLES_PATH, 'utf8'),
      patchSource: readFileSync(PATCH_PATH, 'utf8'),
    })
    expect(problems, '不一致时 `pnpm add git+…` 会在 prepare 阶段直接失败').toEqual([])
  })

  /**
   * ⚠️ 这是一条**设计决策**的守卫，不是身份判据 —— 身份判据在行为装载那一组。
   *
   * 为什么 `jet-hub-styles.js` 里还留着一个 `PLUGIN_ID` 字面量，而不是也从
   * `package.json` 派生：那个文件是被 esbuild 打包的**浏览器模块**，运行期读不到
   * `package.json`（`import.meta` 在 CJS 产物里也不可用）。彻底消除它需要构建期注入
   * （esbuild `define`），本轮**刻意不做** —— 代价是本条与闸门会一起把「改成派生写法」
   * 判红，收益是「安装路径上也拦得住」这件事有据可查。
   *
   * 判据用**共享实现** `declaredValue()`（闸门读的是同一个函数），不在这里再写第二份正则。
   */
  it('jet-hub-styles.js 的 PLUGIN_ID 是行首字面量声明，且等于包名（安装期闸门的前提）', () => {
    const declared = declaredValue(readFileSync(STYLES_PATH, 'utf8'), 'PLUGIN_ID')
    expect(declared, 'PLUGIN_ID 必须仍是行首字面量声明，否则安装期闸门失效').toBe(PACKAGE_ID)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 需要宿主真身的断言（找不到宿主时整组跳过，并在控制台告警）
// ─────────────────────────────────────────────────────────────────────────────

const describeHost = HOST_CLIENT === null ? describe.skip : describe

describeHost('客户端注册 id 必须等于包名（IKLUME，宿主真身端到端）', () => {
  it('扫描面有效性：读到了宿主真身', () => {
    expect(HOST_CLIENT, '未定位到宿主 @deepseek-ai/dsh-client-modules —— 本组用例已整组跳过，本次没有验到真身')
      .not.toBeNull()
    const source = readFileSync(HOST_CLIENT!, 'utf8')
    // ⚠️ 本缺陷的全部机制就建立在这条链上：加载行名 → 包名 → entry id。
    // 宿主若改了它，IKLUME 的前提就变了，本文件必须跟着重新评估，而不是继续假装有效。
    expect(source, '宿主必须按 registration.id 求 ownerId').toContain('const ownerId = stripClientSuffix(registration.id)')
    expect(source, '宿主必须按「bundle 未按该 id 注册」报错')
      .toMatch(/loaded without registering "\$\{id\}" via __ModuleLoader__\.load/)
  })

  it('⚠️ 真实产物交给真实宿主加载器，必须能按**包名**装载', async () => {
    const bundleText = readFileSync(BUNDLE_PATH, 'utf8')
    const { system, executed } = loadBundleIntoHost(bundleText)
    await expect(system.prefetch(PACKAGE_ID)).resolves.toBeUndefined()
    expect(executed(), '宿主应真的去拉了那一份 bundle（否则是空跑）').toBe(1)
    expect(system.importError(PACKAGE_ID), '装载成功后不得留下 importError 记录').toBeUndefined()
  })

  it('⚠️ 反向验证（证明上一条有牙）：注册 id 换成别的名字必须以 issue 原文报错', async () => {
    const bundleText = readFileSync(BUNDLE_PATH, 'utf8')
    // ⚠️ 用共享的 `readRegisteredId()` 定位那一处注册，**不锚定**头部逐字节形态
    // （审计 S6：多行改单行会让逐字节版假红，而行为其实等价）。
    const tampered = bundleText.replace(
      /(window\.__ModuleLoader__\.load\(\{\s*id:\s*)"(?:[^"\\]|\\.)*"/,
      '$1"definitely-not-the-package-name"',
    )
    expect(tampered, '反向验证必须真的改到了产物里的那处注册，否则下面测的还是原件').not.toBe(bundleText)
    const { system } = loadBundleIntoHost(tampered)
    const message = await system.prefetch(PACKAGE_ID).then(
      () => '(没有报错 —— 说明上一条用例是恒真的)',
      (error: Error) => error.message,
    )
    expect(message).toContain(`could not load "${PACKAGE_ID}"`)
    expect(message).toContain(`loaded without registering "${PACKAGE_ID}" via __ModuleLoader__.load`)
    expect(message).toContain('duplicate factory registration for "definitely-not-the-package-name"')
  })
})

/**
 * ⚠️ 本文件末尾没有「断言自己不含包名字面量」的守卫：那种写法只能读自己的源码文本，
 * 既脆弱又可绕过。`PACKAGE_ID` 从 `package.json` 派生这件事**没有守卫** ——
 * 后来者把它改回字面量不会被任何用例发现。**不要手改这一行**。
 */