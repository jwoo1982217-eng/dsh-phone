/**
 * `splitThinkTaggedContent` 的回归测试。
 *
 * ## 真实缺陷（用户报障，2026-09-25）
 *
 * `workbuddy/hy4-preview-f` 把**思考**写进 `content`（正文）通道，只在思考段
 * 末尾留一个 `</think:6124c78e>` **闭标签**（开标签缺失）。实测该会话 93 步中
 * 只有 9 步的 reasoning 通道非空，思考总量 9563 字符 vs 正文 64043 字符。
 *
 * 两个后果：
 *  1. 思考内容落在正文块里 → 现有思考守卫（只喂 reasoning）完全看不见 →
 *     该模型的正文出现真循环（去重率 0.0412），实测三段（seq 34752/34768/34823）；
 *  2. 用户在界面上看到的是「模型把内心独白当正文输出」。
 *
 * 故需按闭标签把正文块切回「思考 + 真正文」两段。
 *
 * ## 实测形态（155 会话普查）
 *
 * | 项 | 值 |
 * |---|---|
 * | 含标签的步数 | 28（仅 2 个模型：hy4-preview-f 25、workbuddy/ds-v4.1-flash 3）|
 * | 开标签 | **0** |
 * | 闭标签 | 28（每步恰好 1 个）|
 * | hex | 恒为 `6124c78e`（会话级 id，8 位小写）|
 * | 标签前 | 内心独白（`让me check.` 重复），13~34364 字符 |
 * | 标签后 | **真正文**，13~56 字符 |
 *
 * ## 两类 think 标签的分工（2026-09-27 新增裸标签形态）
 *
 * | 类型 | 示例 | 处理函数 |
 * |---|---|---|
 * | **hex 后缀** | `</think:6124c78e>` | **本文件**：`splitThinkTaggedContent` 切分 |
 * | **裸闭标签** | `\n</think>\n\n` | `stripBareThinkCloseTag` 剥离（见 `strip-bare-think.spec.ts`） |
 *
 * ⚠️ 本文件**只**测带 hex 的切分。若哪天 `splitThinkTaggedContent` 误认裸标签，
 * 会把「模型引用标签的正文」前半段当思考移走 —— 故末尾有两条边界回归锁住分工。
 *
 * ⚠️ 另有截断判定（正文引用标签致上游掐断）见 `think-stop-string.spec.ts`。
 */
import { describe, expect, it } from 'vitest'
import { splitThinkTaggedContent, stripBareThinkCloseTag } from '../../src/sse.js'

describe('splitThinkTaggedContent', () => {
  it('无标签时返回 undefined（不得改变既有行为）', () => {
    expect(splitThinkTaggedContent('普通正文，没有标签。')).toBeUndefined()
    expect(splitThinkTaggedContent('')).toBeUndefined()
  })

  it('闭标签前的文本归为思考、之后的归为正文', () => {
    const raw = '让me check callers.让me grep.</think:6124c78e>让me确认校验函数名。'
    const split = splitThinkTaggedContent(raw)
    expect(split).toBeDefined()
    expect(split!.reasoning).toBe('让me check callers.让me grep.')
    expect(split!.text).toBe('让me确认校验函数名。')
  })

  it('textStart 指向标签结束位置（正文在原文中的起点）', () => {
    const raw = '思考部分</think:6124c78e>正文部分'
    const split = splitThinkTaggedContent(raw)!
    // 标签长度 = '</think:6124c78e>'.length = 17
    expect(split.textStart).toBe('思考部分'.length + '</think:6124c78e>'.length)
    expect(raw.slice(split.textStart)).toBe('正文部分')
  })

  it('标签在末尾时正文为空串（实测 seq=34768 形态）', () => {
    const raw = '重复的内心独白。\n\n停止重复。读实现。</think:6124c78e>'
    const split = splitThinkTaggedContent(raw)!
    expect(split.text).toBe('')
    expect(split.reasoning).toBe('重复的内心独白。\n\n停止重复。读实现。')
  })

  it('标签在开头时思考为空串', () => {
    const raw = '</think:6124c78e>直接就是正文'
    const split = splitThinkTaggedContent(raw)!
    expect(split.reasoning).toBe('')
    expect(split.text).toBe('直接就是正文')
    expect(split.textStart).toBe('</think:6124c78e>'.length)
  })

  it('多个闭标签时以最后一个为界，且思考段不残留标签', () => {
    const raw = 'A</think:aaa>B</think:bbb>真正文'
    const split = splitThinkTaggedContent(raw)!
    // 以最后一个闭标签（bbb）为界；思考段里的 aaa 标签也要清掉。
    expect(split.reasoning).toBe('AB')
    expect(split.text).toBe('真正文')
  })

  it('hex 长度不固定也认（实测 8 位，防御更长/更短的变体）', () => {
    for (const hex of ['a', 'ab', 'abcdef', '6124c78e', '0123456789abcdef0123']) {
      const raw = `思考</think:${hex}>正文`
      const split = splitThinkTaggedContent(raw)
      expect({ hex, reasoning: split?.reasoning, text: split?.text }).toEqual({
        hex, reasoning: '思考', text: '正文',
      })
    }
  })

  it('hex 含非十六进制字符时不认（避免误伤正常文本）', () => {
    expect(splitThinkTaggedContent('思考</think:zzzz>正文')).toBeUndefined()
    expect(splitThinkTaggedContent('思考</think:>正文')).toBeUndefined()
  })

  it('只有开标签时不切分（实测开标签恒缺失，不猜语义）', () => {
    // ⚠️ 实测 28 步全部只有闭标签、开标签为 0。仅见开标签时无法确定
    // 「思考到哪结束」，故不切分 —— 保持原样比猜错安全。
    expect(splitThinkTaggedContent('<think:6124c78e>还没结束的思考')).toBeUndefined()
  })

  it('大小写不匹配不认（实测恒小写）', () => {
    // ⚠️ 两个断言必须是**不同**的输入（`THINK` 与 `Think`）：曾因批量替换
    // 事故把两行写成同一字符串，该用例**失去判别力却仍全绿**（真实教训）。
    expect(splitThinkTaggedContent('思考</THINK:6124c78e>正文')).toBeUndefined()
    expect(splitThinkTaggedContent('思考</Think:6124c78e>正文')).toBeUndefined()
  })

  it('不匹配无关的尖括号文本', () => {
    expect(splitThinkTaggedContent('a < b </div> c')).toBeUndefined()
  })

  // ─────────────────────────────────────────────────────────────────────
  // 关键回归（普查发现）：必须区分「真泄漏」与「模型在**讨论/引用**标签」。
  //
  // 实测 28 处 text 块标签中，有 **3 处是反引号包裹的行内引用** —— 包括
  // 本次排查会话里我自己复述该标签字面量的正文（`seq=250/270/277`）。
  // 若只看「有没有标签」，会把这类**正常正文**的前半段误当思考移走。
  //
  // 实测判据 A（标签是否被反引号包裹）分离度：**3/3 与 25/25 全部正确**。
  // ─────────────────────────────────────────────────────────────────────
  it('反引号包裹的标签是"引用"而非泄漏，不切分', () => {
    // 实测 seq=270 形态：正文里行内引用该标签说明语义。
    expect(splitThinkTaggedContent('标签语义已明确：`</think:6124c78e>` 是思考与正文的分界符。')).toBeUndefined()
    // 实测 seq=250 形态：在反引号里复述标签。
    expect(splitThinkTaggedContent('正文里残留了 `</think:6124c78e>` 闭标签，但开标签 0 个。')).toBeUndefined()
  })

  it('裸标签（真泄漏）仍正常切分', () => {
    const raw = '让me check callers.让me grep.</think:6124c78e>让me确认校验函数名。'
    const split = splitThinkTaggedContent(raw)!
    expect(split.reasoning).toBe('让me check callers.让me grep.')
    expect(split.text).toBe('让me确认校验函数名。')
  })

  it('代码块里的标签也视为引用（``` 包裹），不切分', () => {
    const raw = '标签形态如下：\n\n```\n<思考>...</think:6124c78e><正文>\n```\n\n即闭标签是分界符。'
    expect(splitThinkTaggedContent(raw)).toBeUndefined()
  })

  // ─────────────────────────────────────────────────────────────────────
  // 裸闭标签（**无 hex**）：2026-09-27 起**本函数也认**（用户纠正的设计方向）。
  //
  // ⚠️ 曾锁死「不认裸标签」——那是**旧形态**下的决定（实测那时恒为 `</think:hex>`）。
  // 新形态出现后，若继续不认，`思考</think>真正文` 会**解析失败**、标签原样落盘。
  // 用户明确要求：**优先保证配对/闭标签正确解析**，过滤只是兜底。
  // 全库普查依据（41 会话）：裸闭标签 **38** 处 vs hex **4** 处。
  // ─────────────────────────────────────────────────────────────────────
  it('裸闭标签 + 两侧正文 → 正确切分（不再解析失败）', () => {
    const split = splitThinkTaggedContent('思考</think>真正文')!
    expect(split.reasoning).toBe('思考')
    expect(split.text).toBe('真正文')
  })

  it('裸闭标签在末尾 / 开头 → 同样切分', () => {
    expect(splitThinkTaggedContent('思考</think>')!.text).toBe('')
    expect(splitThinkTaggedContent('思考</think>')!.reasoning).toBe('思考')
    const head = splitThinkTaggedContent('</think>真正文')!
    expect(head.reasoning).toBe('')
    expect(head.text).toBe('真正文')
  })

  it('多个裸闭标签以最后一个为界，思考段不残留标签', () => {
    const split = splitThinkTaggedContent('A</think>B</think>C')!
    expect(split.reasoning).toBe('AB')
    expect(split.text).toBe('C')
  })

  // ─────────────────────────────────────────────────────────────────────
  // **配对格式**（开 + 闭）：本轮修复的核心目标。
  //
  // ⚠️ 无需单独分支：定界用最后一个**闭**标签，开标签作为「思考段内的标签」
  // 被 `THINK_ANY_TAG_RE` 剔除 ⇒ `思考`。这正是「配对也能正确解析」的实现方式。
  // 旧解析器对配对形态**完全无法解析**（返回 undefined → 原文落盘泄漏）。
  // ─────────────────────────────────────────────────────────────────────
  it('配对格式（开+闭）→ 正确解析出思考与正文', () => {
    const split = splitThinkTaggedContent('<think>思考内容</think>真正文')!
    expect(split.reasoning).toBe('思考内容')
    expect(split.text).toBe('真正文')
    expect(split.textStart).toBe('<think>思考内容</think>'.length)
  })

  it('配对格式（开 + hex 闭）→ 同样正确解析', () => {
    const split = splitThinkTaggedContent('<think>思考内容</think:6124c78e>真正文')!
    expect(split.reasoning).toBe('思考内容')
    expect(split.text).toBe('真正文')
  })

  it('hex 闭标签后跟裸标签（混合）→ 裸标签也不残留', () => {
    // ⚠️ 扩展解析器后**结果比预期更好**：裸标签成了「最后一个闭标签」= 分界点，
    // 于是正文为空串（旧行为会把 `</think>` 留在正文里）。
    const split = splitThinkTaggedContent('思考</think:6124c78e></think>')!
    expect(split.reasoning).toBe('思考')
    expect(split.text).toBe('')
    expect(split.text.includes('</think>')).toBe(false)
  })

  it('hex 闭标签后跟裸标签+正文 → 裸标签不残留在正文', () => {
    const split = splitThinkTaggedContent('思考</think:6124c78e></think>真正文')!
    expect(split.reasoning).toBe('思考')
    expect(split.text).toBe('真正文')
    expect(split.text.includes('</think>')).toBe(false)
  })

  // ─────────────────────────────────────────────────────────────────────
  // 引用保护在**放宽后**依然有效（这是放宽解析器的主要风险）
  // ─────────────────────────────────────────────────────────────────────
  it('放宽后仍保护单/双引号内的标签（模型复述测试字符串的常见形态）', () => {
    // 实测形态：我在排查时写的测试字符串复述
    expect(splitThinkTaggedContent("expect(splitThinkTaggedContent('</think>无 hex</think>')).toBeUndefined()")).toBeUndefined()
    expect(splitThinkTaggedContent('它写着 "</think>无 hex</think>" 这样的字符串')).toBeUndefined()
  })

  it('放宽后反引号 span 内的标签仍受保护（不要求紧邻）', () => {
    // 实测形态：`` `text </think> more` `` —— 标签在 span 内部而非紧邻反引号
    expect(splitThinkTaggedContent('说明：`标签 </think> 的语义` 到此为止。')).toBeUndefined()
  })
})
