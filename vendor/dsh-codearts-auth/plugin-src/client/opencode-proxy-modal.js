/**
 * opencode 账号的「设置出口代理」弹窗。
 *
 * ## 三类输入（设计文档 §3）
 *
 * - **本地代理客户端端口**：`http://127.0.0.1:7897`（Clash / mihomo 混合端口等）
 * - **HTTP(S) 代理**：`http[s]://host:port`，可带 `user:pass@`
 * - **SOCKS5**：`socks5://host:port`，可带认证
 *
 * 空 = 清除（账号回到「与其它无代理账号共享本机出口」）。
 *
 * ## 为什么在「同一 IP」这件事上要专门解释
 *
 * 一个 NAT 后的多台 PC 共享同一个公网出口 IP，而 OpenCode Zen 的匿名通道
 * **按出口 IP 限流** —— 所以「多账号」本身并不能把配额分开：不给代理时，
 * 所有账号（连同匿名通道）都在**同一个配额桶**里。这就是本弹窗存在的理由，
 * 提示语必须说清这一点，否则用户会以为「加了号就等于多了额度」。
 *
 * ⚠️ 本文件是**纯展示层**：合法性判断在宿主侧 `src/opencode.ts` 的
 * `normalizeProxy`。前端只做输入形态的便利解析（补 scheme、给端口预设），
 * 避免前后端两套规则漂移 —— 用户填错时以宿主返回的中文理由为准。
 */

// ⚠️ 必须用**命名空间导入**（与 jet-hub.js 逐字一致）：`react` 在 esbuild
// 配置里是 external，默认导入 `import React from 'react'` 在 CJS 产物里
// 会变成 `undefined`，渲染时炸「React.createElement is not a function」。
import * as React from 'react'

/** 常见本地代理端口预设（点一下就填好，省得手打）。 */
const LOCAL_PORT_PRESETS = [
  { port: 7897, label: '7897', url: 'http://127.0.0.1:7897', hint: 'Clash / mihomo 混合端口' },
  { port: 7890, label: '7890', url: 'http://127.0.0.1:7890', hint: 'Clash 旧版 HTTP 端口' },
  { port: 1080, label: '1080', url: 'socks5://127.0.0.1:1080', hint: 'SOCKS5' },
  { port: 10808, label: '10808', url: 'socks5://127.0.0.1:10808', hint: 'SOCKS5（v2rayN 等）' },
]

/** 从已存的 URL 反推初始选项卡。 */
function guessMode(url) {
  if (!url) return 'local'
  if (url.startsWith('socks5')) return 'socks5'
  if (url.includes('127.0.0.1') || url.includes('localhost')) return 'local'
  return 'http'
}

const MODES = [
  { id: 'local', label: '本地代理端口', hint: '本机已跑着 Clash / v2rayN 之类，直接填它的端口' },
  { id: 'http', label: 'HTTP(S)', hint: '形如 http://user:pass@host:port' },
  { id: 'socks5', label: 'SOCKS5', hint: '形如 socks5://user:pass@host:port' },
]

/**
 * 出口代理弹窗（**组件**，用 `React.createElement(OpencodeProxyModal, props)` 渲染）。
 *
 * ## ⚠️⚠️ 必须是组件、不能当普通函数直接调用（真实事故 2026-10-02）
 *
 * 本组件内部有 `useState`。若在 ProviderPanel 的渲染过程中**直接函数调用**
 * （`renderOpencodeProxyModal(props)`），它的 hook 会被算进 ProviderPanel ——
 * 于是「弹窗开」与「弹窗关」两次渲染的 hook 数量不同，React 抛 #310
 * （"Rendered more hooks than during the previous render"），**整个设置页白屏**。
 *
 * 仓库其它弹窗（`ModelListPanel` / `BackupPanel` / `ClineQuotaPanel`）都写成
 * `function Xxx() { ... }` + `React.createElement(Xxx, props)`，正是为此。
 *
 * @param props { ctx: { rpc(payload) }, accountId, current, onClose }
 */
export function OpencodeProxyModal({ ctx, accountId, current, onClose }) {
  const [mode, setMode] = React.useState(guessMode(current))
  const [url, setUrl] = React.useState(current || '')
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [error, setError] = React.useState('')
  const [result, setResult] = React.useState(null)

  const close = () => { if (onClose) onClose() }

  const save = async (value) => {
    setBusy(true)
    setError('')
    try {
      await ctx.rpc({ method: 'opencode.setProxy', payload: { accountId, proxy: value } })
      close()
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError('')
    setResult(null)
    try {
      const r = await ctx.rpc({ method: 'opencode.testProxy', payload: { proxy: url } })
      setResult(r)
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const activeHint = (MODES.find((m) => m.id === mode) || {}).hint || ''

  return React.createElement('div', {
    className: 'dim-jh-modalOverlay dim-jh-modalOverlay--top',
    onClick: (e) => { if (e.target === e.currentTarget) close() },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      style: { maxWidth: '520px' },
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' }, '设置出口代理'),
        React.createElement('span', { className: 'dim-jh-modalSubtitle' },
          current ? '当前：已配置' : '当前：直连（本机出口）'),
      ),
      // ⚠️ 这段提示是本功能的存在理由，必须说清「多账号 ≠ 多配额」。
      React.createElement('p', { className: 'dim-jh-modalHint' },
        'OpenCode 的免费通道按出口 IP 限流。不设代理时，本账号与其它未设代理的账号'
        + '（以及匿名通道）共用同一个出口，也就是共用同一份额度；设置代理后该账号走独立出口。'),
      // ⚠️ 内容必须放进 modalBody（flex:1; min-height:0; overflow-y:auto），
      // 否则弹窗较高时内容会被裁掉（见 jet-hub.js 既有 modal 的注释）。
      React.createElement('div', { className: 'dim-jh-modalBody' },
        React.createElement('div', { className: 'dim-jh-fieldRow' },
          MODES.map((m) => React.createElement('label', { key: m.id, className: 'dim-jh-radio' },
            React.createElement('input', {
              type: 'radio',
              name: 'opencode-proxy-mode',
              checked: mode === m.id,
              onChange: () => {
                setMode(m.id)
                setError('')
                setResult(null)
              },
            }),
            m.label,
          )),
        ),
        React.createElement('p', { className: 'dim-jh-hint' }, activeHint),
        mode === 'local' && React.createElement('div', { className: 'dim-jh-presetRow' },
          LOCAL_PORT_PRESETS.map((p) => React.createElement('button', {
            key: p.port,
            type: 'button',
            className: 'dim-jh-btn',
            title: p.hint,
            onClick: () => { setUrl(p.url); setError(''); setResult(null) },
          }, p.label)),
        ),
        React.createElement('input', {
          className: 'dim-jh-input',
          placeholder: mode === 'socks5' ? 'socks5://user:pass@host:port' : 'http://user:pass@host:port',
          value: url,
          // ⚠️ 含认证信息时用 password 类型：代理口令不该裸显在屏幕上。
          type: url.includes('@') ? 'password' : 'text',
          onChange: (e) => { setUrl(e.target.value); setResult(null) },
        }),
        result && React.createElement('p', { className: 'dim-jh-hint' },
          `出口 IP ${result.exitIp}（${result.country || '未知地区'}）· ${result.latencyMs}ms`),
        error && React.createElement('p', { className: 'dim-jh-error' }, error),
      ),
      React.createElement('div', { className: 'dim-jh-modalActions' },
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: testing || busy || url.trim().length === 0,
          onClick: test,
        }, testing ? '测试中…' : '测试连接'),
        // 只有已配置过才显示「清除」：没配过就没有可清除的东西。
        current ? React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: busy,
          onClick: () => save(''),
        }, '清除代理') : null,
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn dim-jh-btnPrimary',
          disabled: busy || url.trim().length === 0,
          onClick: () => save(url),
        }, '保存'),
        React.createElement('button', { type: 'button', className: 'dim-jh-btn', onClick: close }, '取消'),
      ),
    ),
  )
}

/**
 * 「添加 OpenCode 账号」弹窗（**组件**，用 `React.createElement(OpencodeKeyModal, props)` 渲染）。
 *
 * ## ⚠️⚠️ 同样是组件，不能直接函数调用
 *
 * 见上方 {@link OpencodeProxyModal} 的说明：直接调用会让本组件的 `useState`
 * 被算进 ProviderPanel，React 抛 #310 并让整个设置页白屏（真实事故 2026-10-02）。
 *
 * ## ⚠️ 为什么不用 `window.prompt`
 *
 * DSH 客户端跑在**沙箱**环境里，`prompt()` 直接抛
 * `prompt() is not supported`（真机报障 2026-10-01：
 * 「添加账号失败：prompt() is not supported」）。本仓库其余交互一律
 * 自绘 modal（见 `jet-hub.js` 的 BackupPanel），这里保持一致。
 *
 * ## 为什么输入框内容不进 React state
 *
 * API key 是凭据。放进 `useState` 会让它随每次父组件重渲染经过整棵组件树，
 * 也可能被 devtools 的组件树检查器读到 —— 与「key 存 credentials、
 * 不进明文」的口径不符。故用 `inputRef` + DOM 读值。
 * 只有**错误信息**进 state（它需要触发重渲染显示）。
 *
 * @param props { error, busy, inputRef, onSubmit(value), onSubmitAnonymous(), onClose }
 */
export function OpencodeKeyModal({ error, busy, inputRef, onSubmit, onSubmitAnonymous, onClose }) {
  const [mode, setMode] = React.useState('key')
  const submit = () => {
    if (mode === 'anonymous') {
      onSubmitAnonymous()
      return
    }
    // 空串 = 没填就点确认：静默关弹窗，不报错（免费通道本来就能用）。
    const value = inputRef && inputRef.current ? inputRef.current.value : ''
    if (String(value).trim() === '') return
    onSubmit(value)
  }
  return React.createElement('div', {
    className: 'dim-jh-modalOverlay dim-jh-modalOverlay--top',
    onClick: (e) => { if (e.target === e.currentTarget && !busy && onClose) onClose() },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      style: { maxWidth: '520px' },
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' }, '添加 OpenCode 账号'),
      ),
      // 两种身份：API key 账号 / 匿名通道（无需凭据）。
      React.createElement('div', { className: 'dim-jh-fieldRow' },
        [
          { id: 'key', label: 'API key 账号' },
          { id: 'anonymous', label: '匿名通道' },
        ].map((m) => React.createElement('label', { key: m.id, className: 'dim-jh-radio' },
          React.createElement('input', {
            type: 'radio',
            name: 'opencode-add-mode',
            checked: mode === m.id,
            onChange: () => setMode(m.id),
          }),
          m.label,
        )),
      ),
      mode === 'key'
        ? React.createElement(React.Fragment, null,
            React.createElement('p', { className: 'dim-jh-modalHint' },
              '在 opencode.ai/auth 生成 API key（形如 sk-…）后粘贴到下方。'
              + '可启用付费模型，并为每个账号单独设置出口代理。'),
            // ⚠️ 内容必须在 modalBody 里（flex:1; min-height:0; overflow-y:auto），
            // 否则弹窗内容会被裁掉（见 jet-hub.js 既有 modal 的注释）。
            React.createElement('div', { className: 'dim-jh-modalBody' },
              React.createElement('div', { className: 'dim-jh-formRows' },
                React.createElement('input', {
                  ref: inputRef,
                  className: 'dim-jh-input',
                  // ⚠️ password 类型：API key 是凭据，不该在屏幕上裸显。
                  type: 'password',
                  placeholder: 'sk-…',
                  autoFocus: true,
                  // Enter 直接提交：粘贴 key 后最自然的动作就是回车。
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submit();
                    }
                  },
                }),
              ),
              // ⚠️ 错误留在弹窗内：把整个账号列表切成错误态会让用户刚填的 key
              // 与错误信息一起消失，只能刷新重试。
              error
                ? React.createElement('p', { className: 'dim-jh-error', role: 'alert' }, '添加失败：' + error)
                : null,
            ))
        : React.createElement('div', { className: 'dim-jh-modalBody' },
            React.createElement('p', { className: 'dim-jh-modalHint' },
              '匿名通道无需任何凭据（上游认字面量 public），用于免费模型。'
              + '可以添加多条，每条可单独设置出口代理。'),
            // ⚠️⚠️ **诚实说明指纹不增加配额**：匿名通道按出口 IP 限额
            // （实测：换 key、换伪装头、换指纹全部无效）。要多份额度只能给
            // 不同匿名通道配**不同代理**；指纹分离的价值是防关联。
            // 不说清楚的话，用户加 5 条匿名通道却只看到一份额度，会以为坏了。
            React.createElement('p', { className: 'dim-jh-hint' },
              '注意：匿名通道的额度按「出口 IP」计算。多条匿名通道若共用同一个出口，'
              + '额度不会增加；给它们分别配置不同代理，才会各自获得独立额度。'),
            error
              ? React.createElement('p', { className: 'dim-jh-error', role: 'alert' }, '添加失败：' + error)
              : null,
          ),
      React.createElement('div', { className: 'dim-jh-modalActions' },
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn dim-jh-btnPrimary',
          disabled: busy,
          onClick: submit,
        }, busy ? '添加中…' : '添加'),
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: busy,
          onClick: () => { if (onClose) onClose() },
        }, '取消'),
      ),
    ),
  )
}
