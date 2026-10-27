import { readFile, readdir, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inventoryDigest,compatibilityActionDigest } from './compatibility-packages.js';
import { safeRelative, inside, durableJson } from './core-transaction.js';
const sha = b => createHash('sha256').update(b).digest('hex');
const packageName = rel => rel.startsWith('@') ? rel.split('/').slice(0, 2).join('/') : rel.split('/')[0];
const exists = async (p) => {
    try {
        return await realpath(p);
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return null;
        throw e;
    }
};
/** Build-time only. Resolve every required dependency into an independently
 * loadable closure; never import packages, run npm scripts or read a profile.
 * A preservation receipt must account for every known non-baseline code delta. */
export async function buildPrivateSdkPlan({ tree, baselineFiles, variantsDirectory, preservations = [], requiredPreservations = [], outputFile, compatibilityPackages = [], targetPlatform = 'android', targetArch = 'arm64', bootPackage = '@deepseek-ai/dsh' }) {
    tree = await realpath(tree);
    const modules = path.join(tree, 'node_modules'), plugin = path.join(modules, 'dsh-phone-qq'), core = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
    // CLI boot owns AppBoot's Include and resolver identities. A closure rooted
    // only at the old plugin inventory silently leaves that owner in the host
    // tree while preset/scope consumers use private module-local state.
    // null is an explicit build-fixture opt-out, never a deployable boot plan.
    if (bootPackage !== null && bootPackage !== '@deepseek-ai/dsh')
        throw Error('Unsupported private SDK boot package');
    if (bootPackage === null && outputFile)
        throw Error('A non-boot build-fixture plan cannot publish an output file');
    const boot = bootPackage === null ? null : { package: bootPackage, entry: bootPackage + '/lib/bin.js' };
    if (boot) {
        if (core.name !== bootPackage || typeof core.version !== 'string' || core.type !== 'module')
            throw Error('Private CLI package identity is invalid');
        const declared = typeof core.bin === 'string' ? core.bin : core.bin?.dsh;
        if (typeof declared !== 'string' || declared.replace(/^\.\//, '') !== 'lib/bin.js')
            throw Error('Private CLI boot entry is not the maintained bin');
        const entry = path.join(modules, boot.entry), directory = await realpath(path.join(modules, boot.package));
        let stat;
        try { stat = await lstat(entry); }
        catch (error) { if (error.code === 'ENOENT') throw Error('Private CLI boot entry is missing'); throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || !inside(directory, await realpath(entry)))
            throw Error('Private CLI boot entry must be a regular package file');
    }
    const baselines = [];
    for (const file of baselineFiles) {
        const b = JSON.parse(await readFile(file, 'utf8'));
        if (!b.id || !Array.isArray(b.files) || !b.files.length)
            throw Error('Invalid private SDK baseline');
        for (const row of b.files) {
            safeRelative(row.relative);
            if (!/^[a-f0-9]{64}$/.test(row.sha256))
                throw Error('Invalid private SDK baseline hash');
        }
        baselines.push(b);
    }
    requiredPreservations = [...requiredPreservations, ...baselines.flatMap(b => b.requiredPreservations ?? [])];
    const roots = [...new Set([...baselines.flatMap(b => b.files.filter(r => r.relative.endsWith('/package.json') && !r.relative.includes('/node_modules/')).map(r => packageName(r.relative))), ...(boot ? [boot.package] : [])])];
    const assigned = new Map(), queue = [], files = [], packages = [];
    let total = 0;
    async function add(relative, source) {
        safeRelative(relative);
        source = await realpath(source);
        if (!inside(tree, source))
            throw Error('SDK closure source outside tree');
        const previous = assigned.get(relative);
        if (previous) {
            if (previous !== source)
                throw Error('SDK closure dependency collision: ' + relative);
            return;
        }
        assigned.set(relative, source);
        queue.push({ relative, source });
    }
    for (const name of roots)
        await add(name, path.join(modules, name));
    async function resolveDependency(source, name) {
        let dir = source;
        while (inside(tree, dir)) {
            const candidate = path.join(dir, 'node_modules', name), p = await exists(path.join(candidate, 'package.json'));
            if (p)
                return await realpath(candidate);
            if (dir === tree)
                break;
            dir = path.dirname(dir);
        }
        return null;
    }
    function visible(relative, name) {
        let dir = relative;
        while (dir && dir !== '.') {
            const v = assigned.get(dir + '/node_modules/' + name);
            if (v)
                return { relative: dir + '/node_modules/' + name, source: v };
            dir = path.posix.dirname(dir);
            if (dir === 'node_modules')
                break;
        }
        const top = assigned.get(name);
        return top ? { relative: name, source: top } : null;
    }
    for (let i = 0; i < queue.length; i++) {
        const p = queue[i], manifest = JSON.parse(await readFile(path.join(p.source, 'package.json'), 'utf8'));
        if (!manifest.name || !manifest.version)
            throw Error('Invalid closure package manifest');
        if (/^@deepseek-ai\/dsh(?:-|$)/.test(manifest.name) && manifest.version !== core.version)
            throw Error('SDK closure version mismatch: ' + manifest.name);
        packages.push({ relative: p.relative, name: manifest.name, version: manifest.version });
        const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies };
        for (const name of Object.keys(dependencies).sort()) {
            if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name))
                throw Error('Invalid SDK dependency name');
            const optional = !!manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional;
            const source = await resolveDependency(p.source, name);
            if (!source) {
                if (optional)
                    continue;
                throw Error('Private SDK missing dependency ' + name + ' for ' + manifest.name);
            }
            if (optional) {
                const platform = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
                const permits = (list, value) => !Array.isArray(list) || (!list.includes('!' + value) && (!list.some(x => !x.startsWith('!')) || list.includes(value)));
                if (!permits(platform.os, targetPlatform) || !permits(platform.cpu, targetArch))
                    continue;
            }
            const old = visible(p.relative, name);
            if (old?.source === source)
                continue;
            const top = await exists(path.join(modules, name));
            const relative = top === source ? name : p.relative + '/node_modules/' + name;
            await add(relative, source);
        }
    }
    for (const p of queue) {
        async function visit(dir, prefix) {
            for (const name of (await readdir(dir)).sort()) {
                if (name === 'node_modules')
                    continue;
                const source = path.join(dir, name), stat = await lstat(source), rel = prefix ? prefix + '/' + name : name;
                if (stat.isDirectory())
                    await visit(source, rel);
                else if (stat.isFile()) {
                    const relative = p.relative + '/' + rel;
                    let bytes = await readFile(source), from = 'tree:' + path.relative(tree, source).split(path.sep).join('/');
                    if (variantsDirectory) {
                        const variant = path.join(variantsDirectory, relative);
                        try {
                            const s = await lstat(variant);
                            if (!s.isFile() || s.isSymbolicLink())
                                throw Error('Invalid private SDK variant');
                            const originalBytes = bytes;
                            bytes = await readFile(variant);
                            if (rel === 'package.json' && sha(bytes) !== sha(await readFile(source)))
                                throw Error('Private SDK variants must preserve target package metadata');
                            if (sha(bytes) !== sha(originalBytes)) from = await saveVariant(bytes);
                        }
                        catch (e) {
                            if (e.code !== 'ENOENT')
                                throw e;
                        }
                    }
                    total += bytes.length;
                    if (files.length >= 100000 || total > 512 * 1024 * 1024)
                        throw Error('Private SDK closure exceeds size limit');
                    files.push({ relative, sha256: sha(bytes), bytes: bytes.length, source: from });
                }
                else
                    throw Error('Non-regular SDK package source: ' + p.relative + '/' + rel);
            }
        }
        await visit(p.source, '');
    }
    async function saveVariant(bytes) {
        const relative = 'private-sdk-patches/v2-' + sha(bytes) + '.dat', file = path.join(plugin, relative);
        await mkdir(path.dirname(file), { recursive: true });
        try {
            await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
            if (sha(await readFile(file)) !== sha(bytes))
                throw Error('Private variant content-address collision');
        }
        return 'plugin:' + relative;
    }
    if (variantsDirectory) {
        async function additions(dir, prefix) {
            for (const name of (await readdir(dir)).sort()) {
                // Variant fixture dependencies are never sources for the shipped closure.
                if(name === 'node_modules') continue;
                const file = path.join(dir, name), s = await lstat(file), relative = prefix ? prefix + '/' + name : name;
                safeRelative(relative);
                if (s.isDirectory())
                    await additions(file, relative);
                else if (s.isFile()) {
                    if (files.some(r => r.relative === relative))
                        continue;
                    const owner = packages.find(p => relative.startsWith(p.relative + '/') && !relative.slice(p.relative.length + 1).includes('/node_modules/'));
                    if (!owner)
                        throw Error('Variant outside private SDK closure: ' + relative);
                    const bytes = await readFile(file);
                    total += bytes.length;
                    if (files.length >= 100000 || total > 512 * 1024 * 1024)
                        throw Error('Private SDK closure exceeds size limit');
                    files.push({ relative, sha256: sha(bytes), bytes: bytes.length, source: await saveVariant(bytes) });
                }
                else
                    throw Error('Invalid SDK variant file');
            }
        }
        await additions(variantsDirectory, '');
    }
    const target = new Map(files.map(r => [r.relative, r.sha256]));
    for (const required of requiredPreservations) {
        safeRelative(required.relative);
        const receipt = preservations.find(p => p.relative === required.relative && p.beforeSha256 === required.sha256 && p.afterSha256 === target.get(required.relative) && ['merged', 'maintained-upstream'].includes(p.disposition) && typeof p.verification === 'string' && p.verification.trim());
        if (!receipt)
            throw Error('Unverified private SDK preservation: ' + required.relative);
    }
    const conditionalPackages = await buildCompatibilityPackagePlans(tree, compatibilityPackages);
    const plan = { version: 2, sdkVersion: core.version, boot, baselines, compatibilityPackages: conditionalPackages, files: files.sort((a, b) => a.relative.localeCompare(b.relative, 'en')), packages: packages.sort((a, b) => a.relative.localeCompare(b.relative, 'en')), preservations: requiredPreservations.map(r => preservations.find(p => p.relative === r.relative && p.beforeSha256 === r.sha256)) };
    if (outputFile)
        await durableJson(outputFile, plan);
    return plan;
}
/** Build a minimal compatibility payload. Only five maintained public files
 * ship; complete private-installed extras are represented by inventory hashes.
 * A full private baseline is a build input, never embedded in the output plan.
 * A previously computed bound fingerprint can reproduce later identical builds.
 */
export async function buildCompatibilityPackagePlans(tree,specs){
 if(!Array.isArray(specs)||specs.length>8)throw Error('Invalid compatibility package specs');
 const plans=[];
 for(const spec of specs){
  if(! /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(spec.name)||spec.target!=='profiles/phone/node_modules/'+spec.name||!Array.isArray(spec.baselineFiles)||typeof spec.verification!=='string'||!spec.verification.trim())throw Error('Unverified compatibility package adaptation');
  const root=path.join(tree,'node_modules',spec.name),source=await realpath(root);if(!inside(await realpath(tree),source))throw Error('Compatibility source outside deployment');
  const metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));if(metadata.name!==spec.name||typeof metadata.version!=='string')throw Error('Compatibility package identity mismatch');
  if(!Array.isArray(spec.replacementPaths)||!spec.replacementPaths.length||spec.replacementPaths.length>10000)throw Error('Explicit compatibility replacements required');
  const replacements=[];for(const relative of spec.replacementPaths){safeRelative(relative);const file=path.join(root,relative),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid compatibility source');const bytes=await readFile(file);replacements.push({relative,sha256:sha(bytes),bytes:bytes.length,source:'tree:node_modules/'+spec.name+'/'+relative});}
  const removals=spec.removals??[];for(const r of removals){safeRelative(r.relative);if(!/^[a-f0-9]{64}$/.test(r.beforeSha256))throw Error('Invalid compatibility removal');}
  const boundActionSha256=compatibilityActionDigest(replacements,removals),baselines=[];
  for(const file of spec.baselineFiles){const b=JSON.parse(await readFile(file,'utf8'));if(!b.id)throw Error('Invalid compatibility baseline');if(Array.isArray(b.files)&&b.files.length){for(const r of b.files){safeRelative(r.relative);if(!/^[a-f0-9]{64}$/.test(r.sha256))throw Error('Invalid compatibility baseline hash');}const after=new Map(b.files.map(r=>[r.relative,r]));for(const r of removals){if(after.get(r.relative)?.sha256!==r.beforeSha256)throw Error('Unrecognized compatibility removal baseline');after.delete(r.relative);}for(const r of replacements)after.set(r.relative,r);baselines.push({id:b.id,beforeSha256:inventoryDigest(b.files),afterSha256:inventoryDigest([...after.values()]),filesBefore:b.files.length,filesAfter:after.size,boundActionSha256});}else{if(b.boundActionSha256!==boundActionSha256||!/^[a-f0-9]{64}$/.test(b.beforeSha256)||!/^[a-f0-9]{64}$/.test(b.afterSha256))throw Error('Compatibility fingerprint is bound to different replacements/actions');baselines.push(b);}}
  plans.push({mode:'preserve-installed-with-replacements-v1',name:spec.name,target:spec.target,version:metadata.version,baselines,replacements,removals,verification:spec.verification});
 }
 return plans;
}
