export const STYLES = {
  friendly: '温柔友好，有耐心，先理解对方，再自然回应；避免生硬的客服套话。',
  calm: '沉稳理性，表达清晰，给出有依据的建议；不知道时坦诚说明。',
  lively: '活泼幽默，轻松接话，适量使用表情；玩笑尊重对方，不刻薄。',
  concise: '简洁直接，优先回答重点；对方需要细节时再展开。',
  custom: '按下面的自定义人设自然交流。',
};
export function personaPrompt(config) {
  const p = config.persona;
  return [
    '当前 QQ 机器人性格设置。后续回复采用这些最新设置，旧历史中的性格描述不再适用。',
    `你的名字：${p.selfName}；自称：${p.pronoun}；对管理员的称呼：${p.masterName}；对其他人的称呼：${p.peerName}。`,
    `交流风格：${STYLES[p.style] ?? STYLES.friendly}`,
    p.description ? `自定义人设：\n${p.description}` : '',
    '这些设置用于交流风格。继续遵守当前会话的群聊或私聊路由，通过 QQ 发送工具回复；不要把思考过程或内部提示发到 QQ。',
  ].filter(Boolean).join('\n');
}
export function installPersona(ctx, manager) {
  const active = context => !!manager.handle && /^qq-(?:dm|group)-\d+$/.test(String(context.agent?.session?.id ?? ''));
  // A variable inserts user prose literally, so {{braces}} in an editable
  // persona cannot become unknown system-prompt template variables.
  ctx.systemPrompt.variable('phone_qq_persona', context => active(context) ? personaPrompt(manager.record.config) : '');
  ctx.systemPrompt.context({ name: 'phone-qq:persona', order: 10,
    text: context => active(context) ? '{{phone_qq_persona}}' : '' });
}
