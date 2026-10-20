// Included in the registered client bundle: sizing must work without the APK
// injection or a fresh index.html after a client module reload.
function settingsEmbedHeight() {
  const viewport = window.visualViewport;
  const visible = viewport && Math.abs(viewport.scale - 1) < 0.05
    ? Math.min(window.innerHeight, viewport.height) : window.innerHeight;
  return Math.max(120, Math.min(760, Math.round((visible || 780) * 0.72)));
}

function fitSettingsEmbed(frame) {
  const registry = window.__dshSettingsEmbedBindings || (window.__dshSettingsEmbedBindings = new WeakMap());
  let binding = registry.get(frame), released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--binding.users === 0) { binding.dispose(); registry.delete(frame); }
  };
  if (binding) { binding.users++; return release; }
  binding = { users: 1, dispose() {} }; registry.set(frame, binding);
  const media = window.matchMedia('(max-width: 700px)');
  const panel = frame.closest('.VOzbGW_panel');
  let layout = document.getElementById('dsh-settings-embed-layout');
  if (!layout) { layout = document.createElement('style'); layout.id = 'dsh-settings-embed-layout'; document.head.appendChild(layout); }
  if (layout.textContent !== SETTINGS_EMBED_CSS) layout.textContent = SETTINGS_EMBED_CSS;
  const naturalPages = ['/agent-cards', '/controlled-market', '/phone-tools', '/hermes-remote', '/appearance-center'];
  let stopped = false, pending = false, disconnect = () => {};
  const setHeight = height => {
    const value = Math.ceil(height) + 'px';
    // Inline important also handles an older APK injecting min-height:100%.
    // The measured px value works on WebViews without dynamic viewport units.
    if (frame.style.getPropertyValue('height') !== value || frame.style.getPropertyPriority('height') !== 'important') frame.style.setProperty('height', value, 'important');
    frame.style.setProperty('min-height', media.matches ? '0px' : '320px', 'important');
  };
  const measure = () => {
    if (stopped || !frame.isConnected) return;
    if (media.matches) {
      const viewport = window.visualViewport;
      const visible = viewport && Math.abs(viewport.scale - 1) < 0.05 ? Math.min(window.innerHeight, viewport.height) : window.innerHeight;
      if (visible > 0) document.documentElement.style.setProperty('--dsh-phone-viewport-height', visible + 'px');
    }
    let height = Math.max(media.matches ? 0 : 320, settingsEmbedHeight()), naturalHeight = false;
    if (media.matches) {
      try {
        const doc = frame.contentDocument, body = doc && doc.body;
        const url = doc && new URL(doc.URL);
        if (body && url.origin === window.location.origin && naturalPages.includes(url.pathname)) {
          const style = doc.defaultView.getComputedStyle(body);
          const natural = body.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
          if (Number.isFinite(natural) && natural > 0) { height = natural; naturalHeight = true; }
        }
      } catch { /* Cross-origin or unavailable documents keep a bounded viewport. */ }
    }
    setHeight(height);
    if (panel) {
      if (naturalHeight) panel.setAttribute('data-dsh-embed-natural', '');
      else panel.removeAttribute('data-dsh-embed-natural');
    }
  };
  const schedule = () => {
    if (pending || stopped) return;
    pending = true;
    Promise.resolve().then(() => { pending = false; measure(); });
  };
  const load = () => {
    disconnect(); disconnect = () => {};
    try {
      const doc = frame.contentDocument, body = doc && doc.body;
      const url = doc && new URL(doc.URL);
      if (body && url.origin === window.location.origin && naturalPages.includes(url.pathname)) {
        const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
        const mutations = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
        if (resize) resize.observe(body);
        if (mutations) mutations.observe(body, { childList: true, subtree: true, characterData: true, attributes: true });
        doc.addEventListener('load', schedule, true);
        disconnect = () => { if (resize) resize.disconnect(); if (mutations) mutations.disconnect(); doc.removeEventListener('load', schedule, true); };
      }
    } catch { /* A navigated frame may be cross-origin. */ }
    measure();
  };
  frame.addEventListener('load', load);
  window.addEventListener('resize', schedule);
  document.addEventListener('visibilitychange', schedule);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule);
  if (media.addEventListener) media.addEventListener('change', schedule);
  else media.addListener(schedule);
  load();
  binding.dispose = () => {
    stopped = true; disconnect();
    if (panel) panel.removeAttribute('data-dsh-embed-natural');
    frame.removeEventListener('load', load);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('visibilitychange', schedule);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', schedule);
    if (media.removeEventListener) media.removeEventListener('change', schedule);
    else media.removeListener(schedule);
  };
  return release;
}

/** A React 18 element whose own ref owns its observers and resize listeners. */
function SettingsEmbed(title, src) {
  let dispose = () => {};
  return {
    $$typeof: Symbol.for('react.element'), type: 'iframe', key: null, _owner: null,
    ref: frame => { dispose(); dispose = frame ? fitSettingsEmbed(frame) : () => {}; },
    props: { title, src, 'data-dsh-settings-embed': '', style: {
      width: '100%', height: settingsEmbedHeight() + 'px', minHeight: 0,
      border: 0, display: 'block', background: 'transparent',
    } },
  };
}
