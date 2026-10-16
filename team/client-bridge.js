function DshTurnOutcome({turn}) {
  const reason = turn?.end?.data?.reason;
  if (reason?.kind !== 'interrupted' && reason?.kind !== 'error') return null;
  const tail = turn.data?.get?.('turn-tail');
  let text = tail?.branchUnavailable === true
    ? '本轮已中断，未完成最终答复。已产生的过程和操作记录仍保留。'
    : '本轮已中断。';
  if (reason.kind === 'error') {
    const code = reason.error?.code;
    text = code === 'CONTEXT_WINDOW_EXCEEDED'
      ? '本轮未完成：上下文超出当前模型配置的容量，回复未正常结束。'
      : code === 'COMPACTION_FAILED'
        ? '本轮未完成：上下文压缩连续失败，已停止重复尝试。历史记录仍保留。'
      : ['QUOTA', 'ACCOUNT_QUOTA', 'QUOTA_EXCEEDED'].includes(code)
        ? '本轮未完成：模型额度受限。'
        : /max_tokens|max.?tokens/i.test(reason.error?.message ?? '')
          ? '本轮未完成：输出达到上限，回复未正常结束。'
          : '本轮未完成：模型调用失败。详见本轮错误信息。';
  }
  return {$$typeof: Symbol.for('react.element'), type: 'div', key: null, ref: null, _owner: null,
    props: {'data-dsh-turn-outcome': reason.kind, role: 'status', children: text,
      style: {width: '100%', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '20px', padding: '6px 0'}}};
}

function installTeamBridge(ctx, actions, roster, surface, refresh) {
  let navigation = 0, cancelNavigation;
  const navigate = async target => {
    cancelNavigation?.();
    const attempt = ++navigation;
    const known = () => ctx.sessions.list.getSnapshot().byId?.[target] !== undefined;
    if (!known()) {
      const available = await new Promise(resolve => {
        let stop = () => {}, settled = false;
        const finish = value => {
          if (settled) return; settled = true;
          clearTimeout(timer); stop(); cancelNavigation = undefined; resolve(value);
        };
        const timer = setTimeout(() => finish(false), 10000);
        cancelNavigation = () => finish(false);
        stop = ctx.sessions.list.subscribe(() => {if (known()) finish(true);});
        if (known()) finish(true);
      });
      if (!available || attempt !== navigation) return false;
    }
    if (attempt !== navigation) return false;
    ctx.uiWorkspace.openSession(target);
    return true;
  };
  ctx.effect(() => () => {++navigation; cancelNavigation?.();});
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'dsh-turn-outcome', order: -100
  }, DshTurnOutcome));
  const footerStyle = document.createElement('style');
  footerStyle.dataset.dshTeamFooter = '';
  footerStyle.textContent = `
    [data-dsh-team-switch]{box-sizing:border-box;width:100%;white-space:nowrap}
    [data-dsh-team-switch]:has(.bt-return-name){justify-content:flex-start}
    html[data-dsh-team-mode="bot"] [class*="_footArea"]:has([data-dsh-team-switch]){
      display:flex!important;flex-direction:row!important;flex-wrap:wrap;align-items:center;gap:6px
    }
    html[data-dsh-team-mode="bot"] [class*="_footArea"]:has([data-dsh-team-switch])>[class*="_footerActions"],
    html[data-dsh-team-mode="bot"] [class*="_footArea"]:has([data-dsh-team-switch])>[class*="_footerActions"]>div{
      display:contents!important
    }
    html[data-dsh-team-mode="bot"] [data-dsh-team-switch]{order:-2;flex:0 0 100%}
    html[data-dsh-team-mode="bot"] [class*="_footArea"]:has([data-dsh-team-switch]) .bt-connect-foot{
      order:0;flex:1 1 auto;min-width:0;width:auto;white-space:nowrap
    }
    html[data-dsh-team-mode="bot"] [class*="_footArea"]:has([data-dsh-team-switch])>[class*="_settingsArea"]{
      order:1;flex:none;width:auto
    }
    html[data-dsh-team-mode="bot"] [class*="_collapsed"] [class*="_footArea"]:has([data-dsh-team-switch]){
      flex-direction:column!important;flex-wrap:nowrap;padding:0!important;gap:6px
    }
    html[data-dsh-team-mode="bot"] [class*="_collapsed"] [data-dsh-team-switch]{
      width:36px;min-width:36px;padding:0;flex:none;justify-content:center
    }
  `;
  document.head.append(footerStyle);
  ctx.effect(() => () => footerStyle.remove());
  let ordinarySession;
  const selectedSession = () => Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find(row => (row?.retainedBy?.mainView ?? 0) > 0)?.id;
  const original = actions.setSurface;
  actions.setSurface = mode => {
    if (surface.getSnapshot().mode !== mode) {++navigation; cancelNavigation?.();}
    if (surface.getSnapshot().mode !== mode && mode === 'bot') {
      const selected = selectedSession(), snapshot = roster.getSnapshot();
      if (selected && !snapshot.byId[selected] && !snapshot.roomsById[selected]) ordinarySession = selected;
    }
    original(mode);
    if (mode === 'agent' && ordinarySession && ctx.sessions.list.getSnapshot().byId?.[ordinarySession]) ctx.uiWorkspace.openSession(ordinarySession);
    document.documentElement.dataset.dshTeamMode = mode;
  };
  const open = async event => {
    const detail = event?.detail ?? {};
    actions.setSurface(detail.mode === 'agent' ? 'agent' : 'bot');
    if (typeof detail.sessionId === 'string') {
      const wait = async () => {
        const snapshot = roster.getSnapshot();
        const bot = snapshot.bots.find(bot => bot.id === detail.sessionId || bot.sessionId === detail.sessionId);
        if (bot) actions.openSession(bot.sessionId ?? bot.id);
      };
      await refresh();
      await wait();
    }
  };
  document.documentElement.dataset.dshTeamMode = surface.getSnapshot().mode;
  window.addEventListener('dsh-team:open', open);
  ctx.effect(() => () => {window.removeEventListener('dsh-team:open', open); delete document.documentElement.dataset.dshTeamMode;});
  ctx.provide('dshTeamUi', {open: detail => open({detail}), navigate});
}
