// DSH compatibility overlay: keep LLM routes distinct from spawn/fork backends.
// Validate before provisioning so a correctable selection error does not consume a name.
export async function teammateAgentOptions(ctx, agent, args, signal) {
  ctx.get('dshSubagentScheduler')?.assertDelegation();
  signal.throwIfAborted();
  const policy = ctx.get('sessionProjections')?.stateOf(agent.session, 'subagentModelSelectionPolicy');
  const selected = args.provider !== undefined || args.model !== undefined || args.reasoning_effort !== undefined;
  if (!selected) {
    if (Array.isArray(policy) && policy.length) throw Error('请根据子任务内容选择模型。先调用 subagent_model_routes，再在 spawn_teammate 同时传 provider 和 model。');
    return undefined;
  }
  if (typeof args.provider !== 'string' || !args.provider.length || typeof args.model !== 'string' || !args.model.length)
    throw Error('spawn_teammate 的 provider 和 model 必须同时提供且非空。');
  if (!Array.isArray(policy) || !policy.some(r => r.provider === args.provider && r.model === args.model))
    throw Error('子模型线路不在本会话授权列表：' + args.provider + '/' + args.model);
  if (args.reasoning_effort !== undefined && (typeof args.reasoning_effort !== 'string' || !args.reasoning_effort.length))
    throw Error('reasoning_effort 必须是非空推理等级。');
  const options = {provider: args.provider, model: args.model};
  if (args.reasoning_effort !== undefined) options.reasoningEffort = args.reasoning_effort;
  const sameRoute = agent.options.provider === options.provider && agent.options.model === options.model;
  const reasoningEffort = options.reasoningEffort ?? (sameRoute ? agent.options.reasoningEffort : undefined);
  // Metadata resolution only; this never sends an inference request.
  await ctx.get('llm').resolveCallConfig({...options, ...(reasoningEffort === undefined ? {} : {reasoningEffort})}, signal);
  signal.throwIfAborted();
  return options;
}
