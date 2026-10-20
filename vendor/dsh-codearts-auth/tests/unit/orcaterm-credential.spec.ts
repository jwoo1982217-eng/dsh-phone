import { describe, expect, it } from 'vitest'
import { parseCredentialText } from '../../src/orcaterm-credential.js'

const jwt = 'eyJhbGciOiJub25lIn0.eyJ1c2VySWQiOiIxMjMifQ.test_signature'

describe('腾讯云登录回传', () => {
  it('multiweb 的 ot_session Cookie 与 JSON、裸 JWT 给出相同凭据', () => {
    const expected = { kind: 'desktop', otSession: jwt }
    for (const raw of [jwt, JSON.stringify({ ot_session: jwt }), `language=zh; ot_session=${jwt}; userId=123`]) {
      expect(parseCredentialText(raw)).toEqual(expected)
    }
  })
  it('网页 Cookie 保持纯 Cookie 认证，访客 Cookie 不冒充登录成功', () => {
    expect(parseCredentialText(`uin=o123; skey=sample; ot_session=${jwt}`)).toEqual({ kind: 'web', uin: 'o123', skey: 'sample', userId: '' })
    for (const raw of ['', 'qcloud_uid=visitor; language=zh', 'uin=o123; skey=', 'ot_session=invalid']) expect(parseCredentialText(raw)).toBeNull()
    expect(parseCredentialText('uin=o123; skey=sample')).toEqual({ kind: 'web', uin: 'o123', skey: 'sample', userId: '' })
  })
})
