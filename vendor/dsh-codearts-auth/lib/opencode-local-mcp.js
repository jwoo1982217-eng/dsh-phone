import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
/** 原生 OpenCode 只生成调用；真正执行留给 DSH 的工具与权限管线。 */
export class OpencodeHarnessMcp {
    server;
    token = randomBytes(24).toString('hex');
    names = new Map();
    accepted = new Set();
    calls = [];
    called;
    notify;
    url = '';
    constructor(tools) {
        this.called = new Promise(resolve => { this.notify = resolve; });
        tools.forEach((tool, i) => this.names.set(`t${i}_${tool.name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)}`, tool));
    }
    async start() {
        this.server = createServer(async (request, response) => {
            if (request.url !== `/mcp/${this.token}`) {
                response.writeHead(404).end();
                return;
            }
            if (request.method === 'DELETE') {
                response.writeHead(200).end();
                return;
            }
            if (request.method !== 'POST') {
                response.writeHead(405).end();
                return;
            }
            try {
                let size = 0;
                const chunks = [];
                for await (const chunk of request) {
                    size += chunk.length;
                    if (size > 4 * 1024 * 1024)
                        throw Error('工具参数过大');
                    chunks.push(chunk);
                }
                const message = JSON.parse(Buffer.concat(chunks).toString());
                if (message.id === undefined) {
                    response.writeHead(202).end();
                    return;
                }
                let result;
                if (message.method === 'initialize') {
                    result = { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'DSH tools', version: '1.0' } };
                }
                else if (message.method === 'tools/list') {
                    result = { tools: [...this.names].map(([name, tool]) => ({ name, description: `${tool.name}: ${tool.description}`, inputSchema: tool.parameters ?? { type: 'object', properties: {} } })) };
                }
                else if (message.method === 'tools/call') {
                    const tool = this.names.get(message.params?.name ?? '');
                    const args = message.params?.arguments ?? {};
                    if (!tool || !args || typeof args !== 'object' || Array.isArray(args) || this.calls.length >= 32)
                        throw Error('工具请求无效');
                    const key = `${typeof message.id}:${message.id}`;
                    if (!this.accepted.has(key)) {
                        this.accepted.add(key);
                        this.calls.push({ name: tool.name, arguments: args });
                        this.notify();
                    }
                    // 不在 OpenCode 内执行，也不伪造成功的工具结果。
                    result = { isError: true, content: [{ type: 'text', text: '工具调用已交回 DSH；由 DSH 执行后继续下一轮。' }] };
                }
                else if (message.method === 'ping')
                    result = {};
                else {
                    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }));
                    return;
                }
                response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
            }
            catch {
                if (!response.headersSent)
                    response.writeHead(400);
                response.end();
            }
        });
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
        });
        const address = this.server.address();
        if (!address || typeof address === 'string')
            throw Error('本地工具连接未就绪');
        this.url = `http://127.0.0.1:${address.port}/mcp/${this.token}`;
    }
    async close() {
        if (!this.server)
            return;
        this.server.closeAllConnections();
        await new Promise(resolve => this.server.close(() => resolve()));
        this.server = undefined;
    }
}
//# sourceMappingURL=opencode-local-mcp.js.map