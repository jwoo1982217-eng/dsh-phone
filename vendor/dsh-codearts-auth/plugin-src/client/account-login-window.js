/** WorkBuddy 使用独立资料的普通浏览器，既隔离旧账号，也不接入调试控制。 */
export async function openAccountLoginWindow({ provider, loginUrl, isolatedLoginCall, browserWindow = window }) {
  if (provider !== 'workbuddy') return browserWindow.open(loginUrl, '_blank', 'width=800,height=600');
  if (!isolatedLoginCall) throw Error('请启用桌面独立登录组件后，再添加 WorkBuddy 账号。');
  const result = await isolatedLoginCall({ action: 'open', url: loginUrl });
  if (!result?.isolated || !result.sessionId) throw Error('未能创建独立登录窗口，请重试。');
  if (result.browserMode !== 'system') {
    await isolatedLoginCall({ action: 'close', sessionId: result.sessionId }).catch(() => {});
    throw Error('登录组件需要更新为普通浏览器模式，请关闭旧登录窗口后重试。');
  }
  let closed = false;
  return {
    get closed() { return closed; },
    close() {
      if (closed) return;
      closed = true;
      void isolatedLoginCall({ action: 'close', sessionId: result.sessionId }).catch(() => {});
    },
  };
}
