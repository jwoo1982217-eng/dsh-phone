/** 手机版由原生窗口承接授权；WorkBuddy 官方授权页交给手机系统浏览器。 */
export async function openAccountLoginWindow({ loginUrl, browserWindow = window }) {
  return browserWindow.open(loginUrl, '_blank', 'width=800,height=600');
}
