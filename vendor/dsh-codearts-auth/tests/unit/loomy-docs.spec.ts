import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

/**
 * ⚠️ 这份协议文档**不入库**（`.gitignore` 的 `docs/loomy-protocol-notes.md`）——
 * 它装的正是上面那条用例要求**不得**出现在公开 README/AGENTS.md 里的内容
 * （AccessKey、`env-file-crypto`、排查脚本清单）。
 *
 * 因此「校验它存在且含这些细节」这条用例**只在本地存在该文件时才有意义**：
 * 干净克隆 / CI，或本机删过它，`readFileSync` 会抛 **ENOENT** 把整轮测试判红。
 * 那是**测试自身对本地私有产物的依赖**，不是产品缺陷 —— 故改为
 * **存在性守卫 + 干净跳过**（与 `cline-icon.spec.ts` 对官方图标源的同一手法）。
 */
const LOCAL_NOTES = resolve(here, '../../docs/loomy-protocol-notes.md')
const hasLocalNotes = existsSync(LOCAL_NOTES)

/**
 * 文档回归：Loomy 的**特有差异**必须写进 README/AGENTS.md，
 * 否则后来者会按其余 7 个 provider 的直觉改坏它。
 */
describe('Loomy 文档覆盖', () => {
  const readme = read('../../README.md')
  const agents = read('../../AGENTS.md')
  /**
   * 文档面 = 主 AGENTS.md + docs/agent-notes/*.md 的**合并视图**（2026-10-06 拆分）。
   *
   * AGENTS.md 因注入预算（65,536 B，超出部分每轮被截断永不可见）已把逐 provider
   * 的事故史搬到 `docs/agent-notes/`——内容逐字节原样，只是换了落点。文档回归
   * 测试要守护的是「这些约定**在某处成文**」，故断言打在合并视图上；否则拆分
   * 会让 6 条守约用例变红，而那不是文档缺约定，是测试追着旧落点打。
   */
  const agentsFull = [
    agents,
    ...readdirSync(resolve(here, '../../docs/agent-notes'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => read(`../../docs/agent-notes/${f}`)),
  ].join('\n')

  it('README 提到 Loomy provider', () => {
    expect(readme).toMatch(/[Ll]oomy/)
  })

  it('README 写明「不能续期」这一独有差异', () => {
    expect(readme).toMatch(/Loomy[\s\S]{0,4000}?(不能|无法|没有).{0,12}续期/)
  })

  it('README 写明两套认证头（chat 用 Bearer、业务用 token）', () => {
    expect(readme).toMatch(/Bearer[\s\S]{0,600}?token/)
  })

  it('README 写明新手任务 10000 积分与「纯 API 直领」', () => {
    expect(readme).toMatch(/10000/)
    expect(readme).toMatch(/纯 API 直领/)
  })

  it('README 写明积分两池（永久 + 每日）', () => {
    expect(readme).toMatch(/永久积分/)
    expect(readme).toMatch(/每日赠送/)
  })

  it('README 写明生产域名（不再解释测试域名的来历）', () => {
    expect(readme).toContain('loomyad.xunfei.cn')
    expect(readme).toContain('account.xfinfr.com')
  })

  it('README 记录 e2e 探针命令', () => {
    expect(readme).toContain('pnpm test:e2e:loomy')
    expect(readme).toContain('pnpm test:e2e:loomy-chat')
  })

  /**
   * ⚠️ **用户要求**：以下四类内容**不得**出现在 README / AGENTS.md 的
   * **Loomy 章节**，只能放在**不入库**的 `docs/loomy-protocol-notes.md`：
   *
   * ① 排查脚本清单（`scripts/loomy-*`）
   * ② AccessKey 说明（具体值 / `accessKeyId` / `accessKeySecret`）
   * ③ 加密细节（`.env.prod`、解密口令、`env-file-crypto`、AES）
   * ④ `app.asar` 提取方式
   *
   * ⚠️ **必须限定在 Loomy 章节内**：AGENTS.md 的 **Qoder 章节**也提到
   * `app.asar`（既有内容，不在本次要求范围）。全文匹配会误伤它。
   */
  it('Loomy 章节不含脚本清单 / AccessKey / 加密细节（用户要求）', () => {
    // 截取 Loomy 章节（从标题到**下一个二级标题**为止）。
    // ⚠️ 两个文件的标题写法不同：README 是「## Loomy provider（讯飞办公助手）」，
    // AGENTS.md 是「## ⚠️ Loomy（讯飞）provider：…」。故用共同的锚点
    // `Loomy` + 各自标题行的特征，这里取**最后一个**含 `Loomy` 的二级标题。
    //
    // ⚠️ **必须以「下一个二级标题」为界，不能截到文件末尾** ——
    // 后续追加的 provider 章节（如 Raccoon）会落在同一文件的后半部分，
    // 截到末尾会把它们的正文一并纳入本用例的禁用词扫描，
    // 造成「Loomy 章节含 app.asar」这类**误报**
    // （Raccoon 章节合法地提到 `app.asar`，那是它自己的逆向取证方式）。
    const loomySectionOf = (text: string): string => {
      const matches = [...text.matchAll(/^## .*Loomy.*$/gm)]
      const last = matches.at(-1)
      if (last?.index === undefined) return ''
      const rest = text.slice(last.index + last[0].length)
      const next = /^## /m.exec(rest)
      return next?.index === undefined ? rest : rest.slice(0, next.index)
    }
    const readmeLoomy = loomySectionOf(readme)
    // ⚠️ 拆分后 Loomy 的章节整体在 agent-notes（providers-loomy-raccoon-minimax.md），
    //    主 AGENTS.md 只剩指针——所以禁用词扫描打在**该笔记文件的 Loomy 章节**上
    //    （不能打 agentsFull 合并视图：其它笔记合法提到 app.asar 会误报）。
    const loomyNotes = read('../../docs/agent-notes/providers-loomy-raccoon-minimax.md')
    const agentsLoomy = loomySectionOf(loomyNotes)
    expect(readmeLoomy.length, 'README 未找到 Loomy 章节').toBeGreaterThan(0)
    expect(agentsLoomy.length, 'agent-notes 未找到 Loomy 章节').toBeGreaterThan(0)

    const forbidden: [string, RegExp][] = [
      ['脚本清单', /scripts\/loomy/],
      ['AccessKey 字段名', /accessKey(Id|Secret)/],
      ['加密细节 .env.prod', /\.env\.prod/],
      ['解密实现文件', /env-file-crypto/],
      ['AES 混淆细节', /AES[- ]?256|AES 混淆/],
      ['app.asar 提取', /app\.asar/],
      ['测试域名来历', /ossptest/],
    ]
    for (const [label, pattern] of forbidden) {
      expect(readmeLoomy, `README 的 Loomy 章节不应含「${label}」`).not.toMatch(pattern)
      expect(agentsLoomy, `AGENTS.md 的 Loomy 章节不应含「${label}」`).not.toMatch(pattern)
    }
  })

  it.skipIf(!hasLocalNotes)('不入库的协议文档确实存在且含这些细节', () => {
    // 细节被移到这里（该文件在 .gitignore 里，故用 readFileSync 直读磁盘）
    const notes = read('../../docs/loomy-protocol-notes.md')
    expect(notes).toContain('AccessKey')
    expect(notes).toContain('env-file-crypto')
    expect(notes).toContain('scripts/loomy')
  })

  it('本地协议文档缺失时明确记录（便于解释上一条为何被跳过）', () => {
    if (!hasLocalNotes) {
      console.log(`\n[loomy-docs] 未找到本地协议文档：${LOCAL_NOTES}\n  → 私有细节校验已跳过。该文件在 .gitignore 内，干净克隆与 CI 本来就没有它，属预期。`)
    }
    expect(typeof hasLocalNotes).toBe('boolean')
  })

  it('AGENTS.md 记录 Loomy 的协议要点', () => {
    expect(agentsFull).toMatch(/[Ll]oomy/)
    // 新手任务是纯 API 直领（与 workbuddy 的模拟真实行为相反）
    expect(agentsFull).toMatch(/新手任务/)
  })

  it('AGENTS.md 写明两套头与不可续期', () => {
    expect(agentsFull).toMatch(/两套认证头|两套头/)
    // 措辞可能微调，只要求「isLoomyRefreshable」与「false」同段出现
    expect(agentsFull).toMatch(/isLoomyRefreshable[\s\S]{0,80}?false/)
    expect(agentsFull).toMatch(/没有 refresh 端点/)
  })

  it('AGENTS.md 记录位置参数陷阱（避免下次再加 provider 时重犯）', () => {
    expect(agentsFull).toMatch(/位置参数/)
    expect(agentsFull).toContain('registerJetHubRpc')
  })

  it('AGENTS.md 概述行的 provider 数量与它自己列出的 id 一致', () => {
    // ⚠️ 原实现把「七个」这个字面量写死在断言里，于是**每加一个 provider 都要
    // 回来改这条用例** —— 与 `registerJetHubRpc` 的位置参数是同一类脆弱点。
    // 改成自校验：数出概述行里反引号包裹的 provider id 个数，与句中声称的
    // 中文数量词比对。这样它既能抓住「改了列表忘了改数字」，也能抓住
    // 「改了数字忘了改列表」，且新增 provider 时**无需修改本用例**。
    const line = agentsFull.split('\n').find((l) => l.includes('LLM provider 路由'))
    expect(line, '找不到 AGENTS.md 的 provider 概述行').toBeDefined()
    const ids = [...line!.matchAll(/`([a-z]+)`（/g)].map((m) => m[1])
    expect(ids.length, '概述行列出的 provider id 数量异常').toBeGreaterThan(0)
    const CN_DIGITS: Record<string, number> = {
      一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    }
    // ⚠️ 数字与「个」之间**没有**空格（「九个」），空格在「个」之后。
    const stated = /([一二三四五六七八九十]+)个\s*LLM provider 路由/.exec(line!)
    expect(stated, '概述行未声明 provider 数量').not.toBeNull()
    expect(
      CN_DIGITS[stated![1]!],
      `概述行声称 ${stated![1]} 个 provider，但实际列出了 ${ids.length} 个`,
    ).toBe(ids.length)
    // 中国版必须在列（它是本次新增的 provider）
    expect(ids).toContain('qodercn')
  })

  /**
   * ⚠️ **负载均衡策略必须写进文档**。
   *
   * 真实缺陷：Loomy **不会因积分耗尽而报错**（静默降级为扣永久积分），
   * 故既有「限流 → 换号」对它无效，会一直烧同一个号。
   */
  it('README 写明按余额优先选号的负载均衡策略', () => {
    expect(readme).toMatch(/负载均衡/)
    expect(readme).toMatch(/dailyBalance > 0/)
    expect(readme).toMatch(/permanentBalance > 0/)
    // 三个关键约定
    expect(readme).toMatch(/手动顺序/)
    expect(readme).toMatch(/60 秒/)
  })

  it('AGENTS.md 写明「Loomy 不会因积分耗尽报错」与三条不可改的约定', () => {
    expect(agentsFull).toMatch(/静默降级/)
    expect(agentsFull).toMatch(/getAvailableAccount/)
    // 档内保序 / 查询失败归最后一档 / 先过滤再分档
    expect(agentsFull).toMatch(/档内保持手动拖拽顺序/)
    expect(agentsFull).toMatch(/查询失败归最后一档/)
    expect(agentsFull).toMatch(/未停用 \+ 该模型未受限/)
    // modelId 必须透传（原实现疏漏）
    expect(agentsFull).toMatch(/modelId/)
  })
})
