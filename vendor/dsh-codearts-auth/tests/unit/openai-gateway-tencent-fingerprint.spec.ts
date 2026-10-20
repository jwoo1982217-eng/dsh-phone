import { describe, expect, it } from 'vitest'
import { toGenerateOptions } from '../../src/openai-gateway/messages.js'
import { toResponsesGenerateOptions } from '../../src/openai-gateway/responses.js'
import {
  isTencentContentFingerprintProvider,
  rewriteTencentContentFingerprints,
} from '../../src/openai-gateway/tencent-fingerprint.js'

/**
 * 腾讯系内容级风控指纹改写 —— Gitee issue IKJNA1。
 *
 * ## 现象（用户报障，2026-10-04）
 *
 * ZCode 经本插件的 OpenAI 网关调 `workbuddy/deepseek-v4.1-flash` 稳定失败，
 * 客户端横幅只显示 `provider_code=INVALID_REQUEST reason=unknown`，
 * 网关侧原始报错是：
 * ```
 * workbuddy: 请求被安全策略拦截… Illegal API invocation from an unapproved channel
 * ```
 * 而 DSH 直连同一模型完全正常。
 *
 * ## 根因（本机 2026-10-05 对 `www.workbuddy.ai` + `copilot.tencent.com` 双端点实测）
 *
 * 腾讯网关按**请求内容指纹**拦截，与账号、凭据、请求头、tools 全无关。
 * 最小充分触发串是 ZCode 内建的 gitStatus 模板句常量
 * （`$Js="Main branch (you will usually use this for PRs)"`）。
 *
 * 逐组实测（`max_tokens=16`，被拦不耗额度）给出的**判据**，全部锁进下面的用例：
 *
 * | 探针 | 结果 | 结论 |
 * |---|---|---|
 * | 中性 system | ✅ 200 | 基线 |
 * | `Main branch (you will usually use this for PRs): master` | ❌ 400/11128 | 最小充分触发 |
 * | `Main branch: master` | ✅ 200 | 不是泛关键词 |
 * | 换分支名（`dev`） | ❌ 400 | 分支值无关 |
 * | 只差一个词（`normally`） | ✅ 200 | **逐字符**匹配，不能泛化 |
 * | 内层多一个空格 | ✅ 200 | 同上 |
 * | 全小写 / 全大写 | ❌ 400 | **大小写不敏感** |
 * | 同一句在 **user** 消息 | ✅ 200 | 只拦 system |
 * | 同一句在 **tool** 消息 | ✅ 200 | 同上 |
 * | 指纹在**第二条** system（非 `messages[0]`） | ❌ 400 | 所有 system 都要改 |
 * | 改写该句 | ✅ 200 | 修法有效 |
 */
const TRIGGER = 'Main branch (you will usually use this for PRs)'
const REWRITE = 'Main branch (PRs usually go here)'

/** ZCode 真实的 gitStatus 注入块形态（issue 报障现场）。 */
const ZCODE_GITSTATUS = [
  '<git_status>',
  'On branch master',
  `${TRIGGER}: master`,
  "Your branch is up to date with 'origin/master'.",
  '',
  'Changes not staged for commit:',
  '  modified: src/index.ts',
  '</git_status>',
].join('\n')

function abort(): AbortSignal {
  return new AbortController().signal
}

/**
 * 取出 DSH 消息里全部文本（含 `tool-result` 内层）的纯文本。
 *
 * 工具结果被包成 `{type:'tool-result', content:[…]}`，只扫顶层会漏掉它 ——
 * 而「tool 消息不得被改写」正是要断言的那一条。
 */
function textsOf(messages: ReadonlyArray<{ content: unknown }>): string[] {
  const out: string[] = []
  const walk = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue
      const typed = block as { type?: unknown; text?: unknown; content?: unknown }
      if (typed.type === 'text' && typeof typed.text === 'string') out.push(typed.text)
      if (typed.type === 'tool-result') walk(typed.content)
    }
  }
  for (const message of messages) walk(message.content)
  return out
}

describe('腾讯系内容级风控指纹改写（IKJNA1）：纯函数', () => {
  it('★ 只对腾讯系两个 provider 生效', () => {
    // qoder / trae / codearts 等后端没有这个过滤器；误伤它们等于替别的上游
    // 改写用户原话，而收益为零。
    expect(isTencentContentFingerprintProvider('buddy')).toBe(true)
    expect(isTencentContentFingerprintProvider('workbuddy')).toBe(true)
    for (const other of ['qoder', 'qodercn', 'trae', 'codearts', 'lobsterai', 'zcode', 'BUDDY', '']) {
      expect(isTencentContentFingerprintProvider(other)).toBe(false)
    }
  })

  it('★ 腾讯系：system 里的模板句被改写，语义保持等价', () => {
    expect(rewriteTencentContentFingerprints(`${TRIGGER}: master`, 'workbuddy'))
      .toBe(`${REWRITE}: master`)
    // CodeBuddy 中国版同一套（实测两端点表现一致）
    expect(rewriteTencentContentFingerprints(`${TRIGGER}: dev`, 'buddy'))
      .toBe(`${REWRITE}: dev`)
  })

  it('★ 非腾讯系：逐字节不变', () => {
    for (const provider of ['qoder', 'trae', 'codearts', 'lobsterai']) {
      expect(rewriteTencentContentFingerprints(ZCODE_GITSTATUS, provider)).toBe(ZCODE_GITSTATUS)
    }
  })

  it('★ 腾讯系但不含指纹：逐字节不变（不能破坏上游的前缀缓存）', () => {
    // 判据是**内容**：没有指纹就必须原样返回。若这里返回一份「等价但新」的字符串，
    // 腾讯侧按前缀缓存就会每一轮都算新前缀。
    const neutral = 'You are a helpful assistant.\n\nWorking directory: D:\\repo\nBe concise.'
    expect(rewriteTencentContentFingerprints(neutral, 'workbuddy')).toBe(neutral)
    // 只留标签、没有模板句 —— 实测放行，**不能**多改
    const label = 'Main branch: master'
    expect(rewriteTencentContentFingerprints(label, 'workbuddy')).toBe(label)
    expect(rewriteTencentContentFingerprints(label, 'buddy')).toBe(label)
  })

  it('★ 大小写不敏感：全小写与全大写同样被拦，因此同样要改', () => {
    // 实测：全小写 / 全大写都回 400/11128。若只做大小写敏感的 replaceAll，
    // 一个把模板句改成小写的客户端就会**继续**被拦。
    expect(rewriteTencentContentFingerprints(`main branch (you will usually use this for PRs)`, 'workbuddy'))
      .toBe(REWRITE)
    expect(rewriteTencentContentFingerprints(`MAIN BRANCH (YOU WILL USUALLY USE THIS FOR PRS)`, 'workbuddy'))
      .toBe(REWRITE)
    expect(rewriteTencentContentFingerprints(`Main Branch (You Will Usually Use This For PRs)`, 'workbuddy'))
      .toBe(REWRITE)
  })

  it('★ 绝不泛化：只差一个词 / 多一个空格都**不动**（服务端认的是逐字符字面量）', () => {
    // 这两条是「不要图省事改成正则 / 关键词黑名单」的判据：服务端放行它们，
    // 我们若也改，就是替上游改写了用户的正常提示词。
    const oneWordOff = 'Main branch (you will normally use this for PRs)'
    const extraSpace = 'Main branch  (you will usually use this for PRs)'
    const noParens = 'Main branch: you will usually use this for PRs'
    for (const text of [oneWordOff, extraSpace, noParens]) {
      expect(rewriteTencentContentFingerprints(text, 'workbuddy')).toBe(text)
    }
  })

  it('★ 一次出现多处时全部改写（客户端可能把同一模板注入多行）', () => {
    const twice = `${TRIGGER}: master\n${TRIGGER}: master`
    expect(rewriteTencentContentFingerprints(twice, 'workbuddy'))
      .toBe(`${REWRITE}: master\n${REWRITE}: master`)
  })

  it('★ 真实 git_status 块：只改那一句，其余行逐字节不变', () => {
    const out = rewriteTencentContentFingerprints(ZCODE_GITSTATUS, 'workbuddy')
    expect(out).not.toContain(TRIGGER)
    expect(out).toContain(`${REWRITE}: master`)
    expect(out).toContain('<git_status>')
    expect(out).toContain("Your branch is up to date with 'origin/master'.")
    expect(out).toContain('  modified: src/index.ts')
    expect(out.split('\n')).toHaveLength(ZCODE_GITSTATUS.split('\n').length)
  })

  it('多条规则之间不互相污染（预检不会把 lastIndex 带进下一条）', () => {
    // `g` 正则的 lastIndex 若被带过去，第二条规则会漏改开头那段 —— 这里用
    // 「同一条规则连续调用」+「先长后短」两种顺序都验一遍。
    const text = `${TRIGGER}\n${TRIGGER}`
    expect(rewriteTencentContentFingerprints(text, 'workbuddy')).toBe(`${REWRITE}\n${REWRITE}`)
    // 第一次调用后再调一次，结果必须与第一次一致（无状态残留）。
    expect(rewriteTencentContentFingerprints(text, 'workbuddy'))
      .toBe(rewriteTencentContentFingerprints(text, 'workbuddy'))
  })

  it('空串与纯空白不受影响', () => {
    expect(rewriteTencentContentFingerprints('', 'workbuddy')).toBe('')
    expect(rewriteTencentContentFingerprints('   \n\t ', 'workbuddy')).toBe('   \n\t ')
  })
})

describe('OpenAI 网关 Chat 路径：只改 system，其余角色一概不碰', () => {
  it('★ workbuddy：system 被改写', async () => {
    const options = await toGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: ZCODE_GITSTATUS },
        { role: 'user', content: '改一下 README' },
      ],
    }, abort())
    expect(textsOf(options.messages)[0]).not.toContain(TRIGGER)
    expect(textsOf(options.messages)[0]).toContain(REWRITE)
  })

  it('★ 非首位的 system 同样要改（实测非 messages[0] 的 system 也被拦）', async () => {
    const options = await toGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: '继续' },
        { role: 'system', content: `${TRIGGER}: master` },
      ],
    }, abort())
    const systems = options.messages
      .filter((message) => message.role === 'system')
      .flatMap(message => textsOf([message]))
    expect(systems).toEqual(['You are a helpful assistant.', `${REWRITE}: master`])
  })

  it('★ user / assistant / tool 里的同一句**原样保留**（实测那三个角色不拦）', async () => {
    // 改写它们没有任何收益，却会篡改用户原话与工具输出 —— 而工具输出往往
    // 是要回读给模型看的证据。
    const options = await toGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: `看看这句：${TRIGGER}` },
        { role: 'assistant', content: `好的：${TRIGGER}`, tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'call-1', content: `${TRIGGER}: master` },
      ],
    }, abort())
    const all = textsOf(options.messages)
    expect(all.filter((text) => text.includes(TRIGGER)).length).toBe(3)
    expect(all.some((text) => text.includes(REWRITE))).toBe(false)
  })

  it('★ 非腾讯系 provider：整条请求逐字节不变', async () => {
    const options = await toGenerateOptions({
      model: 'qoder/qfmodel',
      messages: [
        { role: 'system', content: ZCODE_GITSTATUS },
        { role: 'user', content: 'hi' },
      ],
    }, abort())
    expect(textsOf(options.messages)[0]).toBe(ZCODE_GITSTATUS)
  })
})

describe('OpenAI 网关 Responses 路径：与 Chat 同一判据', () => {
  it('★ instructions 走改写（Responses 端唯一的 system 通道）', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      instructions: ZCODE_GITSTATUS,
      input: 'hi',
    }, abort())
    expect(textsOf(options.messages)[0]).not.toContain(TRIGGER)
    expect(textsOf(options.messages)[0]).toContain(REWRITE)
  })

  it('★ input 里的 system / developer 消息也走改写', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      input: [
        { type: 'message', role: 'system', content: `${TRIGGER}: master` },
        { type: 'message', role: 'developer', content: `also ${TRIGGER}` },
        { type: 'message', role: 'user', content: `keep ${TRIGGER}` },
      ],
    }, abort())
    const texts = textsOf(options.messages)
    expect(texts[0]).toBe(`${REWRITE}: master`)
    expect(texts[1]).toBe(`also ${REWRITE}`)
    // user 消息不碰
    expect(texts).toContain(`keep ${TRIGGER}`)
  })

  it('★ 非腾讯系 provider：instructions 逐字节不变', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      instructions: ZCODE_GITSTATUS,
      input: 'hi',
    }, abort())
    expect(textsOf(options.messages)[0]).toBe(ZCODE_GITSTATUS)
  })
})
