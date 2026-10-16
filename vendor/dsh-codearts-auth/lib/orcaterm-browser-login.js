/**
 * OrcaTerm 登录：用 DSH 内置浏览器打开登录页，**从 CDP 直接读 cookie**。
 *
 * ## 为什么不是读 cookie 库文件
 *
 * 早期实现读 `$DSH_HOME/browser/.../Cookies` 并解 Chromium 的加密值，需要
 * macOS 钥匙串（`Chrome Safe Storage`）+ PBKDF2 + AES。三个硬伤：
 *
 * 1. **换机器就废**：Windows/Linux 的钥匙串与派生参数不同；
 * 2. **不是「登录动作」**：机器上恰好存在凭据就会建号 —— 表现为用户点
 *    「添加账号」**没扫码就冒出一个账号**（真机故障 2026-10-14）；
 * 3. **脆弱**：浏览器版本、库锁、profile 路径变化都会让它失败。
 *
 * 本模块改走 **CDP**：让内置浏览器打开登录页，用户扫码，然后调
 * `Network.getCookies` 拿**这一次会话真实产生的** cookie。跨平台，不碰
 * 磁盘上的加密库，且天然只在「用户刚登过」之后才拿得到值。
 *
 * ## 依赖的服务
 *
 * `ctx.desktopBrowser.getService()`（由 `dsh-desktop-browser` 提供）返回
 * `BrowserPanelService`，其 `browser` 是 `DesktopBrowser`，带通用 CDP 发送器
 * `send(tab, method, params)` 与 `newTab` / `list` / `closeTab`。
 *
 * ## 手机端
 *
 * `dsh-desktop-browser` 与 `isolated-login` 在 `DSH_PHONE_ANDROID=1` 时**都不启动**
 *（Android 上没有 Chrome/Edge 子进程）。所以本模块在手机端必然拿不到服务 ——
 * 调用方据此回退到面板输入框（见 `orcaterm-login.ts` 的 manual 路径）。
 *
 * @module orcaterm-browser-login
 */
import { ORCATerm } from './orcaterm-product.js';
/**
 * 从 CDP `Network.getCookies` 的结果里挑出 OrcaTerm 登录态。
 *
 * @param cookies CDP 返回的 cookie 数组
 * @returns 网页形态凭据；`uin`/`skey` 不全时返回 null
 */
export function credentialFromCookies(cookies) {
    const wanted = new Map();
    for (const cookie of cookies) {
        const name = String(cookie?.name ?? '');
        const value = String(cookie?.value ?? '');
        const domain = String(cookie?.domain ?? '');
        if (!name || !value)
            continue;
        // 只认腾讯域，避免同名 cookie 串味。
        if (!domain.includes('tencent.com'))
            continue;
        if (name === 'uin' || name === 'skey' || name === 'userId') {
            // 更具体的域优先（orcaterm 页面上的那份比 .cloud.tencent.com 的更新）。
            if (!wanted.has(name))
                wanted.set(name, value);
        }
    }
    const uin = wanted.get('uin') ?? '';
    const skey = wanted.get('skey') ?? '';
    if (!uin || !skey)
        return null;
    return { kind: 'web', uin, skey, userId: wanted.get('userId') ?? '' };
}
/**
 * 打开登录页并等待用户完成扫码。
 *
 * ⚠️ **不阻塞到用户扫完**：这里只负责把登录窗口打开并把 tabId 交给调用方。
 * 真正取 cookie 由 `readSessionFromLoginTab` 在轮询里做 —— 与其余 provider
 * 的「弹窗 + 轮询」契约一致，也避免把一次 HTTP 请求挂住几分钟。
 *
 * @returns 登录窗口的标签 id 与 URL
 */
export async function openOrcaTermLoginWindow(desktopBrowser) {
    if (desktopBrowser === undefined)
        return null;
    try {
        const service = await desktopBrowser.getService();
        // visible: true → 用户能看见并扫码的窗口（不是隐藏标签页）。
        const tab = await service.browser.newTab(ORCATerm.loginUrl, { visible: true });
        return { tabId: tab.id, url: ORCATerm.loginUrl };
    }
    catch {
        // 服务不可用（手机端、无 Chrome/Edge、用户已停止浏览器）→ 调用方回退。
        return null;
    }
}
/**
 * 从已打开的登录窗口读一次 cookie。用户还没扫完时返回 null。
 *
 * @param tabId `openOrcaTermLoginWindow` 返回的标签 id
 */
export async function readSessionFromLoginTab(desktopBrowser, tabId) {
    if (desktopBrowser === undefined)
        return null;
    try {
        const service = await desktopBrowser.getService();
        const tab = service.browser.list().find(candidate => candidate.id === tabId);
        if (tab === undefined)
            return null; // 窗口被用户关了
        const result = await service.browser.send(tab, 'Network.getCookies');
        const cookies = result?.cookies ?? [];
        return credentialFromCookies(cookies);
    }
    catch {
        return null;
    }
}
/** 关闭登录窗口（成功拿到凭据或用户放弃时调用）。 */
export async function closeLoginTab(desktopBrowser, tabId) {
    if (desktopBrowser === undefined)
        return;
    try {
        const service = await desktopBrowser.getService();
        await service.browser.closeTab(tabId);
    }
    catch { /* 已关闭 */ }
}
//# sourceMappingURL=orcaterm-browser-login.js.map