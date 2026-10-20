const inject = ['slots'];

// The pinned settings navigation reads the raw slot directory. Let the legacy
// owner retire its own row while the unified appearance row is active.
function registerLegacyAppearance(ctx, options, component) {
  return ctx.slots.inject('settings.section', () => {
    let dispose, stopped = false, syncing = false;
    const sync = () => {
      if (stopped || syncing) return;
      syncing = true;
      try {
      const unified = ctx.slots.entriesOfSlot('settings.section').some(entry => entry.options.id === 'appearance' && (entry.options.priority ?? 0) < 0);
      if (unified && dispose) { const remove = dispose; dispose = undefined; remove(); }
      else if (!unified && !dispose) dispose = ctx.slots.register(options, component);
      } finally { syncing = false; }
    };
    const off = ctx.on('slots/changed', key => { if (key === 'settings.section') sync(); });
    sync();
    return () => { stopped = true; off?.(); dispose?.(); };
  });
}

/** React 18's public element shape, requiring no second React runtime or browser bundle. */
function AgentCardsSection() {
  return SettingsEmbed('Agent 人设', '/agent-cards');
}
function apply(ctx) {
  const theme = document.createElement('script'); theme.src = '/appearance/theme-client.js'; document.head.append(theme);
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'agent-persona-cards', order: 25, label: 'Agent 人设' }, AgentCardsSection));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'controlled-plugin-market', order: 45, label: '插件市场' }, () => SettingsEmbed('插件市场', '/controlled-market')));
  for (const [id, label, src, order] of [['subagent-scheduler','子代理调度','/subagent-scheduler',31],['kb-memory','记忆','/knowledge-link#memory',29],['knowledge-transfer','技能与经验传递','/knowledge-link#transfer',30],['dsh-team','团队协作','/dsh-team',24],['task-supervisor','任务监督与经验','/task-supervisor',28],['chat-history','彻底删除聊天记录','/chat-history',27],['memory-isolation','记忆隔离与排查','/memory-isolation',26],['mcp-manager','MCP 服务','/mcp-manager',43],['workflow-hub', 'Preset 广场', '/workflow-hub', 40], ['plugin-center', '插件管理', '/plugin-center', 44], ['appearance', '外观皮肤', '/appearance', 20]]) {
    const section = () => SettingsEmbed(label, src);
    if (id === 'appearance') registerLegacyAppearance(ctx, { name: 'settings.section', id, order, label }, section);
    else if (id === 'kb-memory') registerMemoryFallback(ctx, { name: 'settings.section', id, order, label }, section);
    else ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id, order, label }, section));
  }
}

function registerMemoryFallback(ctx, options, component) {
 return ctx.slots.inject('settings.section',()=>{
  let dispose,stopped=false,syncing=false;
  const sync=()=>{if(stopped||syncing)return;syncing=true;try{const primary=ctx.slots.entriesOfSlot('settings.section').some(e=>e.options.id==='noema-memory');if(primary&&dispose){const remove=dispose;dispose=undefined;remove();}else if(!primary&&!dispose)dispose=ctx.slots.register(options,component);}finally{syncing=false;}};
  const off=ctx.on('slots/changed',key=>{if(key==='settings.section')sync();});sync();return()=>{stopped=true;off?.();dispose?.();};
 });
}
