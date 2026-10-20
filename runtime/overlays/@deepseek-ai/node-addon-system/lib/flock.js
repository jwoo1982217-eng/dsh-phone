/** Lazy POSIX flock entry; importing it does not load a native addon. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getSystemErrorName } from 'node:util';
let binding;
function loadBinding() {
    if (binding)
        return binding;
    const { platform, arch } = process;
    if (platform === 'android') {
        const filename = process.env.DSH_PHONE_FLOCK;
        if (!filename?.startsWith('/')) throw Error('Android flock library is not configured');
        // Android extracts executable libraries only as *.so. dlopen uses the
        // stable Node-API module entry without requiring a .node extension.
        const addon = { exports: {} };
        process.dlopen(addon, filename);
        binding = addon.exports;
        return binding;
    }
    if (platform !== 'linux' && platform !== 'darwin') {
        throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {
            code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
            syscall: 'flock',
        });
    }
    let filename = 'system.node';
    if (platform === 'linux') {
        // Node's report types omit the libc field supplied by Linux reports.
        const report = process.report.getReport();
        filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename);
    }
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`);
    binding = require(join(dirname(manifest), 'bin', filename));
    return binding;
}
/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * The syscall runs in asynchronous work, so acquisition can occur after this
 * call returns. Keep fd open until the promise settles; the binding never
 * opens, duplicates, or closes it. Closing the locked descriptor releases the
 * lock once all descriptors for its open file description are closed.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'. Native setup errors, unsupported
 *   platforms, and addon loading failures reject; importing alone does not load it.
 */
export async function tryLockExclusive(fd) {
    const errno = await new Promise((resolve) => {
        loadBinding().tryLock(fd, resolve);
    });
    if (errno === 0)
        return;
    const code = getSystemErrorName(-errno);
    throw Object.assign(new Error(`${code}: flock failed`), {
        code,
        errno,
        syscall: 'flock',
    });
}

/** Atomic Android publication without hard links or replacing an existing log. */
export async function publishNewFileAndroid(source, target) {
    if (process.platform !== 'android') throw Error('Android publication requires Android');
    const errno = loadBinding().publishNewFile(source, target);
    if (errno === 0) return;
    const code = getSystemErrorName(-errno);
    throw Object.assign(new Error(`${code}: atomic session publication failed`), {
        code, errno, syscall: 'renameat2', path: source, dest: target,
    });
}
