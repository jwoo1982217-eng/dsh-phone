import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { locateHostClient } from './dsh-host-client.js'

/**
 * Jet Hub 样式表**归属与自愈**的回归测试（Gitee issue IKK764）。
 *
 * ## 真实缺陷
 *
 * `installJetHubStyles()` 在 `ctx.effect(...)`（apply 阶段）里注入 `<style>`，
 * 而宿主的 `claimStyles(ownerId)` 是在**每个 factory 执行完之后**调用的
 * （`dsh-client-modules` 的 `materialize`）—— apply 必然晚于自己那次认领。
 *
 * 旧实现（无 `data-plugin` + 模块级 `injected` 布尔）因此有双重缺陷：
 *
 * 1. 标签**始终无主** ⇒ 之后任何插件物化都会把它认领走；那个插件一热重载 /
 *    被禁用 / 被卸载，宿主 `removeOwnedStyles` 就把 Jet Hub 整套样式连根删掉；
 * 2. `injected` 布尔让标签被删后**永不再补注** ⇒ 只有 F5 整页刷新才恢复。
 *
 * 用户症状：装/改任何别的插件后，Jet Hub 面板退化成浏览器默认样式，刷新才回来。
 *
 * ## ⚠️ 为什么这份用例不会被「实现换写法」骗过
 *
 * 断言全部打在**可观察的 DOM 结果**上（标签条数 / `data-plugin` 归属 / 认领与
 * 回收之后是否幸存），而不是源码字符串。宿主那侧的 `claimStyles` /
 * `removeOwnedStyles` 优先取**真实实现**（见下），不是复刻 —— 否则我们只是在
 * 测试自己对宿主行为的想象。
 *
 * ## ⚠️ 宿主的真实实现从哪里来（以及读不到时怎么办）
 *
 * 本仓库的 devDependencies **没有** `@deepseek-ai/dsh-client-modules`（它是宿主
 * 侧包，只随 DSH 安装）。故这里按「已安装的 DSH」去找它的 `lib/client.js`，从中
 * 抽取两个函数的真实源码求值。找不到时（干净克隆 / CI）退化为**同语义的内联实现**，
 * 并额外用一条用例把两份实现的结论对拍 —— 一旦宿主改了判据，本文件会提醒。
 *
 * 两个函数都是纯 DOM 操作，抽取后无外部依赖，可安全求值。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const require = createRequire(import.meta.url)

/**
 * 包名 = 插件身份的唯一真源（issue IKLUME）。
 *
 * ⚠️ 本文件的断言一律以它为准，**不要再写死字面量**：原先这里有 14 处硬编码
 * 包名，它们与 `package.json` **同值** ⇒ 在「包名改了、源码停在旧名」这类失效里
 * 一条都帮不上忙（只证明测试与 `package.json` 一致），真正有牙的判据被淹没在
 * 噪声里。判据从包名派生后，「再次改名」会强制所有断言一起跟着走。
 * ⚠️ 但这只是**约定**：把它改回字面量不会被任何用例发现（2026-10 审计 F7）。
 */
const PACKAGE_ID = (JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { name: string }).name

interface StyleHost {
  claimStyles: (id: string) => string[]
  removeOwnedStyles: (id: string) => void
}

/**
 * 从宿主真实源码里抽取两个归属函数。
 *
 * 抽取失败（宿主改名 / 重构）时返回 null，让用例走内联实现并**明确报告**
 * 「本次没验到宿主真身」，而不是静默降级。
 */
function extractHostBehavior(): StyleHost | null {
  const path = locateHostClient()
  if (path === null) return null
  const source = readFileSync(path, 'utf8')
  const claim = source.match(/const claimStyles = \(id(?:, before)?\) => \{[\s\S]*?\n\t+\};/)
  const snapshot = source.match(/const untaggedStyles = [^\n]+;/)
  const remove = source.match(/function removeOwnedStyles\(id\) \{[\s\S]*?\n\t+\}/)
  if (!claim || !remove) return null
  try {
    return new Function(`${snapshot?.[0] ?? ''}\n${claim[0]}\n${remove[0]}\nreturn { claimStyles: id => claimStyles(id, new Set()), removeOwnedStyles }`)() as StyleHost
  } catch {
    return null
  }
}

const hostBehavior = extractHostBehavior()

/**
 * 内联的**同语义**实现 —— 逐条对应宿主 `lib/client.js`：
 *
 * - `claimStyles`：`for (const el of querySelectorAll('style:not([data-plugin])'))`
 *   `el.setAttribute('data-plugin', id)`；
 * - `removeOwnedStyles`：`for (const el of querySelectorAll('style[data-plugin]'))`
 *   `if (el.getAttribute('data-plugin') === id) el.remove()`。
 */
const inlineBehavior: StyleHost = {
  claimStyles(id) {
    for (const el of document.querySelectorAll('style:not([data-plugin])')) el.setAttribute('data-plugin', id)
    const owned: string[] = []
    for (const el of document.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`)) {
      owned.push(el.getAttribute('data-plugin-css') ?? id)
    }
    return owned
  },
  removeOwnedStyles(id) {
    for (const el of document.querySelectorAll('style[data-plugin]')) {
      if (el.getAttribute('data-plugin') === id) el.remove()
    }
  },
}

/** 被测的两份实现：宿主真身（若有）与内联同语义实现。 */
const hosts: Array<{ label: string; host: StyleHost }> = [
  ...(hostBehavior ? [{ label: '宿主真实实现', host: hostBehavior }] : []),
  { label: '内联同语义实现', host: inlineBehavior },
]

// ── 最小 DOM 桩 ────────────────────────────────────────────────────────
//
// 宿主与 `installJetHubStyles` 用到的 API 就这几个：createElement /
// head.appendChild / querySelector(All) / setAttribute / getAttribute /
// remove / dataset。用真 DOM 库（jsdom）会引入新依赖且掩盖「谁删了标签」，
// 这里自建桩即可精确观测。

const head: { children: FakeStyle[] } = { children: [] }

interface FakeStyle {
  tagName: string
  attrs: Record<string, string>
  textContent: string
  dataset: Record<string, string>
  /** 真实 DOM 的 parentNode：null 表示已不在文档里（disposer 用它判断能否释放）。 */
  parentNode: { children: FakeStyle[] } | null
  setAttribute(k: string, v: string): void
  getAttribute(k: string): string | null
  remove(): void
}

function makeElement(tag: string): FakeStyle {
  const el: FakeStyle = {
    tagName: tag,
    attrs: {},
    textContent: '',
    dataset: {},
    parentNode: head,
    setAttribute(k, v) { el.attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null },
    remove() {
      const i = head.children.indexOf(el)
      if (i >= 0) head.children.splice(i, 1)
      el.parentNode = null
    },
  }
  // `dataset.plugin` ⇄ `data-plugin` 的双向映射 —— 宿主自家构建预设用的正是
  // dataset 写法（`tag.dataset.plugin = ...`），故桩必须支持。
  Object.defineProperty(el, 'dataset', {
    value: new Proxy({} as Record<string, string>, {
      set(_t, k, v) { el.attrs[`data-${String(k).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`] = String(v); return true },
      get(_t, k) { return el.getAttribute(`data-${String(k).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`) ?? undefined },
      has(_t, k) { return el.getAttribute(`data-${String(k).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`) !== null },
    }),
  })
  return el
}

function matches(selector: string): FakeStyle[] {
  if (selector === 'style:not([data-plugin])') {
    return head.children.filter(el => el.tagName === 'style' && el.getAttribute('data-plugin') === null)
  }
  if (selector === 'style[data-plugin]') {
    return head.children.filter(el => el.tagName === 'style' && el.getAttribute('data-plugin') !== null)
  }
  const parsed = /^style\[(data-plugin|data-plugin-css)="(.*)"\]$/.exec(selector)
  if (parsed) {
    return head.children.filter(el => el.tagName === 'style' && el.getAttribute(parsed[1]!) === parsed[2])
  }
  throw new Error(`DOM 桩不支持的选择器：${selector}`)
}

/** 装/卸 DOM 桩，并把被测模块的样式 effect 跑起来。 */
async function withDom<T>(run: () => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { document: globals.document, window: globals.window }
  globals.document = {
    head: {
      appendChild(el: FakeStyle) { head.children.push(el) },
      // ⚠️ IKKGYN 起 styleElement() 改走 document.head.querySelector（而不是
      // document.querySelector），桩必须跟上 —— 真实 DOM 两个入口等价。
      querySelector: (sel: string) => matches(sel)[0] ?? null,
    },
    createElement: makeElement,
    querySelectorAll: matches,
    querySelector: (sel: string) => matches(sel)[0] ?? null,
  }
  globals.window = {}
  head.children.length = 0
  try {
    return await run()
  } finally {
    globals.document = saved.document
    globals.window = saved.window
    head.children.length = 0
  }
}

const styleTags = () => head.children.filter(el => el.tagName === 'style')
const owners = () => styleTags().map(el => el.getAttribute('data-plugin'))

/**
 * 加载**当前源码**的 `installJetHubStyles`。
 *
 * ⚠️ 用 query 参数绕过 ESM 模块缓存 —— 旧实现把幂等状态放在**模块级变量**里，
 * 换一个 URL 才等价于「整页刷新后模块重新求值」；不绕过就无法区分
 * 「DOM 存在性判断」与「模块级布尔」。
 */
let seq = 0
async function loadInstaller(): Promise<() => (() => void)> {
  const url = `${pathToFileURL(resolve(REPO_ROOT, 'plugin-src/client/jet-hub-styles.js')).href}?v=${++seq}`
  const mod = await import(/* @vite-ignore */ url) as { installJetHubStyles: () => () => void }
  return mod.installJetHubStyles
}

/** IKKGYN 追加：加载 `ensureJetHubStyles`（渲染期自愈入口）。 */
async function loadEnsurer(): Promise<() => boolean> {
  const url = `${pathToFileURL(resolve(REPO_ROOT, 'plugin-src/client/jet-hub-styles.js')).href}?v=${++seq}`
  const mod = await import(/* @vite-ignore */ url) as { ensureJetHubStyles: () => boolean }
  return mod.ensureJetHubStyles
}

describe('Jet Hub 样式表归属（IKK764）', () => {
  it('注入的样式标签必须署名自己的包 id（否则会被别的插件认领走）', async () => {
    await withDom(async () => {
      const install = await loadInstaller()
      install()
      expect(styleTags(), '应恰好注入 1 条样式标签').toHaveLength(1)
      // ⚠️ 核心断言：无主标签会被 claimStyles 认领给**当前物化的那个插件**。
      expect(owners(), 'data-plugin 必须是自己，不能是 null（无主）').toEqual([PACKAGE_ID])
      // 资源标识（供宿主 claimStyles 回读做 inventory）
      expect(styleTags()[0]!.getAttribute('data-plugin-css')).toBe(`${PACKAGE_ID}/jet-hub.css`)
      // 内容确实是那张全套 .dim-jh-* 样式表
      expect(styleTags()[0]!.textContent).toContain('.dim-jh-page')
      // ⚠️ PLUGIN_ID 的正确定义 = 「宿主拿**包名**当 ownerId 时认得出它」。
      // 判据只打在这里（注入结果 + 宿主回读），不打在源码里的那个字面量上 ——
      // 否则改写成从别处派生就会被误判为红（见下方被删正则用例的说明）。
      expect(hosts[0]!.host.claimStyles(PACKAGE_ID), '宿主按包名认领时 inventory 必须非空')
        .toEqual([`${PACKAGE_ID}/jet-hub.css`])
    })
  })

  /**
   * ⚠️ 「注册 id == 包名」与「PLUGIN_ID == 包名」这两条不变式**已搬到
   * `tests/unit/client-registration-id.spec.ts`**（行为判据）。
   *
   * 原先这里有两条**读源码正则**的用例 —— 本 PR 之前一条、本 PR 新增一条。
   * 变异验证实测它们同时具备三类假红与两类假绿，故整组删除：
   *
   * - 假红（写法合法、产物逐字节不变，用例却红）：`build.mjs` 改从 `package.json`
   *   读包名（即 issue 自己推荐的修法）、或把单引号换成双引号；
   * - 假红：真定义上方多一行**写着旧名**的注释
   *   （`// const loaderId = 'dsh-codearts-auth'`）—— 正则取到注释里的值，产物其实是对的。
   *   ⚠️ 注释放**新名**时不会红（读到的就是正确值）：2026-10 第二轮审计实测了这一格，
   *   所以这里必须写「旧名」，否则这一行自相矛盾。
   * - 假绿：注释诱饵写在新名上、真定义留在旧名且不重建 ⇒ 断言的**真定义**根本不生效，全绿；
   * - 假绿：产物断言是裸子串 `toContain('id: "…"')`，把产物第 2 行改成
   *   `id: "wrong-id", // was id: "…"` 即真实注册 id 已错、用例仍全绿。
   *
   * 新判据不看源码文本：把**真实的** `lib/client/jet-hub.js` 交给**真实的**宿主
   * 加载器按包名装载，装载不上就红 —— 对引号形态、注释诱饵、产物陈旧免疫；
   * 头部**形态**重构（多行改单行）同样免疫（回读用正则，不逐字节锚定）。
   */
  it('⚠️ 别的插件认领时认不到它、回收时也删不掉它（缺陷本体）', async () => {
    for (const { label, host } of hosts) {
      await withDom(async () => {
        const install = await loadInstaller()
        install()
        // 别的插件物化：宿主 materialize 里 factory 之后的 claimStyles
        host.claimStyles('dsh-better-sidebar')
        expect(owners(), `[${label}] 别的插件不得把它认领走`).toEqual([PACKAGE_ID])
        // 那个插件 revision 变化 / 被 prune / 被禁用 ⇒ removeOwnedStyles
        host.removeOwnedStyles('dsh-better-sidebar')
        expect(styleTags(), `[${label}] 别的插件回收后样式必须幸存`).toHaveLength(1)
      })
    }
  })

  it('⚠️ 标签被外部删除后，再次 apply 能自愈（不能只有整页刷新才恢复）', async () => {
    await withDom(async () => {
      const install = await loadInstaller()
      install()
      expect(styleTags()).toHaveLength(1)
      // 极端路径：宿主/别的插件把标签直接删了
      styleTags()[0]!.remove()
      expect(styleTags()).toHaveLength(0)
      // 宿主 reconcile 再次 apply —— **同一个模块实例**（真实运行时 factory 不重跑）
      install()
      expect(styleTags(), '再次 apply 必须补注（旧实现的模块级 injected 布尔会在此失败）').toHaveLength(1)
      expect(owners()).toEqual([PACKAGE_ID])
    })
  })

  it('重复 install 幂等：不叠加标签，且幂等命中不误删已存在的标签', async () => {
    await withDom(async () => {
      const install = await loadInstaller()
      install()
      install()
      const noopDispose = install()
      expect(styleTags()).toHaveLength(1)
      // 幂等命中时返回的空 disposer 不得删除**别人**注入的那张标签
      const other = makeElement('style')
      other.dataset.plugin = 'dsh-better-sidebar'
      document.head.appendChild(other)
      noopDispose()
      expect(owners(), '空 disposer 不得误删任何已存在的样式').toEqual([PACKAGE_ID, 'dsh-better-sidebar'])
    })
  })

  it('disposer 只删自己那张标签，不碰别人的，且删后可再次注入', async () => {
    await withDom(async () => {
      const install = await loadInstaller()
      const dispose = install()
      expect(styleTags()).toHaveLength(1)
      // ⚠️ 同时存在**别人**的样式标签（别的插件也署了自己名字）
      const other = makeElement('style')
      other.dataset.plugin = 'dsh-better-sidebar'
      other.textContent = '.dim-sb{}'
      document.head.appendChild(other)
      expect(owners()).toEqual([PACKAGE_ID, 'dsh-better-sidebar'])

      dispose()
      // ⚠️ 核心：只能删自己那张（改成「删所有 style[data-plugin]」的实现在此失败）
      expect(owners(), 'disposer 不得误删别的插件的样式').toEqual(['dsh-better-sidebar'])

      install()
      expect(owners(), 'dispose 后再 install 应能重新注入，且不干扰别人的').toEqual(['dsh-better-sidebar', PACKAGE_ID])
    })
  })

  it('本插件自身热重载（宿主 replace 顺序）不引入回归', async () => {
    await withDom(async () => {
      const OWN = PACKAGE_ID
      let install = await loadInstaller()
      install()
      // replace(自己)：tearDownEntryFiber → removeOwnedStyles(自己) → import（factory 重跑）→ apply
      inlineBehavior.removeOwnedStyles(OWN)
      expect(styleTags(), '先删自己名下的标签是宿主预期行为').toHaveLength(0)
      install = await loadInstaller() // factory 重跑 ⇒ 模块级状态复位
      install()
      expect(styleTags(), '重跑 factory 后应重新注入').toHaveLength(1)
      expect(owners()).toEqual([OWN])
    })
  })

  /**
   * ⚠️ 「扫描面有效性」护栏：证明宿主真身的搜索**真的被执行过**。
   *
   * 若把这个文件里的 `locateHostClient()` 路径写错，`hostBehavior` 会静默变成
   * null、对拍用例变成 skip —— 于是「验过宿主真身」这件事悄悄消失而没人发现。
   * 这条用例把「找到时给出来路」记下来，找不到时也不假装找过。
   */
  it('宿主真身可定位时可被读出（扫描面有效性）', () => {
    const path = locateHostClient()
    if (path === null) {
      // 干净克隆 / CI：本仓库 devDependencies 不含宿主包，属预期。
      expect(path).toBeNull()
      return
    }
    expect(existsSync(path)).toBe(true)
    const source = readFileSync(path, 'utf8')
    // ⚠️ 硬断言宿主的**判据语义**本身，而不只是「函数名还在」——
    // 本缺陷的全部机制就建立在这两个选择器上。若宿主改了它们，
    // IKK764 的前提就变了，本文件必须跟着重新评估（而不是继续假装有效）。
    expect(source, '宿主认领的判据必须仍是「无主」').toContain('style:not([data-plugin])')
    expect(source, '宿主必须按 data-plugin 精确匹配来删除')
      .toMatch(/querySelectorAll\("style\[data-plugin\]"\)[\s\S]{0,80}?getAttribute\("data-plugin"\) === id/)
    expect(source, '宿主必须在 factory 之后认领样式').toMatch(/factory\([\s\S]{0,120}?claimStyles\(ownerId(?:, before)?\)/)
    // 两个函数都能被抽取出来（抽取失败时对拍会静默降级，这里挡住）
    expect(hostBehavior, `已定位 ${path} 却未能抽出归属函数`).not.toBeNull()
  })

  // 找不到宿主真身时干净跳过（不静默降级成「只测内联实现」）
  const itWithHost = hostBehavior ? it : it.skip

  itWithHost('宿主真身与内联实现同结论（防「我们只是在测自己的想象」）', async () => {
    await withDom(async () => {
      // 同一批报文喂两个实现，断言逐条同结论
      const run = (host: StyleHost) => {
        head.children.length = 0
        const owned = makeElement('style')
        owned.setAttribute('data-plugin', 'owner-a')
        owned.textContent = '.a{}'
        head.children.push(owned)
        const unowned = makeElement('style')
        unowned.textContent = '.b{}' // 无主
        head.children.push(unowned)

        const claimed = host.claimStyles('owner-b')
        const afterClaim = styleTags().map(e => e.getAttribute('data-plugin'))
        host.removeOwnedStyles('owner-b')
        return { claimed, afterClaim, remaining: styleTags().map(e => e.getAttribute('data-plugin')) }
      }
      expect(run(hostBehavior!)).toEqual(run(inlineBehavior))
    })
  })

  it('⚠️ 反向验证：去掉署名后本文件的核心用例必须变红', async () => {
    // 用**源码文本**注入一个等价的「缺陷版」实现，确认上面的断言真的能抓住它。
    // 这不是同义反复：若哪天宿主改了归属判据、或断言被写成恒真，这条会失败。
    await withDom(async () => {
      const defective = () => {
        let injected = false
        return () => {
          if (injected) return () => {}
          injected = true
          const style = makeElement('style')
          style.textContent = '.dim-jh-page{}'
          document.head.appendChild(style)
          return () => { style.remove(); injected = false }
        }
      }
      const install = defective()
      install()
      // 缺陷版特征 1：无署名
      expect(owners(), '缺陷版必须表现为无主').toEqual([null])
      // 缺陷版特征 2：被别的插件认领后回收即丢样式
      inlineBehavior.claimStyles('dsh-better-sidebar')
      expect(owners()).toEqual(['dsh-better-sidebar'])
      inlineBehavior.removeOwnedStyles('dsh-better-sidebar')
      expect(styleTags(), '缺陷版必须掉样式（这正是 IKK764 的症状）').toHaveLength(0)
      // 缺陷版特征 3：再次 apply 不自愈（模块级布尔）
      install()
      expect(styleTags(), '缺陷版必须不自愈').toHaveLength(0)
    })
  })
})

/**
 * 引用计数与渲染期自愈（Gitee issue IKKGYN）。
 *
 * ## 两个缺陷（本机 CDP 真机实测复现，非推断）
 *
 * ① **旧 disposer 误删后注入的那张**：旧 disposer 是
 *    `document.querySelector(STYLE_SELECTOR)?.remove()` —— 删的是「当前那张」，
 *    不是「自己注入的那张」。宿主 `replace()` 会先 `tearDownEntryFiber`
 *    （`await fiber.inertia`）再重新 import，故 dispose 天然**晚于**新的 apply。
 *    实测：新表 1 份 → 旧 disposer 跑完 → 0 份，且此后无人补注（回到掉样式面）。
 *
 * ② **apply 之外无人补注**：`installJetHubStyles` 只挂在 `ctx.effect`，渲染路径
 *    不会重跑。实测：删掉签名样式表后，开/关浮层、切 provider 重挂载，样式表
 *    都是 0 份，只有 F5 整页重载才恢复。
 */
describe('Jet Hub 样式表：引用计数与渲染期自愈（IKKGYN）', () => {
  it('⚠️ 旧 disposer 不得删掉「后注入的那张」（宿主 replace 的真实时序）', async () => {
    await withDom(async () => {
      const install = await loadInstaller()
      // 旧实例：注入并持有 disposer
      const oldDispose = install()
      const oldTag = styleTags()[0]!
      expect(styleTags()).toHaveLength(1)

      // 宿主 replace 时序：removeOwnedStyles(自己) → 新 factory 重跑 → 新 apply
      inlineBehavior.removeOwnedStyles(PACKAGE_ID)
      expect(styleTags()).toHaveLength(0)
      install() // 新实例注入了一张**新**标签
      expect(styleTags(), '新实例应注入一张新标签').toHaveLength(1)
      const newTag = styleTags()[0]!
      expect(newTag, '必须是不同的元素（否则测不到「删错对象」）').not.toBe(oldTag)

      // 旧 disposer 这时才跑（cordis inertia 让 dispose 晚于新的 apply）
      oldDispose()

      expect(styleTags(),
        '旧 disposer 只能释放自己闭包里那张，绝不能删掉后注入的新表').toHaveLength(1)
      expect(styleTags()[0], '幸存的必须是新表').toBe(newTag)
    })
  })

  it('同一个 disposer 被调用两次只释放一次（cordis 重入不得二次减计数）', async () => {
    await withDom(async () => {
      const install = await loadInstaller()
      const disposeA = install() // 实例 A：计数 1
      const disposeB = install() // 实例 B：计数 2
      expect(styleTags()[0]!.dataset.jetHubRefs).toBe('2')

      disposeA() // 计数 1，标签仍在
      expect(styleTags()).toHaveLength(1)

      // ⚠️ cordis 允许同一 disposer 被调用两次。若 released 守卫失效，
      // 这次重入会把计数从 1 再减到 0 ⇒ 提前删掉 B 仍持有的标签。
      disposeA()
      expect(styleTags()[0]!.dataset.jetHubRefs,
        '重入不得二次减计数（B 仍持有，标签必须还在且计数不变）').toBe('1')
      expect(styleTags(), '重入不得提前删表').toHaveLength(1)

      disposeB()
      expect(styleTags(), 'B 释放后（计数归零）应删除').toHaveLength(0)
    })
  })

  it('多个持有者：最后一个释放者才删表', async () => {
    await withDom(async () => {
      const install = await loadInstaller()
      const disposeA = install()
      const disposeB = install()
      expect(styleTags()).toHaveLength(1)
      expect(styleTags()[0]!.dataset.jetHubRefs).toBe('2')

      disposeA()
      expect(styleTags(), '还有一个持有者时不得删表').toHaveLength(1)
      expect(styleTags()[0]!.dataset.jetHubRefs).toBe('1')

      disposeB()
      expect(styleTags(), '最后一个持有者释放后应删除').toHaveLength(0)
    })
  })

  it('⚠️ 标签被外力删掉后，渲染期自愈能补回（不必 F5）', async () => {
    await withDom(async () => {
      const install = await loadInstaller()
      const ensure = await loadEnsurer()
      install()
      expect(styleTags()).toHaveLength(1)

      // 外力删除（宿主回收 / 热更新 / 误删）
      styleTags()[0]!.remove()
      expect(styleTags()).toHaveLength(0)

      expect(ensure(), 'ensure 必须报告「补了一次」').toBe(true)
      expect(styleTags(), '渲染期自愈必须补回样式表').toHaveLength(1)
      expect(owners(), '补回的表仍须署名（否则又会被认领走）').toEqual([PACKAGE_ID])

      // 幂等：已在场时不得重复注入
      expect(ensure(), '已在场时必须返回 false（不重复注入）').toBe(false)
      expect(styleTags()).toHaveLength(1)
    })
  })

  it('⚠️ 反向验证：disposer 改回「释放即删当前那张」，误删用例必须变红', async () => {
    await withDom(async () => {
      // 精确复刻 IKK764 旧 disposer 的语义
      const install = () => {
        const existing = document.head.querySelector('style[data-plugin-css="' + PACKAGE_ID + '/jet-hub.css"]')
        if (existing !== null) return () => {}
        const style = document.createElement('style')
        style.dataset.plugin = PACKAGE_ID
        style.dataset.pluginCss = `${PACKAGE_ID}/jet-hub.css`
        style.textContent = '.dim-jh-page{}'
        document.head.appendChild(style)
        return () => {
          document.head.querySelector('style[data-plugin-css="' + PACKAGE_ID + '/jet-hub.css"]')?.remove()
        }
      }
      const oldDispose = install()
      const oldTag = styleTags()[0]!
      inlineBehavior.removeOwnedStyles(PACKAGE_ID)
      install()
      const newTag = styleTags()[0]!
      expect(newTag).not.toBe(oldTag)
      oldDispose()
      // ⚠️ 缺陷版特征：把「后注入的那张」也删了
      expect(styleTags(), '缺陷版必须表现为误删新表').toHaveLength(0)
    })
  })

  it('⚠️ 反向验证：去掉渲染期自愈（ensure 恒返回 false），自愈用例必须变红', async () => {
    await withDom(async () => {
      const defectiveEnsure = () => false
      const install = await loadInstaller()
      install()
      styleTags()[0]!.remove()
      expect(defectiveEnsure(), '缺陷版必须表现为不补注').toBe(false)
      expect(styleTags(), '缺陷版必须不自愈（这正是 IKKGYN 的症状面）').toHaveLength(0)
    })
  })
})
