// User-initiated SAF selection only; the engine still owns workspace adoption and session permissions.
(() => {
  const trusted = () => {
    try {
      const url = new URL(location.href);
      return window.top === window && url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
        url.port === '3080' && !url.username && !url.password;
    } catch (_) { return false; }
  };
  if (!trusted() || window.__DSH_DIRECTORY_PICKER__ !== undefined) return;
  if (window.__dshPhoneDirectoryPicker !== undefined || window.__dshPhoneDirectoryResult !== undefined) return;
  let pending = null;
  const native = (action, id) => { location.href = `dsh-phone://workspace/${action}?id=${id}`; };
  const settle = (item, value, error, notifyCancel = false) => {
    if (pending !== item) return false;
    pending = null;
    window.clearTimeout(item.timer);
    // Cancellation cannot take ownership of a newer native ticket; Activity checks the same id.
    if (notifyCancel && trusted()) { try { native('cancel', item.id); } catch (_) {} }
    if (error) item.reject(error); else item.resolve(value);
    return true;
  };
  const validPath = path => typeof path === 'string' && path.length > 1 && path.length <= 4096 &&
    path[0] === '/' && !/[\\\u0000-\u001f\u007f]/.test(path) &&
    !path.slice(1).split('/').some(part => !part || part === '.' || part === '..');
  const api = Object.freeze({
    version: 1,
    pick() {
      if (!trusted()) return Promise.reject(new Error('请在手机本地页面选择工作区文件夹'));
      if (pending) return Promise.reject(new Error('请先完成当前文件夹选择'));
      let id;
      try {
        const bytes = window.crypto.getRandomValues(new Uint8Array(16));
        id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      } catch (_) { return Promise.reject(new Error('页面缺少安全随机数支持，无法打开文件夹选择'));
      }
      return new Promise((resolve, reject) => {
        const item = { id, resolve, reject, timer: null };
        pending = item;
        item.timer = window.setTimeout(() => settle(item, null, new Error('选择文件夹已超时，请重试'), true), 300_000);
        try { native('pick', id); }
        catch (_) { settle(item, null, new Error('无法打开手机文件夹选择，请重试')); }
      });
    },
    cancel() { return pending ? settle(pending, null, null, true) : false; },
    isPending(id) { return trusted() && typeof id === 'string' && pending?.id === id; }
  });
  const complete = (id, path, error) => {
    const item = pending;
    if (!item || typeof id !== 'string' || item.id !== id) return false;
    if (!trusted()) return settle(item, null, null);
    if (error !== null && error !== undefined && error !== '') {
      return settle(item, null, new Error(typeof error === 'string' ? error.slice(0, 1024) : '文件夹选择失败，请重试'));
    }
    if (path === null || path === undefined) return settle(item, null, null);
    if (!validPath(path)) return settle(item, null, new Error('系统返回的文件夹路径无效，请重新选择本地目录'));
    return settle(item, path, null);
  };
  Object.defineProperty(window, '__DSH_DIRECTORY_PICKER__', { value: api });
  Object.defineProperty(window, '__dshPhoneDirectoryPicker', { value: api });
  Object.defineProperty(window, '__dshPhoneDirectoryResult', { value: complete });
  // Do not navigate from pagehide: the Activity cancels its picker when the owning document leaves.
  window.addEventListener('pagehide', () => { if (pending) settle(pending, null, null); });
})();
