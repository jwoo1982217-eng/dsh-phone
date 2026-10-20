/**
 * ★ 防回退锁：**插件不再读取本机 ZCode 客户端的数据**（2026-10-05 用户决策）。
 *
 * ## 为什么要「静态扫源码」而不是只测运行时行为
 *
 * 被删掉的那套能力（解密 `~/.zcode/v2/credentials.json`、读 `telemetry-state.json`
 * 的 `deviceMid`、探测安装目录的 app version）在**没有**对应导出后，
 * 运行时测试无从断言「它没有被重新加回来」—— 一个新写的
 * `readZcodeCredentialFromDisk()` 不会让任何现有用例变红。
 *
 * ⇒ 这里改成**扫源码字面量**：只要有人重新引入对本机 ZCode 路径/密钥的
 * 读取，本文件立刻变红。这比「函数不存在」更难绕过。
 *
 * ## 为什么这条锁值钱（**别删**）
 *
 * 那套读取等价于「任何本地进程都能解密 ZCode 的登录凭据」：官方用
 * `zcode-credential-fallback:<平台>:<家目录>:<用户名>` 过 `sha256` 派生
 * AES-256-GCM 密钥，算法是**公开可复现**的。把它复制进 DSH 意味着
 * DSH 具备读取用户**另一个应用**登录态的能力 —— 而插件本来就有
 * 自己完整的 OAuth 流程（`zcode-login.ts`），走那条路就够了。
 *
 * 详见 `src/zcode.ts` 文件头的完整理由。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as zcodeModule from '../../src/zcode.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** 读一份源码（相对 `src/`）。 */
function src(name: string): string {
  return readFileSync(join(SRC_DIR, name), 'utf8')
}

describe('★ 不读本机 ZCode 数据（防回退）', () => {
  it('src/zcode.ts 不再导出任何「读本机文件」的函数', () => {
    const exported = zcodeModule as Record<string, unknown>
    for (const gone of [
      'readZcodeCredential',
      'resolveZcodeCredential',
      'readRawCredentials',
      'readDeviceMid',
      'detectZcodeAppVersion',
      'decryptCredentialValue',
      'deriveCredentialKey',
      'credentialFileCandidates',
      'resolveCredentialFilePath',
      'pickCredential',
      'labelFromUserInfo',
      'identityFromUserInfo',
      'readUserIdFromUserInfo',
    ]) {
      expect(exported[gone], `src/zcode.ts 不该再导出 ${gone}`).toBeUndefined()
    }
  })

  it('★ 源码里不再出现本机 ZCode 数据路径（`.zcode/v2/…`）', () => {
    // 扫全部 src 文件：任何一处重新读本机客户端数据都会命中。
    const files = [
      'zcode.ts', 'zcode-auth.ts', 'jet-hub-rpc.ts', 'zcode-login.ts',
      'zcode-product.ts', 'zcode-transport.ts', 'zcode-upstream.ts',
      'zcode-adapter.ts', 'zcode-captcha.ts', 'index.ts',
    ]
    const hits: string[] = []
    for (const file of files) {
      const text = src(file)
      // 去掉块注释与行注释后再匹配，否则本文件自身的说明文字会造成误报。
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
      if (/\.zcode[\\/]v\d/.test(code) || /credentials\.json/.test(code)
        || /telemetry-state\.json/.test(code) || /zcode-install-manifest/.test(code)) {
        hits.push(file)
      }
    }
    expect(hits, `这些文件又去读本机 ZCode 数据了：${hits.join(', ')}`).toEqual([])
  })

  it('★ 源码里不再出现官方凭据的派生密钥与密文前缀', () => {
    const files = ['zcode.ts', 'zcode-auth.ts', 'jet-hub-rpc.ts', 'zcode-login.ts']
    const hits: string[] = []
    for (const file of files) {
      const code = src(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
      if (/zcode-credential-fallback/.test(code)
        || /enc:v1:/.test(code)
        || /ZCODE_CREDENTIAL_SECRET/.test(code)
        || /aes-256-gcm/.test(code)) {
        hits.push(file)
      }
    }
    expect(hits, `这些文件又带上了官方凭据的解密能力：${hits.join(', ')}`).toEqual([])
  })

  it('ZcodeAuth 不再接受 readCredential 注入点，也不再有 adopt 系列', () => {
    const code = src('zcode-auth.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    // ⚠ 必须用**词边界**：仓里仍有 `readStoredCredential` / `readCredentialFromRef` /
    //   `readCredentialFromPool` 这三个合法方法（它们只读 `ctx.credentials`，
    //   不碰磁盘），裸 `/readCredential/` 会把它们一起误报。
    expect(code).not.toMatch(/\breadCredential\b/)
    expect(code).not.toMatch(/\blocalCredential\b/)
    expect(code).not.toMatch(/\badoptOfficialCredential\b|\badoptIntoOrphanAccount\b/)
  })
})
