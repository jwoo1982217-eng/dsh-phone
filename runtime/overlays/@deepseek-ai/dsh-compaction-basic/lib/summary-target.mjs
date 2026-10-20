// The API controller owns pending human selection. Read its projection rather
// than rewriting the request header or treating Agent defaults as a new choice.
export function compactionTarget(ctx, agent) {
  const pending = ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')?.pending;
  const target = pending ?? agent.session.requestHeader()?.config ?? agent.options;
  if (target?.provider && target?.model) return {provider: target.provider, model: target.model};
}

export function pressureHeader(agent, target) {
  const prior = agent.session.requestHeader();
  if (!prior) return {config: target};
  if (prior.config.provider === target.provider && prior.config.model === target.model) return prior;
  const config = {...prior.config, ...target};
  delete config.reasoningEffort;
  if (prior.adapterDefaults?.maxTokens) delete config.maxTokens;
  return {...prior, config};
}

// Prompt assembly fixes the route for this step. A concurrent human selection
// belongs to a later step and must not change an in-flight compaction target.
export function trackAssembledTargets(ctx) {
  const targets = new WeakMap();
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next();
    const route = result.variables;
    if (context.agent && route?.provider && route?.model) targets.set(context.agent, {provider: route.provider, model: route.model});
    return result;
  }, {prepend: true});
  ctx.on('agent/status', ({agent, status}) => { if (status === 'idle') targets.delete(agent); });
  return targets;
}
