import { createInterface } from 'node:readline'

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function error(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

/** Run a dependency-free MCP stdio server over newline-delimited JSON-RPC. */
export function serve({ name, version, tools, callTool }) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', async (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      error(null, -32700, 'Invalid JSON')
      return
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return
    if (!Object.hasOwn(message, 'id')) return
    const id = message.id
    try {
      if (message.method === 'initialize') {
        const protocolVersion = typeof message.params?.protocolVersion === 'string'
          ? message.params.protocolVersion
          : '2025-11-25'
        write({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name, version },
          },
        })
        return
      }
      if (message.method === 'ping') {
        write({ jsonrpc: '2.0', id, result: {} })
        return
      }
      if (message.method === 'tools/list') {
        write({ jsonrpc: '2.0', id, result: { tools } })
        return
      }
      if (message.method === 'tools/call') {
        const toolName = message.params?.name
        if (typeof toolName !== 'string') {
          error(id, -32602, 'Tool name is required')
          return
        }
        const args = message.params?.arguments
        const result = await callTool(toolName, args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {})
        write({ jsonrpc: '2.0', id, result })
        return
      }
      error(id, -32601, `Unsupported method: ${String(message.method)}`)
    } catch (cause) {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: cause instanceof Error ? cause.message : String(cause) }],
        },
      })
    }
  })
}
