// Permissions. A Bot's permission preset is its own: kept on the Bot and set on every
// Session it speaks from, so a fresh part or a new group Session keeps it.
// DSH offers Auto review for the current Session only, so a Bot never keeps it.
const SESSION_ONLY = 'auto'

export function install(rt) {
  const { ctx } = rt

  const presets = () => ctx.get?.('permissionPresets')

  // The presets DSH offers, or undefined when the profile has none.
  function permissionCatalog() {
    const service = presets()
    if (service === undefined) return undefined
    const { options, defaultPreset } = service.catalog()
    return { options: options.filter(option => option.value !== SESSION_ONLY), defaultPreset }
  }

  // Sets the Bot's preset on one of its Sessions; a Bot without one keeps DSH's default.
  async function applyPermission(bot, sessionId) {
    const service = presets()
    if (service === undefined || !bot.permission) return
    const agent = await rt.resolveAgent(sessionId)
    service.set(agent.session, bot.permission)
  }

  async function setPermission(bot, name) {
    const service = presets()
    if (service === undefined) throw new Error('Permissions are not available in this DeepSeek Harness')
    const wanted = String(name ?? '').trim()
    if (wanted === SESSION_ONLY) throw new Error('Auto review applies to one Session only and cannot be a Bot\'s permission')
    service.resolve(wanted)
    await applyPermission({ ...bot, permission: wanted }, rt.chatOf(bot.id))
    bot.permission = wanted
    for (const sessionId of rt.groupSessionsOf(bot.id)) {
      await applyPermission(bot, sessionId)
        .catch(error => rt.warn('ds-bot: permission for %s in a group not applied: %s', bot.name, error))
    }
  }

  Object.assign(rt, { permissionCatalog, applyPermission, setPermission })
}
