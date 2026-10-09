import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import type { BuddyCredential } from '../../src/buddy.js'

// ═══ 默认跳过 ═══
//
// 本文件是 Buddy (腾讯 CodeBuddy) 的端到端用例，会**使用真实凭据访问真实后端
// 模型**，产生真实额度消耗。因此默认整体 skip，仅在同时满足以下两个条件时
// 才会真正执行：
//
//   1. 显式设置 DSH_BUDDY_E2E=1（与 codearts 的 DSH_CODEARTS_E2E 同款闸门）；
//   2. 仍处于 CodeBuddy 新用户 14 天免费试用期内。
//
// ── 14 天免费试用期（重要） ──
//
// 起始日 2026-08-28，**包含 8 月 28 日当天**，共 14 天：
//
//     第  1 天  2026-08-28
//     第 14 天  2026-09-10
//
// 即免费期截止到 2026-09-10 24:00（本地时间）。自 2026-09-11 00:00 起，
// 调用后端模型不再免费，会消耗付费额度。
//
// 因此本文件在收集期就用 TRIAL_ACTIVE 判定并 skip 整个 describe（报告里显示
// 为 skipped，不产生任何网络调用）；同时在每个用例体内再判定一次并调用
// ctx.skip()，作为运行期兜底——防止长跑的 e2e 跨越午夜边界、或在试用期
// 到期当天被手动唤起时对已收费账号产生真实调用。

/** 免费试用第 1 天（含当天）。 */
const TRIAL_START = new Date(2026, 7, 28, 0, 0, 0, 0)
/** 免费试用截止时刻（不含）：第 14 天 2026-09-10 结束的瞬间。 */
const TRIAL_END_EXCLUSIVE = new Date(2026, 8, 11, 0, 0, 0, 0)

/** 当前时刻是否落在 14 天免费试用期内。 */
function withinTrial(now: Date = new Date()): boolean {
  return now >= TRIAL_START && now < TRIAL_END_EXCLUSIVE
}

const E2E = process.env.DSH_BUDDY_E2E === '1'

/**
 * 试用期结束后，本用例会消耗**付费额度**。因此除 DSH_BUDDY_E2E=1 外，
 * 还要求显式确认（DSH_BUDDY_E2E_CONFIRM=yes）才会真正执行。
 * 这防止 `DSH_BUDDY_E2E=1` 被顺手导出后误跑，产生真实费用。
 */
const CONFIRMED = process.env.DSH_BUDDY_E2E_CONFIRM === 'yes'

/** 试用期已过的说明文案，供 skip 原因复用。 */
const TRIAL_EXPIRED_REASON = 'CodeBuddy 14 天免费试用期已过（2026-08-28 ~ 2026-09-10，含首日），跳过真实后端调用以免产生付费额度消耗'

// 收集期跳过：未显式开启 e2e、未确认消耗额度、或仍在免费试用期外且未确认时，
// 整个 describe 都不执行（报告显示 skipped，不产生任何网络调用）。
const suite = E2E && CONFIRMED ? describe : describe.skip

// 本轮验证的模型。hy4-preview 是默认模型且是本次排查的目标模型，
// 另外带上 deepseek-v4-flash（适配器 DEFAULT_MODEL）与各家代表模型。
const MODELS = [
  'hy4-preview',
  'deepseek-v4-flash',
  'glm-5.3',
  'kimi-k3-1',
] as const

/**
 * 解析真实凭据：优先从 DSH_BUDDY_CREDENTIAL_JSON 环境变量读取
 * （JSON 字符串，与 BUDDY_ACCESS_TOKEN 存储值同构），其次从
 * DSH_BUDDY_ACCESS_TOKEN / DSH_BUDDY_REFRESH_TOKEN 拼装。
 * 两种方式都要求调用方先在 Jet Hub 的 CodeBuddy 面板完成登录并把凭据注入环境。
 */
function loadCredentialFromEnv(): BuddyCredential {
  const json = process.env.DSH_BUDDY_CREDENTIAL_JSON
  if (json && json.length > 0) {
    return JSON.parse(json) as BuddyCredential
  }
  const accessToken = process.env.DSH_BUDDY_ACCESS_TOKEN
  const refreshToken = process.env.DSH_BUDDY_REFRESH_TOKEN
  if (accessToken && refreshToken) {
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: process.env.DSH_BUDDY_EXPIRES_AT,
      token_type: 'Bearer',
      scope: '',
      domain: 'copilot.tencent.com',
    }
  }
  throw new Error(
    'e2e 用例需要真实 CodeBuddy 凭据。请先在 Jet Hub 的 CodeBuddy 面板登录，然后设置 '
      + 'DSH_BUDDY_CREDENTIAL_JSON（推荐，与 BUDDY_ACCESS_TOKEN 存储值同构的 JSON 字符串）'
      + '或 DSH_BUDDY_ACCESS_TOKEN / DSH_BUDDY_REFRESH_TOKEN 环境变量。',
  )
}

/** 构造一个直连真实后端的适配器；不支持刷新（凭据由环境变量直接注入）。 */
function liveAdapter(credential: BuddyCredential): BuddyAdapter {
  return new BuddyAdapter({
    credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
    resolveCredential: async () => credential,
    refresh: async () => {
      throw new Error('e2e: credential refresh not supported; please re-login and update env')
    },
  })
}

suite('buddy models e2e', () => {
  for (const model of MODELS) {
    it(
      `${model} can send and receive messages`,
      async (ctx) => {
        // 运行期兜底判定：跨越试用期边界时跳过，不产生真实调用。
        if (!withinTrial()) ctx.skip(TRIAL_EXPIRED_REASON)

        const adapter = liveAdapter(loadCredentialFromEnv())
        const sentMessage = `Reply with exactly this text and nothing else: LIVE_TEST_OK (model=${model})`
        const texts: string[] = []
        const reasoning: string[] = []
        let finishKind: string | undefined
        for await (const chunk of adapter.stream({
          provider: 'buddy',
          model,
          messages: [{ role: 'user', content: sentMessage }],
          signal: new AbortController().signal,
        } as never)) {
          if (chunk.type === 'text-delta') texts.push(chunk.text)
          if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
          if (chunk.type === 'finish') finishKind = chunk.reason.kind
        }

        // 推理模型可能把整段回答作为 reasoning_content 发出且 content 为空。
        // 两种路径都算"收到回复"。
        const received = texts.join('') || reasoning.join('')
        expect(received.length).toBeGreaterThan(0)
        expect(received).toContain('LIVE_TEST_OK')
        // 纯文本回复，无工具调用。
        expect(finishKind).toBe('stop')
      },
      290_000,
    )
  }
})

suite('buddy tool call e2e', () => {
  // 真实后端回归：hy4-preview 以**分段流式**下发工具调用，参数续分片会带回
  // 空的 function.name（""）。适配器曾因 `!== undefined` 判断让空串覆盖了
  // 首个分片解析出的真实工具名，最终输出 name:"" 并被 harness 拒绝
  // （`Error: unknown tool ""`）。这里在真实链路上断言工具名非空且参数可解析。
  it(
    'hy4-preview streams a tool call with a non-empty name and parseable arguments',
    async (ctx) => {
      if (!withinTrial()) ctx.skip(TRIAL_EXPIRED_REASON)

      const adapter = liveAdapter(loadCredentialFromEnv())
      const toolCallBlocks: Array<{ id: string; name: string; arguments: string }> = []
      const deltas: Array<{ name?: string }> = []
      let finishKind: string | undefined
      for await (const chunk of adapter.stream({
        provider: 'buddy',
        model: 'hy4-preview',
        messages: [{
          role: 'user',
          content: 'Call the get_weather tool for Beijing exactly once. Do not answer in plain text.',
        }],
        tools: [{
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'City name' },
            },
            required: ['city'],
          },
        }],
        signal: new AbortController().signal,
      } as never)) {
        if (chunk.type === 'tool-call-delta') {
          deltas.push({ name: (chunk as { name?: string }).name })
        }
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          toolCallBlocks.push({
            id: chunk.block.id,
            name: chunk.block.name,
            arguments: chunk.block.arguments,
          })
        }
        if (chunk.type === 'finish') finishKind = chunk.reason.kind
      }

      expect(toolCallBlocks.length).toBeGreaterThanOrEqual(1)
      const call = toolCallBlocks.find(block => block.name === 'get_weather')
      expect(call).toBeDefined()
      // 核心断言：工具名不得为空——空名即 `unknown tool ""` 故障的复现条件。
      expect(call!.name.length).toBeGreaterThan(0)
      expect(call!.id.length).toBeGreaterThan(0)
      // 一旦某个分片带过名字，后续所有分片的 name 都必须是该真名，不得被空串覆盖。
      for (const delta of deltas) {
        if (delta.name !== undefined) expect(delta.name).toBe(call!.name)
      }
      // 参数必须是完整可解析的 JSON（跨分片拼接正确）。
      const args = JSON.parse(call!.arguments) as { city?: string }
      expect(typeof args.city).toBe('string')
      expect(args.city!.length).toBeGreaterThan(0)
      expect(finishKind).toBe('tool-calls')
    },
    290_000,
  )
})
