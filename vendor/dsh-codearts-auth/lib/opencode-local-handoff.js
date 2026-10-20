import { lstatSync } from 'node:fs';
import path from 'node:path';
/** 原生工具描述必须与 DSH 执行语言一致，不能把 Bash 命令直接交给 PowerShell。 */
export function nativeShellForTools(tools, platform = process.platform, env = process.env, exists = (file) => {
    try {
        const stat = lstatSync(file);
        return stat.isFile() || stat.isSymbolicLink();
    }
    catch {
        return false;
    }
}) {
    const search = Object.keys(env).filter(key => key.toLowerCase() === 'path').map(key => env[key]).join(platform === 'win32' ? ';' : ':');
    if (platform === 'win32' && tools.some(tool => tool.name === 'pwsh')) {
        // 与 DSH pwsh-local 默认顺序一致：PowerShell 7、PATH、系统 5.1。
        const candidates = [path.win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell/7/pwsh.exe'),
            ...search.split(';').map(value => value.trim().replace(/^"|"$/g, '')).filter(Boolean).map(value => path.win32.join(value, 'pwsh.exe')),
            path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')];
        const shell = candidates.find(exists);
        return shell ? { path: shell, tool: 'pwsh' } : undefined;
    }
    if (tools.some(tool => tool.name === 'bash')) {
        const candidates = [env.DSH_PHONE_SHELL, '/bin/bash', ...search.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'bash'))];
        const shell = candidates.find((file) => !!file && exists(file));
        return shell ? { path: shell, tool: 'bash' } : undefined;
    }
    return undefined;
}
/** 只接受仍被原生权限请求挂起、与本次会话及调用 ID 对应的输入；不放行原生执行。 */
export function captureNativeTool(request, message, sessionId, tools, shell) {
    if (request?.sessionID !== sessionId || !['bash', 'read', 'external_directory'].includes(request.permission) ||
        typeof request.tool?.messageID !== 'string' || typeof request.tool?.callID !== 'string')
        return undefined;
    const part = message?.parts?.find((part) => part.type === 'tool' && part.sessionID === sessionId &&
        part.messageID === request.tool.messageID && part.callID === request.tool.callID);
    if (!part || part.state?.status !== 'running' || !['bash', 'read'].includes(part.tool))
        return undefined;
    if (request.permission !== 'external_directory' && request.permission !== part.tool)
        return undefined;
    const input = part.state.input;
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return undefined;
    const name = part.tool === 'bash' ? shell?.tool : 'read';
    const tool = tools.find(tool => tool.name === name);
    const properties = tool?.parameters?.properties;
    if (!tool || !properties)
        return undefined;
    const result = {};
    if (part.tool === 'bash') {
        if (Object.keys(input).some(key => !['command', 'description', 'timeout', 'workdir'].includes(key)) ||
            typeof input.command !== 'string' || !input.command.trim())
            return undefined;
        result.command = input.command;
        if (typeof input.description === 'string')
            result.description = input.description;
        if (input.timeout !== undefined) {
            if (!Number.isFinite(input.timeout) || input.timeout <= 0)
                return undefined;
            const key = 'timeoutMs' in properties ? 'timeoutMs' : 'timeout' in properties ? 'timeout' : undefined;
            if (!key)
                return undefined;
            result[key] = input.timeout;
        }
        if (input.workdir !== undefined) {
            if (typeof input.workdir !== 'string')
                return undefined;
            result.workdir = input.workdir;
        }
    }
    else {
        if (Object.keys(input).some(key => !['filePath', 'offset', 'limit'].includes(key)) ||
            typeof input.filePath !== 'string' || !input.filePath.trim())
            return undefined;
        result.file_path = input.filePath;
        for (const key of ['offset', 'limit'])
            if (input[key] !== undefined) {
                if (!Number.isSafeInteger(input[key]) || input[key] < 0 || key === 'limit' && input[key] === 0)
                    return undefined;
                result[key] = key === 'offset' && input[key] === 0 ? 1 : input[key];
            }
    }
    // 对照当前调用的实际 schema；不能丢掉不认识的参数或替用户加入提权选项。
    if (Object.keys(result).some(key => !(key in properties)))
        return undefined;
    const required = tool.parameters?.required;
    if (Array.isArray(required) && required.some(key => typeof key !== 'string' || !(key in result)))
        return undefined;
    return { name: tool.name, arguments: result };
}
//# sourceMappingURL=opencode-local-handoff.js.map