import * as React from 'react';
import { chatGptAuthorizationUrl } from './chatgpt-plan-rpc.js';

const h = React.createElement;
const pending = state => ['waiting-browser', 'exchanging'].includes(state?.attempt?.phase);

export function ChatGptPlanPanel({ chatGptCall, navigate = url => window.location.assign(url) }) {
  const [state, setState] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [catalog, setCatalog] = React.useState(null);
  const [catalogError, setCatalogError] = React.useState(null);
  const [refresh, setRefresh] = React.useState(0);
  const life = React.useRef(null);
  const acting = React.useRef(false);
  const revision = React.useRef(0);

  React.useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    let loading = false;
    const load = async () => {
      if (loading || acting.current || controller.signal.aborted) return;
      loading = true;
      const before = revision.current;
      try {
        const value = await chatGptCall('status', {}, controller.signal);
        if (!controller.signal.aborted && before === revision.current) {
          setState(value);
          setNotice(current => current?.error ? null : current);
        }
      } catch (error) {
        if (!controller.signal.aborted && before === revision.current) setNotice({ error: true, text: error.message });
      } finally { loading = false; }
    };
    void load();
    // Status polling is local only. Fetch the remote model catalog on account change or refresh.
    const timer = setInterval(load, 3000);
    window.addEventListener('focus', load);
    window.addEventListener('dsh-chatgpt-return', load);
    return () => {
      controller.abort(); clearInterval(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener('dsh-chatgpt-return', load);
    };
  }, [chatGptCall]);

  const active = state?.active;
  const enabled = state?.planEnabled && !state?.welcomeNeeded;
  React.useEffect(() => {
    const controller = new AbortController();
    setCatalog(null); setCatalogError(null);
    if (enabled) {
      void chatGptCall('models', { force: refresh > 0 }, controller.signal).then(value => {
        if (!controller.signal.aborted) setCatalog({ active, models: value.models ?? [] });
      }).catch(error => {
        if (!controller.signal.aborted) setCatalogError(error.message);
      });
    }
    return () => controller.abort();
  }, [chatGptCall, active, enabled, refresh]);

  const openAuthorization = value => {
    const url = chatGptAuthorizationUrl(value);
    if (url) navigate(url);
    else setNotice({ error: true, text: '官方授权链接尚未就绪，请重新登录。' });
  };
  const act = async (action, extra = {}) => {
    if (acting.current || !life.current || life.current.signal.aborted) return;
    acting.current = true; revision.current++; setBusy(true); setNotice(null);
    const controller = life.current;
    try {
      const value = await chatGptCall(action, extra, controller.signal);
      if (controller.signal.aborted) return;
      setState(value);
      if (value.message) setNotice({ text: value.message });
      if (action === 'login') openAuthorization(value);
    } catch (error) {
      if (!controller.signal.aborted) setNotice({ error: true, text: error.message });
    } finally {
      acting.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const waiting = pending(state);
  const models = catalog?.active === active && enabled ? catalog.models : null;
  const button = (text, onClick, disabled = busy, kind) => h('button', {
    type: 'button', className: 'dim-jh-btn', 'data-kind': kind, onClick, disabled,
  }, text);

  return h('section', { className: 'dim-jh-chatgpt', 'aria-label': 'ChatGPT 会员账号' },
    h('h2', null, 'ChatGPT 会员'),
    h('p', { className: 'dim-jh-chatgptIntro' }, '连接你的 ChatGPT 账号，在 DSH 聊天或通过本机网关调用官方可用模型。'),
    h('div', { className: 'dim-jh-accountCard' },
      h('p', { role: 'status' }, !state ? '正在读取账号状态…' : state.planEnabled
        ? '已连接 · 使用 ChatGPT 会员方案' : state.signedIn ? '已登录 · 尚未授权使用会员方案' : '尚未登录 ChatGPT'),
      state?.profiles?.length ? h('select', {
        className: 'dim-jh-chatgptAccounts', 'aria-label': 'ChatGPT 账号或工作区', value: active ?? '',
        disabled: busy || waiting, onChange: event => void act('switch', { id: event.target.value }),
      }, !active ? h('option', { value: '', disabled: true }, '选择账号或工作区') : null,
      state.profiles.map(profile => h('option', { value: profile.id, key: profile.id },
        profile.label + (profile.connected ? '' : ' · 待登录')))) : null,
      h('div', { className: 'dim-jh-chatgptActions' },
        button(state?.planEnabled ? '重新授权' : 'Continue with ChatGPT', () => void act('login'), busy || waiting || !state, 'primary'),
        state?.profiles?.length ? button('添加账号或工作区', () => void act('login', { newProfile: true }), busy || waiting) : null,
        state?.attempt?.phase === 'waiting-browser' ? button('继续官方授权', () => openAuthorization(state)) : null,
        waiting ? button('取消授权', () => void act('cancel')) : null,
        state?.signedIn ? button('退出当前连接', () => {
          if (window.confirm('退出当前 ChatGPT 连接？其他账号会保留。')) void act('logout');
        }, busy || waiting, 'danger') : null),
      h('p', { className: 'dim-jh-chatgptHint' }, '可添加多个账号；模型请求自动依次轮换，只使用支持该模型且已授权的连接。限流账号暂时跳过。'),
      state?.attempt?.message ? h('p', { role: 'status' }, state.attempt.message) : null),
    notice ? h('p', { role: notice.error ? 'alert' : 'status', className: 'dim-jh-chatgptNotice' }, notice.text) : null,
    h('div', { className: 'dim-jh-accountCard' },
      h('div', { className: 'dim-jh-chatgptCatalogHeader' }, h('h3', null, '官方可用模型'),
        button('刷新模型', () => setRefresh(value => value + 1), busy || !enabled || (!models && !catalogError))),
      catalogError ? h('p', { role: 'alert' }, catalogError) : h('p', { role: 'status' }, !enabled
        ? '完成会员授权后可获取模型。' : !models ? '正在读取官方模型…' : models.length
          ? `当前账号有 ${models.length} 个可用模型。` : '官方暂未返回可用模型，请检查账号权益后重试。'),
      (models ?? []).map(model => h('div', { className: 'dim-jh-chatgptModel', key: model.id },
        h('strong', null, model.name), h('code', null, 'chatgpt-plan/' + model.id))),
      h('p', { className: 'dim-jh-chatgptHint' }, '墨听等程序使用 Jet Hub 的网关地址和密钥；模型 ID 如上，也可通过网关模型列表获取。')),
    h('p', { className: 'dim-jh-chatgptHint' }, '调用使用你的 ChatGPT 会员方案或可用积分。模型以当前账号的官方返回为准，此会员接口目前不支持生图。'),
    h('a', { href: 'https://chatgpt.com/settings/usage' }, '管理 ChatGPT 用量和应用授权'),
    state?.welcomeNeeded ? h('div', { className: 'dim-jh-chatgptWelcome', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'dim-jh-chatgptWelcomeTitle' },
      h('div', { className: 'dim-jh-accountCard' },
        h('h3', { id: 'dim-jh-chatgptWelcomeTitle' }, '正在使用你的 ChatGPT 会员方案'),
        h('p', null, '符合条件的模型请求使用你的会员方案或可用积分。你可以在 ChatGPT 设置中管理用量和应用授权。'),
        button('知道了', () => void act('welcome'), busy, 'primary'))) : null);
}
