import { opendir } from 'node:fs/promises';

export function phoneStorageRoot(env = process.env) {
    const path = env.DSH_PHONE_STORAGE;
    return path?.startsWith('/') ? path : '/storage/emulated/0';
}

/** Probe each time so a system permission change needs no service restart. */
export async function initialBrowseDirectory(home, { platform = process.platform, storage = phoneStorageRoot(), open = opendir } = {}) {
    if (platform !== 'android') return home;
    try {
        const directory = await open(storage);
        await directory.close();
        return storage;
    } catch { return home; }
}

export function phoneStorageShortcut(target, home, platform = process.platform, storage = phoneStorageRoot()) {
    return platform === 'android' && target === home && storage !== home
        ? [{ name: '手机存储（服务 → 文件访问权限）', path: storage, hidden: false }] : [];
}

export function storageFailureHint(target, error, platform = process.platform) {
    return platform === 'android' && /^(\/storage\/|\/sdcard(?:\/|$))/.test(target)
        && ['EACCES', 'EPERM'].includes(error?.code)
        ? '请先在顶部“服务 → 文件访问权限”授权；Android/data 等其他应用私有目录不能访问。' : '';
}
