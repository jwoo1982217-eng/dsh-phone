/**
 * `readQoderCredentialsFromDshStore` 的 **ref 前缀隔离**回归测试。
 *
 * ## 为什么单独锁这一件事
 *
 * 中国版复用国际版的凭据读取实现，只把 ref 前缀从 `QODER` 换成 `QODERCN`。
 * 而 `QODER` 是 `QODERCN` 的**字面前缀** —— 这类包含关系是「匹配串了」的高发形态：
 * 一旦匹配式写成 `QODER.*_ACCOUNT_` 或漏掉紧跟的 `_`，国际版探针就会把
 * 中国版账号当成自己的账号去续期/领取，症状是「两站互相把对方的凭据刷坏」，
 * 而两站 token 不通用，排查时看到的是毫无关系的另一条链路在报错。
 *
 * 这里用**离线临时 YAML 文件**（`options.path`）驱动，不碰真实 `~/.dsh`。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readQoderCredentialsFromDshStore } from '../e2e/qoder-credential.js'

/** 造一条合法的 Qoder 凭据 JSON（YAML 单引号标量形态）。 */
function credentialLine(ref: string, token: string): string {
  const json = JSON.stringify({ access_token: token, refresh_token: `rt-${token}`, machine_id: 'm-' + token })
  // YAML 单引号标量：内容里的单引号要写成 ''（本 fixture 不含撇号，直接包起来）
  return `${ref}: '${json}'`
}

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qoder-cred-refs-'))
  file = join(dir, '.credentials.yaml')
  // 环境变量优先级最高，必须清干净，否则会读到开发机真实凭据而假失败。
  delete process.env.DSH_QODER_CREDENTIAL_JSON
  delete process.env.DSH_QODERCN_CREDENTIAL_JSON
  delete process.env.DSH_QODER_ACCOUNT_REF
  delete process.env.DSH_QODERCN_ACCOUNT_REF
})

afterEach(() => {
  delete process.env.DSH_QODER_CREDENTIAL_JSON
  delete process.env.DSH_QODERCN_CREDENTIAL_JSON
  delete process.env.DSH_QODER_ACCOUNT_REF
  delete process.env.DSH_QODERCN_ACCOUNT_REF
  rmSync(dir, { recursive: true, force: true })
})

describe('Qoder 系凭据的 ref 前缀隔离', () => {
  it('国际版前缀不会捞走中国版账号（QODER 是 QODERCN 的字面前缀）', () => {
    writeFileSync(
      file,
      [
        credentialLine('QODER_ACCOUNT_AAAA1111', 'intl-token'),
        credentialLine('QODERCN_ACCOUNT_BBBB2222', 'cn-token'),
      ].join('\n'),
      'utf8',
    )

    const intl = readQoderCredentialsFromDshStore({ path: file })
    expect(intl.map((e) => e.ref)).toEqual(['QODER_ACCOUNT_AAAA1111'])
    // 关键断言：中国版那条**没有**被国际版读走。
    expect(intl.some((e) => e.credential.access_token === 'cn-token')).toBe(false)
  })

  it('中国版前缀只读中国版账号', () => {
    writeFileSync(
      file,
      [
        credentialLine('QODER_ACCOUNT_AAAA1111', 'intl-token'),
        credentialLine('QODERCN_ACCOUNT_BBBB2222', 'cn-token'),
      ].join('\n'),
      'utf8',
    )

    const cn = readQoderCredentialsFromDshStore({ path: file, refPrefix: 'QODERCN' })
    expect(cn.map((e) => e.ref)).toEqual(['QODERCN_ACCOUNT_BBBB2222'])
    expect(cn[0]!.credential.access_token).toBe('cn-token')
  })

  it('缺省 refPrefix 等价于 QODER（国际版探针行为不变）', () => {
    writeFileSync(file, credentialLine('QODER_ACCOUNT_AAAA1111', 'intl-token'), 'utf8')
    const implicit = readQoderCredentialsFromDshStore({ path: file })
    const explicit = readQoderCredentialsFromDshStore({ path: file, refPrefix: 'QODER' })
    expect(implicit).toEqual(explicit)
  })

  it('池内无账号时各自回退到自己的默认 ref', () => {
    // 空文件：两边都应回退到 `<prefix>_ACCESS_TOKEN`，且解析失败后给出空列表
    // （而不是抛 ENOENT，也不是读到对方的 ref）。
    writeFileSync(file, 'UNRELATED_REF: \'{"access_token":"x"}\'\n', 'utf8')
    expect(readQoderCredentialsFromDshStore({ path: file })).toEqual([])
    expect(readQoderCredentialsFromDshStore({ path: file, refPrefix: 'QODERCN' })).toEqual([])
  })

  it('两个前缀各自读自己的直接凭据环境变量', () => {
    process.env.DSH_QODER_CREDENTIAL_JSON = JSON.stringify({ access_token: 'from-intl-env' })
    process.env.DSH_QODERCN_CREDENTIAL_JSON = JSON.stringify({ access_token: 'from-cn-env' })
    writeFileSync(file, '', 'utf8')

    expect(readQoderCredentialsFromDshStore({ path: file })[0]!.credential.access_token)
      .toBe('from-intl-env')
    expect(
      readQoderCredentialsFromDshStore({ path: file, refPrefix: 'QODERCN' })[0]!.credential.access_token,
    ).toBe('from-cn-env')
  })
})
