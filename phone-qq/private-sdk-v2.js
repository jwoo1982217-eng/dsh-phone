import { readFile, readdir, lstat, realpath, mkdir, open, statfs } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeRelative, inside, snapshot, contained, durableJson, syncDirectory } from './core-transaction.js';
const sha = b => createHash('sha256').update(b).digest('hex');
export async function regularInventory(root) {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw Error('Private SDK root must be a regular directory, not a link');
    const rows = [];
    let total = 0;
    async function visit(dir, prefix) {
        for (const name of (await readdir(dir)).sort()) {
            const relative = prefix ? prefix + '/' + name : name;
            safeRelative(relative);
            const f = path.join(dir, name), s = await lstat(f);
            if (s.isDirectory())
                await visit(f, relative);
            else if (s.isFile()) {
                total += s.size;
                if (rows.length >= 100000 || total > 512 * 1024 * 1024)
                    throw Error('Private SDK exceeds migration size limit');
                rows.push({ relative, sha256: sha(await readFile(f)) });
            }
            else
                throw Error('Private SDK contains a link or non-regular file: ' + relative);
        }
    }
    await visit(root, '');
    return rows;
}
export const inventoryKey = rows => JSON.stringify([...rows].sort((a, b) => a.relative === b.relative ? 0 : a.relative < b.relative ? -1 : 1).map(r => [r.relative, r.sha256]));
export function validateFiles(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 100000)
        throw Error('Invalid private SDK file manifest');
    const seen = new Set();
    for (const r of rows) {
        safeRelative(r.relative);
        if (seen.has(r.relative) || !/^[a-f0-9]{64}$/.test(r.sha256))
            throw Error('Invalid private SDK file manifest');
        seen.add(r.relative);
    }
    return seen;
}
async function validateClosure(stage, packages, sdkVersion) {
    if (!Array.isArray(packages) || !packages.length || packages.length > 2000)
        throw Error('Invalid private SDK package closure');
    const seen = new Set();
    const byLocation = new Map(packages.map(p => [p.relative,p]));
    const declaredIdentity = (file, metadata) => {
        const relative = path.relative(stage,path.dirname(file)).split(path.sep).join('/');
        const declared = byLocation.get(relative);
        return declared && declared.name === metadata.name && declared.version === metadata.version;
    };
    for (const p of packages) {
        safeRelative(p.relative);
        if (seen.has(p.relative))
            throw Error('Duplicate private SDK package');
        seen.add(p.relative);
        const m = JSON.parse(await readFile(path.join(stage, p.relative, 'package.json'), 'utf8'));
        if (m.name !== p.name || m.version !== p.version || (/^@deepseek-ai\/dsh(?:-|$)/.test(m.name) && m.version !== sdkVersion))
            throw Error('Private SDK closure version mismatch: ' + p.name);
        for (const name of Object.keys({ ...m.dependencies, ...m.peerDependencies })) {
            if (m.optionalDependencies?.[name] || m.peerDependenciesMeta?.[name]?.optional)
                continue;
            if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name))
                throw Error('Invalid SDK dependency name');
            let found = false, dir = path.join(stage, p.relative);
            while (inside(stage, dir)) {
                const dep = path.join(dir, 'node_modules', name, 'package.json');
                try {
                    const d = JSON.parse(await readFile(dep, 'utf8'));
                    // Node/npm aliases may deliberately mount a differently named Android adapter.
                    // Accept only the exact location/name/version already bound by the shipped plan.
                    if (!declaredIdentity(dep,d))
                        throw Error('Private SDK dependency identity mismatch');
                    found = true;
                    break;
                }
                catch (e) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
                if (dir === stage)
                    break;
                dir = path.dirname(dir);
            }
            if (!found)
                try {
                    const file = path.join(stage,name,'package.json');
                    const d = JSON.parse(await readFile(file,'utf8'));
                    if (!declaredIdentity(file,d)) throw Error('Private SDK dependency identity mismatch');
                    found = true;
                }
                catch (e) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
            if (!found)
                throw Error('Private SDK missing dependency ' + name + ' for ' + p.name);
        }
    }
}
/** Returns a staged complete closure, never edits current.json or registered URLs. */
export async function preparePrivateSdkV2(tree, home, plugin, currentFile, current, plan, backup) {
    const core = JSON.parse(await readFile(path.join(tree, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
    if (plan.version !== 2 || plan.sdkVersion !== core.version || !Array.isArray(plan.baselines))
        throw Error('Invalid private SDK patch version');
    const active = path.join(path.dirname(currentFile), current.token), modules = path.join(active, 'node_modules');
    if (!inside(await realpath(home), await realpath(active)))
        throw Error('Private SDK outside phone home');
    validateFiles(plan.files);
    const before = await snapshot(modules);
    const actual = await regularInventory(modules), key = inventoryKey(actual);
    if (key === inventoryKey(plan.files)) {
        await validateClosure(modules, plan.packages, plan.sdkVersion);
        return null;
    }
    let recognized;
    for (const b of plan.baselines) {
        validateFiles(b.files);
        if (key === inventoryKey(b.files))
            recognized = b;
    }
    if (!recognized)
        throw Error('Unrecognized private SDK edit; complete closure was not changed');
    const targetHashes = new Map(plan.files.map(r => [r.relative, r.sha256]));
    for (const required of recognized.requiredPreservations ?? []) {
        const receipt = plan.preservations?.find(r => r.relative === required.relative && r.beforeSha256 === required.sha256 && r.afterSha256 === targetHashes.get(required.relative) && ['merged', 'maintained-upstream'].includes(r.disposition) && typeof r.verification === 'string' && r.verification.trim());
        if (!receipt)
            throw Error('Unverified private SDK preservation: ' + required.relative);
    }
    const stageRelative = 'stage/private-node_modules';
    const stage = await stageVerifiedFiles(tree, home, plugin, plan.files, backup, stageRelative);
    await validateClosure(stage, plan.packages, plan.sdkVersion);
    return { target: path.relative(home, modules), saved: 'private-sdk/node_modules', stage: stageRelative, before, after: await snapshot(stage) };
}
export async function stageVerifiedFiles(tree, home, plugin, files, backup, stageRelative, installedRoot) {
    validateFiles(files);
    const info = await statfs(home, { bigint: true }), estimated = files.reduce((n, r) => n + (Number.isSafeInteger(r.bytes) && r.bytes >= 0 ? r.bytes : 1024 * 1024), 0);
    if (info.bavail * info.bsize < BigInt(estimated + 64 * 1024 * 1024))
        throw Error('Insufficient free space for private SDK staging and recovery reserve');
    await contained(home, path.relative(home, backup));
    const stage = path.join(backup, stageRelative);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await durableJson(path.join(backup, 'journal.json'), { version: 1, state: 'preparing', rows: [], guards: [] });
    await syncDirectory(path.dirname(backup));
    await mkdir(stage, { recursive: true, mode: 0o700 });
    let bytesTotal = 0;
    let filesCopied = 0, lastProgress = Date.now();
    for (const row of files) {
        const parts = /^(tree|plugin|installed):(.+)$/.exec(row.source ?? '');
        if (!parts)
            throw Error('Invalid private SDK source path');
        safeRelative(parts[2]);
        const base = parts[1] === 'tree' ? tree : parts[1] === 'plugin' ? plugin : installedRoot;
        if (!base) throw Error('Installed source is not bound for this migration');
        const source = await contained(base, parts[2]), stat = await lstat(source);
        if (!stat.isFile() || stat.isSymbolicLink() || !inside(await realpath(base), await realpath(source)))
            throw Error('Private SDK source outside tree or not regular');
        bytesTotal += stat.size;
        if (bytesTotal > 512 * 1024 * 1024)
            throw Error('Private SDK exceeds migration size limit');
        const bytes = await readFile(source);
        if (sha(bytes) !== row.sha256)
            throw Error('Private SDK source checksum mismatch: ' + row.relative);
        const target = path.join(stage, row.relative);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const fd = await open(target, 'wx', stat.mode & 0o777);
        try {
            await fd.writeFile(bytes);
            await fd.chmod(stat.mode & 0o777);
            await fd.sync();
        }
        finally {
            await fd.close();
        }
        filesCopied++;
        if (Date.now() - lastProgress >= 10000) {
            process.stderr.write(JSON.stringify({ phoneCoreMigrationProgress: { stage: 'private-staging', files: filesCopied, totalFiles: files.length, bytes: bytesTotal } }) + '\n');
            lastProgress = Date.now();
        }
    }
    if (inventoryKey(await regularInventory(stage)) !== inventoryKey(files))
        throw Error('Private SDK staged checksum mismatch');
    async function flush(dir) {
        for (const name of await readdir(dir)) {
            const p = path.join(dir, name);
            if ((await lstat(p)).isDirectory())
                await flush(p);
        }
        await syncDirectory(dir);
    }
    await flush(stage);
    return stage;
}
