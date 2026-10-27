/**
 * `dsml-parse-roundtrip.spec.ts` —— DSML「教得会 + 解得开」端到端守卫。
 *
 * ## 连续两版漏判的记录（必须留档）
 *
 * - **第 1 版**（`842bf8e`）：只做标记归一化（双竖线→单竖线）。有效
 *   （坏标记 270→0），但**工具仍不执行** —— 因为协议根本没下发。
 * - **第 2 版**（`fc028ea`）：补了「教」（注入 DSML system 提示）。
 *   仍**不行** —— 因为 `consumeOpenAiSse`（OfficeAce 走它）**不解析 DSML**，
 *   解析器当时只存在于 `llm-adapter.ts`（codearts）。
 *
 * 即：**教了但没人解**。故本文件锁的是**成对性**：注入提示的通道，
 * 其消费器必须开启 `dsmlToolMode`。单边存在 = 工具调用静默失效。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildDsmlSystemPrompt,
  DsmlContentExtractor,
  DSML_TOOL_CALLS_CLOSE,
  DSML_TOOL_CALLS_OPEN,
  parseDsmlToolCalls,
} from '../../src/dsml.js'

const SRC = join(process.cwd(), 'src')

describe('DSML 解析（共享层）', () => {
  it('① 完整块解析出结构化调用', () => {
    const block = `${DSML_TOOL_CALLS_OPEN}<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter></｜DSML｜invoke>${DSML_TOOL_CALLS_CLOSE}`
    const calls = parseDsmlToolCalls(block)
    expect(calls).toEqual([{ name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) }])
  })

  it('② 数字参数被误标 string="true" 时还原为 number', () => {
    const block = `${DSML_TOOL_CALLS_OPEN}<｜DSML｜invoke name="read"><｜DSML｜parameter name="offset" string="true">1304</｜DSML｜parameter></｜DSML｜invoke>${DSML_TOOL_CALLS_CLOSE}`
    const calls = parseDsmlToolCalls(block)
    expect(JSON.parse(calls![0].arguments)).toEqual({ offset: 1304 })
  })

  it('③ 多调用并行解析', () => {
    const one = `<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter></｜DSML｜invoke>`
    const two = `<｜DSML｜invoke name="read"><｜DSML｜parameter name="file_path" string="true">a.txt</｜DSML｜parameter></｜DSML｜invoke>`
    const calls = parseDsmlToolCalls(`${DSML_TOOL_CALLS_OPEN}${one}${two}${DSML_TOOL_CALLS_CLOSE}`)
    expect(calls?.map((c) => c.name)).toEqual(['bash', 'read'])
  })

  it('④ 流式：标签跨任意帧切分都能解析（二分帧穷举）', () => {
    const full = `前缀${DSML_TOOL_CALLS_OPEN}<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter></｜DSML｜invoke>${DSML_TOOL_CALLS_CLOSE}后缀`
    for (let cut = 0; cut <= full.length; cut++) {
      const ex = new DsmlContentExtractor()
      const r1 = ex.feed(full.slice(0, cut))
      const r2 = ex.feed(full.slice(cut))
      const f = ex.flush()
      const calls = [...r1.toolCalls, ...r2.toolCalls]
      const text = r1.text + r2.text + f.text + f.reasoning
      expect(calls.length, `切分点 ${cut} 未解析出调用`).toBe(1)
      expect(calls[0].name, `切分点 ${cut} 名字错`).toBe('bash')
      // 标签本身不得泄漏进可见正文
      expect(text, `切分点 ${cut} 标签泄漏`).not.toContain(DSML_TOOL_CALLS_OPEN)
      expect(text).toContain('前缀')
      expect(text).toContain('后缀')
    }
  })

  it('⑤ 流被截断（无闭标签）时残片作为正文放行，不吞内容', () => {
    const ex = new DsmlContentExtractor()
    // ⚠️ 开标签**之前**的正文在 feed() 里就已放行（不在 flush 里）——
    //    两个通道必须分清，否则会误以为正文被吞。
    const r = ex.feed(`正文${DSML_TOOL_CALLS_OPEN}<｜DSML｜invoke name="bash">`)
    expect(r.text).toBe('正文')
    const f = ex.flush()
    // flush 补回开标签，用户看到完整残片而非凭空消失的一段
    expect(f.text).toContain(DSML_TOOL_CALLS_OPEN)
    expect(f.text).toContain('<｜DSML｜invoke name="bash">')
  })
})

describe('成对性守卫：注入提示的通道，消费器必须解析', () => {
  /**
   * ⚠️ **本组是源码级断言，强度有限**（2026-10-13 审计结论，必须如实标注）：
   * 它们只能证明「那行字还在文件里」，**挡不住「删掉接线、保留注释」**。
   * 行为级守卫在 `dsml-consume-wiring.spec.ts`（真喂 SSE 流、断言 chunk），
   * 两处互补：这里防「整段协议被删」，那里防「接了但不通」。
   */
  it('⑥ officeace 注入提示与 dsmlToolMode 必须同时存在（缺一 = 工具永不执行）', () => {
    const c = readFileSync(join(SRC, 'officeace-adapter.ts'), 'utf8')
    // ⚠️ **剥注释后再断言**：旧写法直接在原文上 `/dsmlToolMode/`，而该文件
    //    的**注释里**就含这个词 ⇒ 断言可被注释满足（AGENTS.md 明令禁止
    //    「在注释里写出会被验收 grep 的字符串」）。剥注释后必须仍命中。
    const code = c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const injects = /buildDsmlSystemPrompt\s*\(/.test(code)
    const parses = /dsmlToolMode\s*:\s*true/.test(code)
    expect(injects, 'officeace 未注入 DSML 提示（剥注释后）').toBe(true)
    expect(parses, 'officeace 注入了提示却没开 dsmlToolMode ⇒ 教了但没人解').toBe(true)
    // 两半必须由**同一个**开关驱动：解析开关要在 `dsmlMode` 守卫内出现两次
    // （主路径 + 401 重试路径），漏一处就有半条通道静默失效。
    expect(code.match(/dsmlToolMode\s*:\s*true/g)?.length, 'dsmlToolMode 实参少于 2 处（主路径 / 401 重试）')
      .toBeGreaterThanOrEqual(2)
    expect(code, '两半不由同一开关驱动').toMatch(/dsmlMode/)
  })

  it('⑦ 解析器实现只允许 dsml.ts 一处（不得 llm-adapter 里再留副本）', () => {
    const llm = readFileSync(join(SRC, 'llm-adapter.ts'), 'utf8')
    expect(llm).not.toMatch(/class DsmlContentExtractor/)
    expect(llm).not.toMatch(/function parseDsmlToolCalls/)
    // 但必须**导入**共享层（否则 codearts 自己也没解析器了）
    expect(llm).toMatch(/from '\.\/dsml\.js'/)
  })

  it('⑧ 接线行为级守卫必须存在（源码 grep 挡不住「删接线留注释」）', () => {
    // ⚠️ 真实教训（2026-10-13）：本组 ⑥⑦⑧⑨ 全是源码 grep，实测「删掉
    //    `if (dsmlExtractor !== undefined) {…}` 整块」后**入库用例仍全绿**。
    //    故这里改为断言**行为级 spec 存在且含真断言**，把守卫指向它。
    const spec = readFileSync(join(process.cwd(), 'tests/unit/dsml-consume-wiring.spec.ts'), 'utf8')
    expect(spec, '缺少 consumeOpenAiSse 的行为级 DSML 守卫').toContain('consumeOpenAiSse')
    expect(spec, '未开启/开启的对照断言缺失').toMatch(/dsmlToolMode:\s*true/)
    // 必须有真断言（而非只有 console.log 的探针）
    expect((spec.match(/expect\(/g) ?? []).length, '行为级 spec 断言过少').toBeGreaterThanOrEqual(10)
  })

  it('⑨ 未开启 dsmlToolMode 时行为不变（不误伤普通通道）', () => {
    // 默认构造的提取器为 undefined ⇒ 正文直传。
    const c = readFileSync(join(SRC, 'openai-compat.ts'), 'utf8')
    expect(c).toMatch(/config\.dsmlToolMode === true \? new DsmlContentExtractor\(\) : undefined/)
  })
})

describe('提示词与解析器同源', () => {
  it('⑩ 提示词教的格式，解析器必须能解开（往返验证）', () => {
    const prompt = buildDsmlSystemPrompt([{
      type: 'function',
      function: { name: 'bash', description: 'run', parameters: { type: 'object' } },
    }])
    // 从提示词里抽出示范格式，套上真实参数后交给解析器
    const example = `${DSML_TOOL_CALLS_OPEN}<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">echo hi</｜DSML｜parameter></｜DSML｜invoke>${DSML_TOOL_CALLS_CLOSE}`
    expect(prompt).toContain(DSML_TOOL_CALLS_OPEN)
    const calls = parseDsmlToolCalls(example)
    expect(calls?.[0].name).toBe('bash')
  })
})
