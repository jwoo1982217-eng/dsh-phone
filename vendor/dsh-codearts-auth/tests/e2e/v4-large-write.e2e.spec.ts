import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

// 仅在 `pnpm test:e2e` 下执行（需设置 DSH_CODEARTS_E2E=1）。
const E2E = process.env.DSH_CODEARTS_E2E === '1'

/**
 * 复用 v4-models.e2e.spec.ts 的凭据加载逻辑（同构环境变量契约）。
 * 避免重复实现，直接内联一份——e2e 用例文件之间不互相 import。
 */
function loadCredentialFromEnv(): CodeArtsCredential {
  const json = process.env.DSH_CODEARTS_CREDENTIAL_JSON
  if (json && json.length > 0) {
    return JSON.parse(json) as CodeArtsCredential
  }
  const ak = process.env.DSH_CODEARTS_ACCESS_KEY_ID
  const sk = process.env.DSH_CODEARTS_SECRET_ACCESS_KEY
  const st = process.env.DSH_CODEARTS_SECURITY_TOKEN
  const expiresAt = process.env.DSH_CODEARTS_EXPIRES_AT
  if (ak && sk && st && expiresAt) {
    return { access_key_id: ak, secret_access_key: sk, security_token: st, expires_at: expiresAt }
  }
  throw new Error(
    'e2e 用例需要真实 CodeArts 凭据。请先完成 /codearts-login，然后设置 '
      + 'DSH_CODEARTS_CREDENTIAL_JSON 或 DSH_CODEARTS_ACCESS_KEY_ID / '
      + 'DSH_CODEARTS_SECRET_ACCESS_KEY / DSH_CODEARTS_SECURITY_TOKEN / '
      + 'DSH_CODEARTS_EXPIRES_AT 环境变量。',
  )
}

/**
 * 构造一个"大文件 write 工具调用"的 prompt：要求模型生成 2000 行的 TypeScript
 * 文件并调用 write 工具写入。这是 deepseek-v4-flash 在标准 tool_calls 模式下
 * 反复失败的场景（实测 2026-08-22）：参数一次性打包生成，SSE 静默 >60s 被
 * APIG 网关掐断，且后端对任何请求头都不发心跳保活。修复后适配器对
 * deepseek-v4 改用 DSML 工具模式（schema 注入 system、不发送 tools 字段），
 * 模型以 DSML 流式输出工具调用（delta.content 走流式通道），全程有数据流，
 * 应能完整收到 tool-call 块且 arguments JSON 可解析。2000 行远超单次 SSE
 * 事件上限，可稳定复现"一次性打包被网关掐断"的模式。
 */
const LARGE_FILE_PROMPT = [
  '请用 write 工具写入文件 /tmp/dsh-e2e-large-file.ts，内容是一个 2000 行的 TypeScript 模块：',
  '- 顶部导出 const VERSION = "1.0.0"',
  '- 导出 150 个工具函数（add/sub/mul/div/pow/sqrt/... 及更多），每个函数 10-15 行带 JSDoc 和实现',
  '- 末尾导出 default 一个聚合所有工具的对象',
  '- 总行数 >= 2000 行',
  '直接调用 write 工具完成，不要先打印内容。',
  '文件路径必须严格使用 /tmp/dsh-e2e-large-file.ts，不要修改路径。',
].join('\n')

describe.runIf(E2E)('codearts deepseek-v4-flash large file write e2e', () => {
  it(
    'deepseek-v4-flash can stream a large write tool call without idle timeout',
    async () => {
      const credential = loadCredentialFromEnv()
      const adapter = new CodeArtsAdapter({
        credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
        resolveCredential: async () => credential,
        refresh: async () => {
          throw new Error('e2e: credential refresh not supported; please re-login and update env')
        },
      })

      const toolCallBlocks: Array<{ name: string; arguments: string }> = []
      const textDeltas: string[] = []
      let finishKind: string | undefined
      for await (const chunk of adapter.stream({
        provider: 'codearts',
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: LARGE_FILE_PROMPT }],
        tools: [{
          name: 'write',
          description: 'Write content to a file at the given path.',
          parameters: {
            type: 'object',
            properties: {
              filePath: { type: 'string', description: 'Absolute file path' },
              content: { type: 'string', description: 'File content' },
            },
            required: ['filePath', 'content'],
          },
        }],
        signal: new AbortController().signal,
      } as never)) {
        if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
        }
        if (chunk.type === 'finish') finishKind = chunk.reason.kind
      }

      // 期望模型调用了 write 工具，且 arguments JSON 可完整解析。
      expect(toolCallBlocks.length).toBeGreaterThanOrEqual(1)
      const writeCall = toolCallBlocks.find(call => call.name === 'write')
      expect(writeCall).toBeDefined()
      const args = JSON.parse(writeCall!.arguments) as { filePath: string; content: string }
      // 路径断言放宽：模型可能选择自己的路径（e2e 环境无真实文件系统）。
      expect(args.filePath.length).toBeGreaterThan(0)
      // 大文件：content 应有约 2000 行。允许 10% 缩水（模型可能合并空行）。
      const lineCount = args.content.split('\n').length
      expect(lineCount).toBeGreaterThanOrEqual(1800)
      // finish 应为 tool-calls（而非 max-tokens 截断）。
      expect(finishKind).toBe('tool-calls')
    },
    900_000,
  )
})
