(() => {
  if (window.__dshAppearanceLoaded) return; window.__dshAppearanceLoaded = true;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/appearance/theme.css'; document.head.append(link);
  const apply = skin => { if (['peach', 'mint', 'original'].includes(skin)) document.documentElement.dataset.dshSkin = skin; };
  if (window.parent !== window) try {
    const followMode = () => { document.documentElement.style.colorScheme = getComputedStyle(window.parent.document.documentElement).colorScheme; };
    followMode(); const observer = new MutationObserver(followMode);
    observer.observe(window.parent.document.documentElement, { attributes: true }); observer.observe(window.parent.document.head, { subtree: true, childList: true, characterData: true });
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  } catch { /* An embedded page on another origin keeps its own color scheme. */ }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.data?.type !== 'dsh:appearance') return;
    const trusted = event.source === window.parent || [...document.querySelectorAll('iframe')].some(frame => frame.contentWindow === event.source && new URL(frame.src, location.href).pathname === '/appearance');
    if (trusted) { apply(event.data.skin); for (const frame of document.querySelectorAll('iframe')) if (new URL(frame.src, location.href).origin === location.origin) frame.contentWindow?.postMessage(event.data, location.origin); }
  });
  fetch('/appearance/manage', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'manage', payload: { action: 'status' } }) })
    .then(response => response.json()).then(result => { if (result.result?.ok) apply(result.result.value.skin); }).catch(() => {});
})();
