// Native save is available only in the app's trusted top-level local documents.
(() => {
  if (window.top !== window || !['http://127.0.0.1:3080', 'http://127.0.0.1:3081'].includes(location.origin)) return;
  if (window.__dshPhoneJsonExport) return;
  const pending = new Map();
  const maxBytes = 524288;
  Object.defineProperty(window, '__dshPhoneJsonExport', { value: Object.freeze({
    save(filename, text) {
      if (pending.size) return Promise.reject(new Error('请先完成当前文件的保存'));
      if (typeof filename !== 'string' || typeof text !== 'string' || new TextEncoder().encode(text).length > (filename.endsWith('.md') ? 2 * 1024 * 1024 + 1024 : maxBytes)) {
        return Promise.reject(new Error('文件超过手机保存上限（JSON 512 KB，Markdown 2 MB）'));
      }
      const ticket = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      return new Promise((resolve, reject) => {
        pending.set(ticket, { filename, text, resolve, reject });
        // The URL carries only a random request ID, never account credentials.
        location.href = `dsh-phone://files/save?ticket=${ticket}`;
      });
    },
    take(ticket) {
      const item = pending.get(ticket);
      if (!item || item.text === null) return null;
      const payload = { filename: item.filename, text: item.text };
      item.text = null;
      return payload;
    },
    complete(ticket, status, message) {
      const item = pending.get(ticket);
      if (!item) return;
      pending.delete(ticket);
      item.text = null;
      if (status === 'saved' || status === 'cancelled') item.resolve({ status });
      else item.reject(new Error(message || '文件保存失败，请重试'));
    },
  }) });
})();
