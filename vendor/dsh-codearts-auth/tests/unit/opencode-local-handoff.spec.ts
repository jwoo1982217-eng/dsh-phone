import { describe, expect, it } from 'vitest'
import { captureNativeTool, nativeShellForTools } from '../../src/opencode-local-handoff.js'

const shellParameters = { type: 'object', properties: {
  command: { type: 'string' }, description: { type: 'string' }, timeoutMs: { type: 'number' }, workdir: { type: 'string' },
}, required: ['command', 'description'] }
const tools = [
  { name: 'bash', description: 'Bash', parameters: shellParameters },
  { name: 'pwsh', description: 'PowerShell', parameters: shellParameters },
  { name: 'read', description: '读取', parameters: { type: 'object', properties: {
    file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' },
  }, required: ['file_path'] } },
]
const request = { sessionID: 'ses_qa', permission: 'bash', tool: { messageID: 'msg_qa', callID: 'call_qa' } }
const message = (tool: string, input: any, extra = {}) => ({ parts: [{ type: 'tool', sessionID: 'ses_qa',
  messageID: 'msg_qa', callID: 'call_qa', tool, state: { status: 'running', input }, ...extra }] })
const bash = { path: '/bin/bash', tool: 'bash' as const }

describe('OpenCode 挂起工具转交', () => {
  it('Windows显式选择与DSH一致的PowerShell，保持中文路径和命令语言', () => {
    const shell = nativeShellForTools(tools, 'win32', { ProgramFiles: 'D:\\程序', Path: '"D:\\命令"', SystemRoot: 'C:\\Windows' }, file => file === 'D:\\命令\\pwsh.exe')
    expect(shell).toEqual({ path: 'D:\\命令\\pwsh.exe', tool: 'pwsh' })
    const args = { command: 'Get-Location; git status --short', description: '检查仓库', workdir: 'C:\\用户\\工作区', timeout: 12000 }
    expect(captureNativeTool(request, message('bash', args), 'ses_qa', tools, shell)).toEqual({ name: 'pwsh', arguments: {
      command: args.command, description: args.description, workdir: args.workdir, timeoutMs: 12000,
    } })
  })
  it('Windows先选PowerShell7，缺失时选系统5.1；没有实际shell时不猜执行语言', () => {
    const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' }
    expect(nativeShellForTools(tools, 'win32', env, () => true)?.path).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(nativeShellForTools(tools, 'win32', env, file => file.includes('System32'))?.path).toContain('WindowsPowerShell\\v1.0\\powershell.exe')
    expect(nativeShellForTools(tools, 'win32', env, () => false)).toBeUndefined()
    expect(captureNativeTool(request, message('bash', { command: 'pwd', description: '检查' }), 'ses_qa', tools)).toBeUndefined()
  })
  it('Android使用实际捆绑shell，Bash参数按DSH超时字段转交', () => {
    expect(nativeShellForTools(tools, 'android', { DSH_PHONE_SHELL: '/app/libbash.so' }, p => p === '/app/libbash.so')).toEqual({ path: '/app/libbash.so', tool: 'bash' })
    expect(captureNativeTool(request, message('bash', { command: 'pwd', description: '检查', timeout: 5000 }), 'ses_qa', tools, bash))
      .toEqual({ name: 'bash', arguments: { command: 'pwd', description: '检查', timeoutMs: 5000 } })
  })
  it('目录权限挂起的read保留路径，原生offset0按第一行转交', () => {
    expect(captureNativeTool({ ...request, permission: 'external_directory' }, message('read', { filePath: '/仓库/a.md', offset: 0, limit: 10 }), 'ses_qa', tools))
      .toEqual({ name: 'read', arguments: { file_path: '/仓库/a.md', offset: 1, limit: 10 } })
  })
  it('只接受当前会话、消息、调用ID及仍被挂起的工具，不重复已完成的执行', () => {
    const input = { command: 'pwd', description: '检查' }
    for (const extra of [{ sessionID: 'ses_other' }, { messageID: 'msg_other' }, { callID: 'call_other' },
      { state: { status: 'completed', input, output: 'already executed' } }, { state: { status: 'pending', input } }])
      expect(captureNativeTool(request, message('bash', input, extra), 'ses_qa', tools, bash)).toBeUndefined()
    expect(captureNativeTool({ ...request, sessionID: 'ses_other' }, message('bash', input), 'ses_qa', tools, bash)).toBeUndefined()
    expect(captureNativeTool({ ...request, permission: 'read' }, message('bash', input), 'ses_qa', tools, bash)).toBeUndefined()
  })
  it('不丢掉额外参数、不加入提权参数、不补缺失必填项', () => {
    for (const input of [{ command: 'pwd' }, { command: '', description: '检查' },
      { command: 'pwd', description: '检查', sandbox_permissions: 'require_escalated' },
      { command: 'pwd', description: '检查', timeout: -1 }, { command: 'pwd', description: '检查', timeout: '100' }])
      expect(captureNativeTool(request, message('bash', input), 'ses_qa', tools, bash)).toBeUndefined()
    expect(captureNativeTool(request, message('bash', { command: 'pwd', description: '检查' }), 'ses_qa', tools.filter(t => t.name !== 'bash'), bash)).toBeUndefined()
    for (const input of [{ filePath: 'a', limit: 0 }, { filePath: 'a', offset: -1 }, { filePath: 'a', offset: 1.5 }, { filePath: 'a', encoding: 'utf8' }])
      expect(captureNativeTool({ ...request, permission: 'read' }, message('read', input), 'ses_qa', tools)).toBeUndefined()
  })
})
