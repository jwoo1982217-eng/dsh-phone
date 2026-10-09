/**
 * Gemini `thoughtSignature` 缓存单测。
 *
 * 守的是两件**静默失败**：
 * 1. 键算法漂移（换算法 ⇒ 已有缓存全失配 ⇒ 每轮都去签重试，不报错）；
 * 2. 坏文件把整个进程的命中率打回 0（必须降级为空表，而不是抛错）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GEMINI_SIG_FILE,
  GeminiSigStore,
  createGeminiSigStore,
  geminiSigKey,
  geminiToolSigKey,
} from '../../src/gemini-sigstore.js'
import { canonicalArgs } from '../../src/gemini-messages.js'

let dir: string
let previousDir: string | undefined

beforeEach(() => {
  previousDir = process.env.DSH_JET_HUB_STATE_DIR
  dir = mkdtempSync(join(tmpdir(), 'dsh-gemini-sigs-'))
  process.env.DSH_JET_HUB_STATE_DIR = dir
})

afterEach(() => {
  if (previousDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = previousDir
  rmSync(dir, { recursive: true, force: true })
})

const filePath = (): string => join(dir, 'jet-hub', GEMINI_SIG_FILE)
const noop = { warn: () => {} }

describe('键算法', () => {
  it('键为 16 字符十六进制，前缀角色参与哈希', () => {
    const key = geminiToolSigKey('read_file', '{"path":"a.go"}')
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    expect(geminiSigKey('tool:read_file', '{"path":"a.go"}')).toBe(key)
    expect(geminiSigKey('tool:write_file', '{"path":"a.go"}')).not.toBe(key)
  })

  it('两侧规范化一致时才命中（canonicalArgs 是唯一口径）', () => {
    const store = new GeminiSigStore(undefined, noop)
    store.put('read_file', canonicalArgs({ path: 'a.go', mode: 'r' }), 'SIG')
    expect(store.get('read_file', canonicalArgs({ mode: 'r', path: 'a.go' }))).toBe('SIG')
  })
})

describe('读写', () => {
  it('空签名不入缓存（上游下发空串占位时不能当成有签名）', () => {
    const store = new GeminiSigStore(undefined, noop)
    store.put('f', '{}', '')
    store.put('f', '{}', '   ')
    expect(store.size).toBe(0)
    expect(store.get('f', '{}')).toBeUndefined()
  })

  it('落盘后重新载入仍能命中；createGeminiSigStore 落 $DSH_HOME/jet-hub/gemini-sigs.json', async () => {
    const first = new GeminiSigStore(filePath(), noop)
    first.put('read_file', '{"path":"a.go"}', 'SIG_FC')
    await first.flush()

    const second = new GeminiSigStore(filePath(), noop)
    expect(second.get('read_file', '{"path":"a.go"}')).toBe('SIG_FC')

    // home 解析走 resolveJetHubHome，与 state.json 同目录但是**独立文件**
    const viaHome = createGeminiSigStore({ logger: noop } as never)
    viaHome.put('f', '{}', 'SIG')
    void viaHome.flush()
    expect(JSON.parse(readFileSync(filePath(), 'utf-8'))).toMatchObject({
      [geminiToolSigKey('read_file', '{"path":"a.go"}')]: { sig: 'SIG_FC' },
      [geminiToolSigKey('f', '{}')]: { sig: 'SIG' },
    })
  })

  it('坏文件降级为空表并 warn（纯缓存，不抛错）', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(filePath(), '{ not json', 'utf-8')
    const warnings: string[] = []
    const store = new GeminiSigStore(filePath(), { warn: (message) => warnings.push(message) })
    expect(store.size).toBe(0)
    expect(warnings.some((message) => message.includes('签名缓存文件损坏'))).toBe(true)
  })
})

/**
 * 参数漂移兜底（`latestForTool`）。
 *
 * ## 守的是什么
 *
 * 精确键 = `sha256("tool:"+name+"\0"+args)[:16]`，**参数逐字相同**才命中。
 * 长任务里参数漂移是**必然事件**（绝对路径变、时间戳变、上游归一化过参数），
 * 一旦 miss 就只能走去签重试 —— 而那条路会把**整条思考链丢掉**。
 *
 * 没有这层兜底时，`lookupSignature` 直接返回 `undefined`，表现是「每轮都去签
 * 重试」且不报任何错。
 */
describe('参数漂移兜底 latestForTool', () => {
  it('★ 参数漂移时按工具名取最近一次；工具名之间互不串味', () => {
    const store = new GeminiSigStore(undefined, noop)
    store.put('read_file', '{"path":"/a/old.go"}', 'SIG-OLD')
    store.put('read_file', '{"path":"/a/new.go"}', 'SIG-NEW')
    store.put('write_file', '{}', 'SIG-WRITE')

    // 参数漂移 ⇒ 精确键必然 miss
    expect(store.get('read_file', '{"path":"/b/other.go"}')).toBeUndefined()
    // 兜底命中，且取的是**最近**一次（不是最早）
    expect(store.latestForTool('read_file')).toBe('SIG-NEW')
    // 按工具名隔离 —— 不能把 A 工具的签名给 B
    expect(store.latestForTool('write_file')).toBe('SIG-WRITE')
    // 没见过的工具名返回 undefined（上层据此走去签重试）
    expect(store.latestForTool('never_seen')).toBeUndefined()

    // 空签名不参与兜底（上游下发的空串占位不该被回填）
    store.put('empty_tool', '{}', '   ')
    expect(store.latestForTool('empty_tool')).toBeUndefined()
  })

  it('★ 工具名跨重启仍在（必须持久化 name，键是 sha256 不可逆）', async () => {
    const first = new GeminiSigStore(filePath(), noop)
    first.put('read_file', '{"path":"/a/one.go"}', 'SIG-PERSIST')
    await first.flush()

    const second = new GeminiSigStore(filePath(), noop)
    // 换一个参数（精确键必然 miss），只能靠持久化的 name 命中
    expect(second.get('read_file', '{"path":"/different.go"}')).toBeUndefined()
    expect(second.latestForTool('read_file')).toBe('SIG-PERSIST')
  })

  it('★ 旧版条目（无 name 字段）仍能按精确键命中，只是不进索引', () => {
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    const key = geminiToolSigKey('read_file', '{"path":"legacy.go"}')
    writeFileSync(filePath(), JSON.stringify({ [key]: { sig: 'SIG-LEGACY', at: 1 } }), 'utf-8')

    const store = new GeminiSigStore(filePath(), noop)
    expect(store.get('read_file', '{"path":"legacy.go"}')).toBe('SIG-LEGACY')
    // 降级：索引里没有它（这是可接受的，新写入会补上）
    expect(store.latestForTool('read_file')).toBeUndefined()
  })
})
