const inject = ['slots'];

/** React 18's public element shape, requiring no second React runtime or browser bundle. */
function AgentCardsSection() {
  return { $$typeof: Symbol.for('react.element'), type: 'iframe', key: null, ref: null, _owner: null,
    props: { title: 'Agent 人设', src: '/agent-cards', 'data-dsh-settings-embed': '', style: { width: '100%', height: 'min(72dvh, 760px)', minHeight: 320, border: 0, display: 'block' } } };
}
function apply(ctx) {
  const theme = document.createElement('script'); theme.src = '/appearance/theme-client.js'; document.head.append(theme);
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'agent-persona-cards', order: 25, label: 'Agent 人设' }, AgentCardsSection));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'controlled-plugin-market', order: 45, label: '插件市场' }, () => ({
    $$typeof: Symbol.for('react.element'), type: 'iframe', key: null, ref: null, _owner: null,
    props: { title: '插件市场', src: '/controlled-market', 'data-dsh-settings-embed': '', style: { width: '100%', height: 'min(72dvh, 760px)', minHeight: 320, border: 0, display: 'block' } }
  })));
  for (const [id, label, src, order] of [['chat-history','彻底删除聊天记录','/chat-history',27],['memory-isolation','记忆隔离与排查','/memory-isolation',26],['mcp-manager','MCP 服务','/mcp-manager',43],['workflow-hub', 'Preset 广场', '/workflow-hub', 40], ['plugin-center', '插件管理', '/plugin-center', 44], ['appearance', '外观皮肤', '/appearance', 20]]) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id, order, label }, () => ({
      $$typeof: Symbol.for('react.element'), type: 'iframe', key: null, ref: null, _owner: null,
      props: { title: label, src, 'data-dsh-settings-embed': '', style: { width: '100%', height: 'min(72dvh, 760px)', minHeight: 320, border: 0, display: 'block' } }
    })));
  }
}
