import * as React from 'react'

/** 手机和电脑共用的手机号登录界面。验证码只留在输入框，不写本地存储。 */
export function AutoclawLogin({ rpcCall, onClose, onSuccess }) {
  const phoneRef = React.useRef(null)
  const codeRef = React.useRef(null)
  const session = React.useRef(null)
  const live = React.useRef(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [sent, setSent] = React.useState(false)
  const [seconds, setSeconds] = React.useState(0)
  React.useEffect(() => {
    live.current = true
    const timer = setInterval(() => setSeconds(n => Math.max(0, n - 1)), 1000)
    return () => {
      live.current = false
      clearInterval(timer)
      if (session.current) void rpcCall('autoclaw.cancel', { accountId: session.current }).catch(() => {})
      if (codeRef.current) codeRef.current.value = ''
    }
  }, [])
  const run = async login => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const phone = phoneRef.current?.value.trim() ?? ''
      if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('请输入 11 位有效手机号')
      if (!session.current) {
        const result = await rpcCall('account.create', { provider: 'autoclaw' })
        session.current = result.accountId
        if (!live.current) { await rpcCall('autoclaw.cancel', { accountId: result.accountId }); return }
      }
      if (login) {
        const result = await rpcCall('autoclaw.login', { accountId: session.current, phone, code: codeRef.current?.value.trim() ?? '' })
        if (codeRef.current) codeRef.current.value = ''
        session.current = null
        if (live.current) onSuccess(result)
      } else {
        await rpcCall('autoclaw.sendSms', { accountId: session.current, phone })
        if (live.current) { setSent(true); setSeconds(60) }
      }
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : '登录失败，请重试') }
    finally { if (live.current) setBusy(false) }
  }
  const h = React.createElement
  return h('div', { className: 'dim-jh-modalOverlay dim-jh-modalOverlay--top', style: { padding: 12, boxSizing: 'border-box' }, onClick: e => { if (e.target === e.currentTarget && !busy) onClose() } },
    h('section', { className: 'dim-jh-modal', role: 'dialog', 'aria-modal': true, 'aria-label': '登录 AutoClaw', style: { width: 'min(440px, 100%)', boxSizing: 'border-box', maxHeight: 'calc(100dvh - 24px)', overflowY: 'auto' } },
      h('div', { className: 'dim-jh-modalHead' }, h('strong', null, '登录 AutoClaw（澳龙）'), h('button', { className: 'dim-jh-btn', style: { minHeight: 44 }, disabled: busy, onClick: onClose, 'aria-label': '关闭登录' }, '关闭')),
      h('form', { className: 'dim-jh-modalBody', onSubmit: e => { e.preventDefault(); void run(true) }, style: { padding: '20px 0 0', display: 'grid', gap: 16 } },
        h('p', { className: 'dim-jh-hint' }, '使用你自己的智谱 AutoClaw 账号。登录后读取该账号的模型和积分，手机可独立使用。'),
        h('label', { style: { display: 'grid', gap: 8 } }, '手机号', h('input', { ref: phoneRef, type: 'tel', inputMode: 'tel', autoComplete: 'tel-national', placeholder: '输入手机号', maxLength: 11, disabled: busy, required: true, style: { width: '100%', boxSizing: 'border-box', padding: 12, fontSize: 16, border: '1px solid #ddd', borderRadius: 10 }, onChange: () => setSent(false) })),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('input', { ref: codeRef, type: 'text', inputMode: 'numeric', autoComplete: 'one-time-code', 'aria-label': '短信验证码', placeholder: '短信验证码', maxLength: 8, disabled: busy, style: { flex: '1 1 120px', minWidth: 0, padding: 12, fontSize: 16, border: '1px solid #ddd', borderRadius: 10 } }),
          h('button', { type: 'button', className: 'dim-jh-btn', style: { minHeight: 44 }, disabled: busy || seconds > 0, onClick: () => void run(false) }, seconds ? `${seconds} 秒后重发` : '获取验证码')),
        sent ? h('p', { role: 'status', className: 'dim-jh-hint' }, '验证码已发送，请查看短信。') : null,
        error ? h('p', { role: 'alert', style: { color: '#c33', overflowWrap: 'anywhere' } }, error) : null,
        h('button', { type: 'submit', className: 'dim-jh-btn', style: { minHeight: 44 }, 'data-kind': 'primary', disabled: busy || !sent }, busy ? '处理中…' : '登录并添加账号'),
        h('p', { className: 'dim-jh-hint' }, '继续登录表示你同意 AutoClaw 的 ', h('a', { href: 'https://autoglm.aminer.cn/web/md2html/index.html?md=autoclaw_agreement&favicon=autoglm', target: '_blank', rel: 'noopener noreferrer' }, '用户协议'), ' 和 ', h('a', { href: 'https://autoglm.aminer.cn/web/md2html/index.html?md=autoclaw_privacy&favicon=autoglm', target: '_blank', rel: 'noopener noreferrer' }, '隐私政策'), '。'))))
}
