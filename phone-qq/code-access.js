// Full command execution is opt-in and limited to administrator DMs.
// Group and non-administrator sessions keep the original workspace policy.
export function installCodeAccess(channel, permissions, config) {
  const bridge = channel?.bridge;
  if (!bridge) return;
  const original = bridge.ensureConversation;
  bridge.ensureConversation = async function (key, event) {
    const conversation = await original.call(this, key, event);
    const administrator = event?.message_type === 'private' && config.admins.includes(Number(event.user_id));
    permissions.set(conversation.handle.agent.session, config.codeExecution && administrator ? 'danger-full-access' : 'workspace-write');
    return conversation;
  };
}
