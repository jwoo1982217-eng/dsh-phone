import { readFile, readdir, lstat, readlink, realpath, mkdir, rename, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
const hash = b => createHash('sha256').update(b).digest('hex');
export function safeRelative(value) { if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..'))
    throw Error('Invalid migration path'); return value; }
export const inside = (base, p) => p === base || p.startsWith(base + path.sep);
export async function contained(base, relative) { const target = path.join(base, safeRelative(relative)); let p = path.dirname(target); while (true) {
    try {
        if (!inside(await realpath(base), await realpath(p)))
            throw Error('Migration path outside home');
        break;
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
        const next = path.dirname(p);
        if (next === p)
            throw e;
        p = next;
    }
} return target; }
export async function snapshot(file) {
    let stat;
    try {
        stat = await lstat(file);
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return { kind: 'absent' };
        throw e;
    }
    if (stat.isSymbolicLink())
        return { kind: 'link', value: await readlink(file) };
    if (stat.isFile())
        return { kind: 'file', sha256: hash(await readFile(file)), mode: stat.mode & 0o777 };
    if (!stat.isDirectory())
        throw Error('Unsupported migration file type');
    const entries = [];
    async function visit(dir, prefix) { for (const name of (await readdir(dir)).sort()) {
        const rel = prefix ? prefix + '/' + name : name, p = path.join(dir, name), s = await lstat(p);
        if (s.isDirectory()) {
            entries.push([rel, 'directory', s.mode & 0o777]);
            await visit(p, rel);
        }
        else if (s.isFile())
            entries.push([rel, 'file', hash(await readFile(p)), s.mode & 0o777]);
        else if (s.isSymbolicLink())
            entries.push([rel, 'link', await readlink(p)]);
        else
            throw Error('Unsupported migration file type');
    } }
    await visit(file, '');
    return { kind: 'directory', sha256: hash(JSON.stringify(entries)) };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export async function syncDirectory(directory) { let handle; try {
    handle = await open(directory, 'r');
    await handle.sync();
}
catch (e) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(e.code))
        throw e;
}
finally {
    await handle?.close();
} }
export async function durableJson(file, value) { const temporary = file + '.tmp-' + randomUUID(); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); let fd; try {
    fd = await open(temporary, 'wx', 0o600);
    await fd.writeFile(JSON.stringify(value, null, 2) + '\n');
    await fd.sync();
    await fd.close();
    fd = null;
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
}
finally {
    await fd?.close();
    await rm(temporary, { force: true });
} }
async function verifyGuards(home, guards) { for (const g of guards) {
    if (!/^[a-f0-9]{64}$/.test(g.sha256))
        throw Error('Invalid migration guard');
    const p = await contained(home, g.relative);
    if (hash(await readFile(p)) !== g.sha256)
        throw Error('Profile changed during migration; originals retained');
} }
async function validateJournal(home, backup, journal) {
    if (journal.version !== 1 || !Array.isArray(journal.rows) || !Array.isArray(journal.guards) || journal.rows.length > 2000)
        throw Error('Invalid migration journal');
    if (!inside(await realpath(home), await realpath(backup)) || (await lstat(backup)).isSymbolicLink())
        throw Error('Migration backup outside home');
    const seen = new Set();
    for (const row of journal.rows) {
        safeRelative(row.target);
        safeRelative(row.saved);
        safeRelative(row.stage);
        if ([...seen].some(p => p === row.target || p.startsWith(row.target + '/') || row.target.startsWith(p + '/')) || row.saved === row.stage)
            throw Error('Invalid migration journal paths');
        seen.add(row.target);
        await contained(home, row.target);
        await contained(backup, row.saved);
        await contained(backup, row.stage);
        for (const value of [row.before, row.after])
            if (!value || !['absent', 'file', 'link', 'directory'].includes(value.kind))
                throw Error('Invalid migration journal fingerprint');
    }
}
async function rollback(home, backup, journal) {
    await validateJournal(home, backup, journal);
    await verifyGuards(home, journal.guards);
    // Validate every row before restoring the first: never overwrite a concurrent edit.
    for (const row of journal.rows) {
        const target = await contained(home, row.target), saved = await contained(backup, row.saved), a = await snapshot(target), b = await snapshot(saved);
        if (b.kind === 'absent') {
            if (!equal(a, row.before))
                throw Error('Migration recovery conflict: original changed: ' + row.target);
        }
        else if (!equal(b, row.before) || !(a.kind === 'absent' || equal(a, row.after)))
            throw Error('Migration recovery conflict: changed target or backup: ' + row.target);
    }
    for (const row of [...journal.rows].reverse()) {
        const target = await contained(home, row.target), saved = await contained(backup, row.saved);
        if ((await snapshot(saved)).kind === 'absent')
            continue;
        if ((await snapshot(target)).kind !== 'absent') {
            const displaced = path.join(backup, 'displaced', row.saved);
            await mkdir(path.dirname(displaced), { recursive: true, mode: 0o700 });
            await rename(target, displaced);
            await syncDirectory(path.dirname(displaced));
        }
        await rename(saved, target);
        await syncDirectory(path.dirname(saved));
        await syncDirectory(path.dirname(target));
    }
    journal.state = 'rolled-back';
    await durableJson(path.join(backup, 'journal.json'), journal);
}
export async function recoverTransactions(home) { const root = path.join(home, '.phone-core-backups'); let names; try {
    names = await readdir(root);
}
catch (e) {
    if (e.code === 'ENOENT')
        return;
    throw e;
} for (const name of names.sort()) {
    const backup = await contained(home, '.phone-core-backups/' + name);
    if ((await lstat(backup)).isSymbolicLink() || !inside(await realpath(home), await realpath(backup)))
        throw Error('Migration backup outside home');
    let j;
    try {
        j = JSON.parse(await readFile(path.join(backup, 'journal.json'), 'utf8'));
    }
    catch (e) {
        if (e.code === 'ENOENT')
            continue;
        throw e;
    }
    if (j.state === 'committed' || j.state === 'rolled-back')
        continue;
    if (j.state === 'preparing') {
        await validateJournal(home, backup, j);
        await rm(path.join(backup, 'stage'), { recursive: true, force: true });
        j.state = 'rolled-back';
        await durableJson(path.join(backup, 'journal.json'), j);
        continue;
    }
    if (!['prepared', 'committing', 'recovery-required'].includes(j.state))
        throw Error('Invalid migration recovery state');
    await rollback(home, backup, j);
} }
export async function runTransaction(home, backup, rows, guards) {
    const journal = { version: 1, state: 'prepared', rows, guards };
    await validateJournal(home, backup, journal);
    await verifyGuards(home, guards);
    for (const row of rows)
        if (!equal(await snapshot(await contained(home, row.target)), row.before))
            throw Error('SDK changed during migration preparation: ' + row.target);
    await durableJson(path.join(backup, 'journal.json'), journal);
    try {
        journal.state = 'committing';
        await durableJson(path.join(backup, 'journal.json'), journal);
        for (const row of rows) {
            await verifyGuards(home, guards);
            const target = await contained(home, row.target), saved = await contained(backup, row.saved), stage = await contained(backup, row.stage);
            if (!equal(await snapshot(target), row.before))
                throw Error('SDK changed during migration: ' + row.target);
            await mkdir(path.dirname(saved), { recursive: true, mode: 0o700 });
            await rename(target, saved);
            await syncDirectory(path.dirname(saved));
            await syncDirectory(path.dirname(target));
            await rename(stage, target);
            await syncDirectory(path.dirname(target));
            if (!equal(await snapshot(target), row.after))
                throw Error('SDK exchange verification failed');
        }
        await verifyGuards(home, guards);
        journal.state = 'committed';
        await durableJson(path.join(backup, 'journal.json'), journal);
        return { backup };
    }
    catch (error) {
        try {
            await rollback(home, backup, journal);
        }
        catch (restore) {
            journal.state = 'recovery-required';
            await durableJson(path.join(backup, 'journal.json'), journal);
            throw new AggregateError([error, restore], 'SDK migration failed; backup preserved and recovery requires attention');
        }
        throw error;
    }
}
/** Use one permanent lock inode. OS flock releases on close or process death,
 * including death before any owner receipt could be written. Never unlink the
 * lock: doing so would let two contenders lock different inodes at one path.
 * Importing this fixed utility entry neither starts the engine nor loads plugins.
 */
export async function withMigrationLock(tree, home, fn) {
    const relative = 'node_modules/@deepseek-ai/node-addon-system/lib/flock.js';
    const source = await contained(tree, relative);
    if (!inside(await realpath(tree), await realpath(source)))
        throw Error('Migration flock entry outside deployment');
    const { tryLockExclusive } = await import(pathToFileURL(source).href);
    if (typeof tryLockExclusive !== 'function')
        throw Error('Migration native flock API missing');
    const file = await contained(home, '.phone-core-migration.flock');
    const fd = await open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.nlink !== 1)
            throw Error('Migration lock inode must be a private regular file');
        try {
            await tryLockExclusive(fd.fd);
        }
        catch (e) {
            if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK')
                throw Error('Phone core migration is already running');
            throw e;
        }
        return await fn();
    }
    finally {
        await fd.close();
    }
}
