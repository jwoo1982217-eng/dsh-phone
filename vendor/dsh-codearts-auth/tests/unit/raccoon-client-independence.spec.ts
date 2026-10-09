/**
 * 脱离客户端的架构约束（**回归防线**）。
 *
 * ## 为什么需要这组用例
 *
 * 用户明确的架构要求：**「尽量避免依赖客户端的数据，最好能脱离客户端也能成功」**。
 *
 * raccoon 客户端（商汤小浣熊）会在本机留下大量可用数据 ——
 * `%APPDATA%\office-raccoon\Local Storage\leveldb` 里有登录态、
 * `~/.box-agent/config/auth.json` 里有 token、安装目录里有产品配置。
 * 这些对**逆向取证**极其方便，但作为**运行时依赖**是错的：
 *
 * 1. **客户端退出会删除 `auth.json`**（实测），token 随即失效；
 * 2. **客户端每次重启都轮换整组凭据**（实测：`exp` 未过期的 token 被 401 拒绝，
 *    对照进程启动时间可确认轮换），故从客户端抓的凭据寿命不可控；
 * 3. 用户可能**根本没装客户端** —— 那不该导致 provider 不可用。
 *
 * 故本文件用**源码扫描**锁死：`src/raccoon*.ts` 里不得出现任何
 * 客户端路径 / 文件读取 / 环境变量的**运行时**引用（注释里解释「为何不这么做」
 * 是允许且鼓励的）。
 *
 * ⚠️ 用源码扫描而不是运行时 mock：这类约束的失效方式恰恰是
 * 「某次改动悄悄加了一个 readFileSync 兜底」，mock 测不出来。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 所有 raccoon 运行时源码文件。 */
function raccoonSourceFiles(): Array<{ name: string; text: string }> {
  const dir = join(import.meta.dirname, '..', '..', 'src')
  const files = readdirSync(dir).filter((f) => f.startsWith('raccoon') && f.endsWith('.ts'))
  return files.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
}

/**
 * 逐行剥掉注释，只留可执行代码。
 *
 * 简化实现：去掉整行注释（`*` 开头、`//` 开头）与行尾 `//` 注释。
 * 对「注释里提到 office-raccoon、但代码里不引用」这一常见情形足够。
 * 块注释里以 `*` 开头的行都会被去掉，不会误报。
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//')
    })
    .map((line) => {
      const idx = line.indexOf('//')
      return idx >= 0 ? line.slice(0, idx) : line
    })
    .join('\n')
}

describe('raccoon 运行时零客户端依赖', () => {
  const files = raccoonSourceFiles()

  it('至少扫到预期的源码文件（防止扫描逻辑失效而恒真）', () => {
    // 若将来重命名/拆分了文件，这条会失败并提醒更新断言 ——
    // 否则下面的扫描可能「一个文件都没扫到」而静默通过。
    expect(files.length).toBeGreaterThanOrEqual(6)
    const names = files.map((f) => f.name)
    expect(names).toContain('raccoon.ts')
    expect(names).toContain('raccoon-product.ts')
    expect(names).toContain('raccoon-oauth.ts')
    expect(names).toContain('raccoon-login-page.ts')
    expect(names).toContain('raccoon-auth.ts')
    expect(names).toContain('raccoon-credits.ts')
  })

  it('不引用客户端安装目录或数据目录', () => {
    for (const { name, text } of files) {
      const code = stripComments(text)
      for (const banned of ['raccoon-ai', 'office-raccoon', 'box-agent']) {
        expect(code, `${name} 不得在代码里引用 ${banned}`).not.toContain(banned)
      }
    }
  })

  it('不读取任何环境变量（APPDATA / LOCALAPPDATA / USERPROFILE / HOME）', () => {
    for (const { name, text } of files) {
      const code = stripComments(text)
      for (const banned of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'process.env.HOME']) {
        expect(code, `${name} 不得读取 ${banned}`).not.toContain(banned)
      }
    }
  })

  it('不做任何文件系统读取（readFileSync / readdirSync / existsSync / createReadStream）', () => {
    for (const { name, text } of files) {
      const code = stripComments(text)
      for (const banned of ['readFileSync', 'readdirSync', 'existsSync', 'createReadStream', 'node:fs']) {
        expect(code, `${name} 不得使用 ${banned}`).not.toContain(banned)
      }
    }
  })

  it('不解析 leveldb / sqlite / 客户端本地数据库', () => {
    for (const { name, text } of files) {
      const code = stripComments(text)
      for (const banned of ['leveldb', 'sqlite', 'Local Storage', 'IndexedDB']) {
        expect(code, `${name} 不得引用 ${banned}`).not.toContain(banned)
      }
    }
  })

  it('凭据只经 ctx.credentials 读写（不经文件）', () => {
    const auth = files.find((f) => f.name === 'raccoon-auth.ts')
    expect(auth).toBeDefined()
    const code = auth?.text ?? ''
    // 有 credentials 的注入使用
    expect(code).toContain('this.ctx.credentials.set')
    expect(code).toContain('this.ctx.credentials.resolve')
    // 且没有任何文件写入
    expect(stripComments(code)).not.toContain('writeFileSync')
  })
})

describe('客户端仅用于逆向取证，不是运行时前置条件', () => {
  it('源码里的 office-raccoon 只出现在注释中（解释为何不用官方链路）', () => {
    const files = raccoonSourceFiles()
    const withMention = files.filter((f) => f.text.includes('office-raccoon'))
    // 应当有文件提到它（作为设计说明），但提到它的文件在剥离注释后都不含它
    expect(withMention.length).toBeGreaterThan(0)
    for (const { name, text } of withMention) {
      expect(stripComments(text), `${name} 的 office-raccoon 必须只在注释里`).not.toContain('office-raccoon')
    }
  })
})
