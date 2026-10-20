import * as React from 'react';

const h = React.createElement;

export function OpencodeLocalPanel({ rpcCall, showModelList }) {
  const [state, setState] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [baseUrl, setBaseUrl] = React.useState('http://127.0.0.1:4096');
  const [username, setUsername] = React.useState('opencode');
  const [password, setPassword] = React.useState('');
  const alive = React.useRef(false);
  const acting = React.useRef(false);
  const revision = React.useRef(0);
  const dirty = React.useRef(false);

  React.useEffect(() => {
    alive.current = true;
    const current = ++revision.current;
    void rpcCall('opencode.local.status', {}).then(value => {
      if (!alive.current || current !== revision.current) return;
      setState(value);
      if (!dirty.current) setBaseUrl(value.baseUrl);
    }).catch(error => {
      if (alive.current && current === revision.current) setNotice({ error: true, text: error.message });
    });
    return () => { alive.current = false; revision.current++; };
  }, [rpcCall]);

  const act = async (method, payload = {}) => {
    if (acting.current || !alive.current) return;
    acting.current = true; revision.current++;
    setBusy(true); setNotice(null);
    try {
      const value = await rpcCall('opencode.local.' + method, payload);
      if (!alive.current) return;
      setState(value);
      if (method === 'configure') { dirty.current = false; setPassword(''); }
      setNotice({ text: method === 'configure' ? '设置已保存，点击启动/重连检查服务。' : '服务已连接，模型目录已更新。' });
    } catch (error) {
      if (alive.current) setNotice({ error: true, text: error.message });
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const controlStyle = { width: '100%', minWidth: 0, minHeight: 44, boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-default, #dfe1e5)', borderRadius: 8, padding: '8px 10px', color: 'inherit', background: 'var(--dsw-alias-bg-layer-3, #fff)' };
  return h('section', { 'aria-label': 'OpenCode 本地服务', style: { minWidth: 0 } },
    h('div', { className: 'dim-jh-panelHead' },
      h('h2', { className: 'dim-jh-panelTitle' }, 'OpenCode 本地服务'),
      h('div', { className: 'dim-jh-headerActions', style: { flexWrap: 'wrap' } },
        h('button', { className: 'dim-jh-btn', disabled: busy, onClick: () => void act('start') }, busy ? '连接中…' : '启动/重连'),
        h('button', { className: 'dim-jh-btn', disabled: busy, onClick: () => void act('refresh') }, '刷新模型'),
        h('button', { className: 'dim-jh-btn', disabled: busy || !(state?.modelCount > 0), onClick: showModelList }, '显示列表'))),
    h('p', null, '使用本机 OpenCode 服务中的免费模型。DSH 会按需启动服务，并保持连接；模型目录来自当前服务。'),
    h('div', { role: 'status', style: { overflowWrap: 'anywhere', marginBlock: 16 } },
      state ? (state.healthy ? `已连接 · OpenCode ${state.version} · 目录 ${state.modelCount} 个免费模型` : '本地服务尚未连接') : '正在检查本地服务…',
      state?.error ? h('p', null, state.error) : null),
    notice ? h('div', { className: 'dim-jh-probeNotice', 'data-tone': notice.error ? 'error' : 'success', role: notice.error ? 'alert' : 'status' }, notice.text) : null,
    h('details', { style: { marginBlock: 20 } },
      h('summary', { style: { minHeight: 44, cursor: 'pointer' } }, '服务地址与访问密码'),
      h('div', { style: { display: 'grid', gap: 12, maxWidth: 600, marginTop: 12 } },
        h('label', null, '本机服务地址', h('input', { 'aria-label': '本机服务地址', style: controlStyle, value: baseUrl, disabled: busy, onChange: e => { dirty.current = true; setBaseUrl(e.target.value); } })),
        h('label', null, '服务用户名', h('input', { 'aria-label': '服务用户名', autoComplete: 'off', style: controlStyle, value: username, disabled: busy, onChange: e => setUsername(e.target.value) })),
        h('label', null, '服务访问密码', h('input', { 'aria-label': '服务访问密码', type: 'password', autoComplete: 'new-password', placeholder: '留空保留已保存的密码', style: controlStyle, value: password, disabled: busy, onChange: e => setPassword(e.target.value) })),
        h('button', { className: 'dim-jh-btn', disabled: busy || state?.activeRequests > 0, onClick: () => void act('configure', { baseUrl, username, password }) }, '保存连接设置'))),
    h('p', { style: { opacity: 0.8 } }, '免费模型不需要在 JetHub 添加 Zen API Key。已有账号记录保持保留。'),
    h('ul', { style: { paddingLeft: 20, overflowWrap: 'anywhere' } }, (state?.models ?? []).map(model => h('li', { key: model.id, style: { marginBlock: 8 } },
      h('strong', null, model.name), h('span', null, ` · ${model.id}`), model.inputModalities?.includes('image') ? h('span', null, ' · 支持图片') : null))),
    state?.healthy && state.modelCount === 0 ? h('p', null, '服务已连接，尚未读取模型目录；点击刷新模型。') : null);
}
