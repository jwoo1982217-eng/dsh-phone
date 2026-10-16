/** Mount one channel backend per host; the account pool belongs to that backend. */
export async function mountHostChannels(ctx, { loadPack, outlet, onState, logger = console }) {
  let stopped = false
  ctx.effect(() => () => { stopped = true }, 'our-free-model: channel backend')

  const hasSharedBackend = () => typeof ctx.get === 'function' && ctx.get('codeartsAuth') !== undefined
  const share = () => {
    onState({ state: 'pending', mode: 'shared', error: '' })
    // accountPool is published after Jet Hub has registered all adapters and RPCs.
    // Waiting for it also handles the host plugin still completing its startup.
    ctx.inject(['codeartsAuth', 'accountPool', 'connection'], scoped => {
      if (stopped) return
      const connection = scoped.get('connection')
      const mode = typeof connection?.rpc?.handle === 'function' ? 'shared' : 'shared-legacy'
      onState({ state: 'ready', mode, error: '' })
      scoped.effect(() => () => {
        if (!stopped) onState({ state: 'pending', mode, error: 'shared channel backend is unavailable' })
      }, 'our-free-model: shared channel availability')
      logger.info?.('our-free-model: using the existing Jet Hub channel backend and account pool')
    })
  }

  try {
    if (hasSharedBackend()) { share(); return }
    const pack = await loadPack()
    if (stopped) return
    // The host backend may have started while the bundled module was importing.
    if (hasSharedBackend()) { share(); return }
    pack.apply(ctx, { disableOpencode: true, outlet })
    onState({ state: 'ready', mode: 'embedded', error: '' })
    logger.info?.('our-free-model: embedded free-channel pack mounted')
  } catch (error) {
    if (stopped) return
    const message = String(error?.message ?? error).slice(0, 300)
    onState({ state: 'failed', error: message })
    logger.warn?.(`our-free-model: free-channel pack unavailable (${message})`)
  }
}
