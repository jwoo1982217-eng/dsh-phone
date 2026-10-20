import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 多账号续期调度的**接线**回归（Gitee issue !IKIRTT）。
 *
 * `src/expiry-sync.spec.ts` 测的是共享实现的语义；本文件锁的是「九个 provider
 * 是不是**都真的接上了**」—— 这正是该缺陷的形态：raccoon 接好了，其余七个
 * 各漏一环，于是「点刷新没反应」只出现在部分面板。逐条源码级断言是这里
 * 最划算的防线：新增 provider 时漏接会**立刻**变红，而不是等用户报障。
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '../..')
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

/** 剥掉注释：接线断言不该因为「注释里提到了某个符号」而通过。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const indexSource = codeOnly(read('src/index.ts'))
const rpcSource = codeOnly(read('src/jet-hub-rpc.ts'))

/** 十个 auth 文件（`buddy-auth.ts` 一份实现同时服务 buddy 与 workbuddy）。 */
const AUTH_FILES = [
  'src/service.ts',
  'src/buddy-auth.ts',
  'src/lobsterai-auth.ts',
  'src/qoder-auth.ts',
  'src/trae-auth.ts',
  'src/cline-auth.ts',
  'src/loomy-auth.ts',
  'src/raccoon-auth.ts',
  // ⚠️ MiniMax 是第 9 个 auth 文件（buddy-auth 一份服务两个 provider）。
  // 加它之前本清单**漏了 minimax** —— 于是「续期必须带 pool/accountId 且调
  // `syncAccountExpiry`」这条契约对 minimax **不被强制**（Spec 盲区）。
  // 该契约正是「续期成功但界面没反应」那个缺陷的回归防线，
  // 新增 provider 时必须同步加进来。
  'src/minimax-auth.ts',
]

/** 取出某个方法从签名到结束花括号的整段（CRLF 安全）。 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start, `源码里找不到 ${signature}`).toBeGreaterThan(-1)
  const end = source.slice(start).search(/\r?\n  \}\r?\n/)
  return end === -1 ? source.slice(start) : source.slice(start, start + end)
}

describe('续期调度器：启动必须先跑一轮', () => {
  /**
   * ⚠️ 主缺陷（issue !IKIRTT 第三节）：早先这里**只有** `setInterval`，
   * 第一次处理要等满一个周期。cline（1 小时）/ codearts（约 2 小时）/
   * raccoon（3 小时）的凭据在宿主关闭期间早已到期，于是重启后
   * **最长 30 分钟**一直显示「已过期」、积分行一直 401。
   *
   * ⚠️ issue IKJOZB 之后本条改判在 `MultiAccountRefreshScheduler.start()` 上：那段逻辑
   * 已从 `src/index.ts` 抽成可单测的类（行为用例见
   * `tests/unit/refresh-scheduler.spec.ts`），本文件保留的是**接线**断言 ——
   * 「index.ts 确实用了那个类，且把首轮与定时器都交付给它」。
   */
  it('index.ts 把续期交给 MultiAccountRefreshScheduler，而不是自己写 setInterval', () => {
    expect(indexSource, 'index.ts 未使用 MultiAccountRefreshScheduler')
      .toContain('new MultiAccountRefreshScheduler(')
    expect(indexSource, 'index.ts 仍在自己挂 setInterval（缺陷形态会随之回来）')
      .not.toMatch(/setInterval\(\s*\(\)\s*=>\s*void refreshAllCredentials/)
    // 首轮不再由 index.ts 手写：`start()` 内部保证「先跑一轮」。
    // ⚠️ 这里是**变量名**（`const refreshScheduler = new …`），不是类名。
    expect(indexSource).toMatch(/refreshScheduler\.start\(\)/)
  })

  it('启动判据既不看 `enabled`，也不看 `refreshable`（被误标的布尔不能决定调度器是否武装）', () => {
    // 2026-10-02 修订：原先这里是 `accounts.some(a => a.refreshable)`。
    // 本次事故实测 36 条账号只剩 3 条 `true`（raccoon / minimax / cline 各一）——
    // 再少三条，整个续期调度器（含 codearts 的自愈与启动首轮）就**永不武装**，
    // 而且日志里一个字都不会有。「用可能被误标的字段决定要不要修误标」是循环依赖。
    //
    // ⚠️ issue IKJOZB 修订：这里**不再断言** `accounts.length === 0`。
    // 那条断言当初是为了锁住「判据放宽」，顺带把「空池就 return」这个**错误形态**
    // 一起固化了下来 —— 而它正是 IKJOZB 的根因。现在空池判据只喂给
    // `isPoolEmpty`（仅影响日志措辞），武装本身与池内容**彻底解耦**。
    const gate = indexSource.slice(
      indexSource.indexOf('new MultiAccountRefreshScheduler('),
      indexSource.indexOf('refreshScheduler.start()'),
    )
    expect(gate).not.toMatch(/\.refreshable/)
    expect(gate).not.toMatch(/enabled/)
    expect(gate, '武装不得再依赖「启动瞬间池为空」这个条件').not.toMatch(
      /if\s*\(\s*accounts\.length\s*===\s*0\s*\)/,
    )
    expect(gate, 'isPoolEmpty 必须仍然接上（空池要有可观测日志）').toContain('isPoolEmpty')
  })

  it('账号入库时补武装（issue IKJOZB 点名缺失的那条路径）', () => {
    // 冷启动空池 → 之后登录 ⇒ 原先没有任何重新武装的路径。
    expect(indexSource, '未订阅账号入库通知，登录后不会补武装')
      .toMatch(/pool\.onAccountAdded\(/)
    expect(indexSource, '订阅了通知但没接到调度器上').toMatch(
      /onAccountAdded\([^)]*\)\s*=>\s*\{?\s*refreshScheduler\.notifyAccountAdded\(\)/,
    )
    // ⚠️ 订阅必须被回收：插件卸载后还留着回调会逮住旧调度器。
    expect(indexSource, '未回收账号入库订阅').toMatch(/unsubscribeAccountAdded\(\)/)
  })

  it('listAllAccounts 的失败有兜底（否则存储异常会让调度器永不武装且无痕）', () => {
    // ⚠️ 改造后 `listAllAccounts()` **不再**处于武装路径上（它在 `isPoolEmpty`
    // 里，异常由 `MultiAccountRefreshScheduler.probeEmpty` 吞掉并记 warn），故原先那条
    // 「.then() 链上必须有 .catch」的断言失去对象。现在要保证的是
    // `start()` 的 promise 有兜底 —— 否则未处理的 rejection 会让 DSH 侧
    // 报「插件加载失败」，而实际原因只是一次存储抖动。
    const start = indexSource.indexOf('refreshScheduler.start()')
    expect(start).toBeGreaterThan(-1)
    expect(indexSource.slice(start, start + 400), 'start() 的失败没有兜底').toContain('.catch(')
  })

  it('十个 provider 实例都在批量续期清单里（新增 provider 不得漏接）', () => {
    const expected = [
      'service', 'buddy', 'workbuddy', 'lobsterai', 'qoder',
      'qoderCn', 'trae', 'cline', 'loomy', 'raccoon',
      // ⚠️ 新增 provider 必须同时加进 `src/index.ts` 的 refreshTargets
      // **与本清单** —— 只加前者不会被这条用例发现（它会静默不续期）。
      'minimax',
    ]
    for (const name of expected) {
      expect(
        indexSource,
        `${name}.refreshAll 未接入多账号续期调度`,
      ).toMatch(new RegExp(`\\(?p\\)?\\s*=>\\s*${name}\\.refreshAll\\(p\\)`))
    }
  })

  it('每个 provider 的失败都走同一条日志路径（不再有十个静默 catch）', () => {
    // 旧写法是十个 `try { … } catch { /* 静默 */ }`，把 provider 内部的告警
    // 与异常一起吞掉（issue 第 5.4 条）。现在收敛成一个循环 + 一处 warn。
    const start = indexSource.indexOf('async function refreshAllCredentials')
    expect(start).toBeGreaterThan(-1)
    // 取到函数体结束（CRLF 安全：用正则找第一个「缩进两格的花括号」）
    const body = indexSource.slice(start, start + 800).split(/\r?\n  \}\r?\n/)[0] ?? ''
    expect(body).toMatch(/for \(const \[tag, refreshAll\] of refreshTargets\)/)
    expect(body).toContain('批量续期失败')
    expect(body).not.toMatch(/catch\s*\{\s*\}/)
  })
})

describe('按需续期必须回写账号池的有效期', () => {
  /**
   * issue 第 5.3 条：`refreshAccountCredential` 过去只有 raccoon 回写，
   * 其余七个只 `credentials.set` —— 于是**续期成功但界面纹丝不动**
   * （凭据续好了，UI 读的池值纹丝不动）。
   */
  it.each(AUTH_FILES)('%s 的 refreshAccountCredential 接受 pool + accountId', (rel) => {
    const signature = methodBody(codeOnly(read(rel)), 'async refreshAccountCredential')
    expect(signature, `${rel}: 签名缺 pool`).toContain('pool?: AccountPool')
    expect(signature, `${rel}: 签名缺 accountId`).toContain('accountId?: string')
    // Loomy 无续期端点，但仍要在探测成功后对账（见 LOOMY_EXPIRY_ACCESSORS）。
    //
    // ⚠️ **两种正确形态都接受**（补 minimax 时实测到该断言原先过窄）：
    // ① 直接调 `syncAccountExpiry(...)`（raccoon 的写法）；
    // ② 走包装 `refreshAccountWithReconcile(...)` —— 它**内部**两处调用
    //    `syncAccountExpiry`（见 `src/expiry-sync.ts`），是更规范的用法
    //    （自带回写失败不反噬、有效期内仍对账等既有不变量）。
    // 只认 ① 会把 ② 判为「未调用共享回写」—— 那是**假阴性**。
    expect(signature, `${rel}: 未调用共享回写`).toMatch(
      /syncAccountExpiry\(|refreshAccountWithReconcile\(/,
    )
  })

  it('九个 auth 都改用共享的有效期回写，不再各写一份', () => {
    // 本缺陷的形态正是「raccoon 接好了、其余七个各漏一环」，
    // 故这里锁的是「每个文件都真的引了 `src/expiry-sync.ts`」。
    for (const rel of AUTH_FILES) {
      const source = codeOnly(read(rel))
      expect(source, `${rel}: 未接入共享实现`).toContain("from './expiry-sync.js'")
      expect(source, `${rel}: 未调用共享实现`).toMatch(
        /syncAccountExpiry\(|refreshAccountWithReconcile\(|shouldRefreshNow\(/,
      )
    }
  })

  it('可续期的七个 provider 的 refreshAll 走 lead-time + 对账', () => {
    // Loomy 不在内：它没有 refresh 端点，refreshAll 保留「只探测已过期账号」的
    // 独有语义。raccoon 也不在内：它保留自己更严的「已过期才刷」判据
    // （见 `raccoon-auth.ts` 的注释），只共用回写。
    for (const rel of AUTH_FILES.filter((file) => !/loomy|raccoon/.test(file))) {
      const source = codeOnly(read(rel))
      expect(
        source,
        `${rel}: refreshAll 未接入 refreshAccountWithReconcile`,
      ).toMatch(/refreshAccountWithReconcile\(/)
    }
  })

  /**
   * 例外说明：Loomy 不能续期（`isLoomyRefreshable` 恒 false），
   * 它的 refreshAll 保留「只探测已过期的账号」这一独有语义，
   * 因此不走 lead-time 过滤，只借用共享的对账回写。
   */
  it('loomy 只做有效期对账，且绝不回写 refreshable', () => {
    const source = codeOnly(read('src/loomy-auth.ts'))
    expect(source).toContain('LOOMY_EXPIRY_ACCESSORS')
    expect(source).toMatch(/syncAccountExpiry\(/)
    // 不提供 refreshableOf → 共享实现不会把池里的 `refreshable` 改掉。
    expect(source).not.toMatch(/refreshableOf/)
  })

  it('account.refresh 的每个 provider 分支都把 pool 与 entry.id 传下去', () => {
    const switchStart = rpcSource.indexOf('switch (entry.provider)')
    const switchBody = rpcSource.slice(switchStart, rpcSource.indexOf('default:', switchStart))
    const branches = switchBody.match(/case /g) ?? []
    expect(branches.length).toBeGreaterThanOrEqual(10)
    // qoder 与 qodercn **共用一个 case**（同族注册表），故调用数比分支数少一。
    const calls = switchBody.match(/refreshAccountCredential\([^)]*\)/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(branches.length - 1)
    for (const call of calls) {
      expect(call, `RPC 分支漏传 pool/entry.id：${call}`).toMatch(/pool,\s*entry\.id/)
    }
  })

  it('index.ts 的适配器 refresh 回调同样传 pool 与账号 id（按需续期最常触发的路径）', () => {
    const calls = indexSource.match(/refreshAccountCredential\([^)]*\)/g) ?? []
    // 八个：codearts / lobsterai / qoder / qodercn / trae / cline / loomy / raccoon。
    // buddy 与 workbuddy 走 `createPoolRefresh`（下一条用例）。
    expect(calls.length).toBeGreaterThanOrEqual(8)
    for (const call of calls) {
      expect(call).toMatch(/pool,\s*available\.entry\.id/)
    }
  })

  it('createPoolRefresh（CodeBuddy 系发消息途中的按需续期）也回写账号池', () => {
    // 这条路径由 `buddy-adapter.ts` 的 401/403 分支调用，触发频率远高于
    // RPC `account.refresh`；漏传 pool 就意味着 buddy/workbuddy 的
    // 「已过期」显示在实际续期成功后仍然挂着。
    const source = codeOnly(read('src/buddy-auth.ts'))
    const body = source.slice(source.indexOf('export function createPoolRefresh'))
    expect(body).toMatch(
      /refreshAccountCredential\(\s*available\.entry\.credentialRef,\s*pool,\s*available\.entry\.id/,
    )
  })
})
