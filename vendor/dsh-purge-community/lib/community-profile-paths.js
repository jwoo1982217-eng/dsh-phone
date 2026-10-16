// Launcher path validation shared by startup, private overlays and native guards.
import fs from 'node:fs';
import path from 'node:path';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CANDIDATE = new RegExp('^\\.community-candidate-(' + UUID + ')$');
const TRIAL = new RegExp('^\\.community-trial-(' + UUID + ')$');
// Android gives app processes a system-owned /data/user/0 -> /data/data
// alias. Normalize that one OS alias before the existing no-link checks.
// No application-created links or other Android users are followed here.
export function canonicalRuntimePath(value) {
  if (typeof value !== 'string' || process.platform !== 'android'
    || !/^\/data\/(?:user\/0|data)\/com\.dshphone\/files$/.test(process.env.DSH_PHONE_FILES || '')
    || !/^\/data\/user\/0\/com\.dshphone\/files(?:\/|$)/.test(value)) return value;
  try {
    const alias = fs.lstatSync('/data/user/0');
    if (alias.isSymbolicLink() && [0, 1000].includes(alias.uid)
      && fs.realpathSync('/data/user/0') === '/data/data') return '/data/data/' + value.slice('/data/user/0/'.length);
  } catch { /* Keep the original path; normal strict validation rejects it. */ }
  return value;
}
export function canonicalCommunityProfile(profile) {
  if (!profile) return profile;
  return { ...profile, ...Object.fromEntries(['home', 'dir', 'patchPath', 'installAnchor'].map(key => [key, canonicalRuntimePath(profile[key])])) };
}
function physicalDirectory(value) {
  value = canonicalRuntimePath(value);
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Community launcher paths must be absolute');
  const resolved = path.resolve(value);
  let current = resolved;
  while (true) {
    const entry = fs.lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Community launcher paths refuse linked directories');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const real = fs.realpathSync(resolved);
  if (real !== resolved) throw new Error('Community launcher paths must resolve to physical directories');
  return real;
}
function launcherFiles(profile, dir) {
  if (typeof profile.patchPath !== 'string' || !path.isAbsolute(profile.patchPath)
    || path.resolve(profile.patchPath) !== path.join(dir, 'cordis.patch.yml')) throw new Error('Current profile patch is outside the launcher profile');
  if (fs.existsSync(profile.patchPath)) {
    const entry = fs.lstatSync(profile.patchPath);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Current profile patch must be a regular file');
  }
  // Packaged and pnpm-installed runtimes may resolve through package links;
  // the anchor is read for resolution and is never a native write target.
  if (typeof profile.installAnchor !== 'string' || !path.isAbsolute(profile.installAnchor)
    || path.basename(profile.installAnchor) !== 'package.json'
    || !fs.statSync(profile.installAnchor).isFile()) throw new Error('A current launcher installation anchor is required');
}
export function validateCommunityProfilePaths(profile, options = {}) {
  profile = canonicalCommunityProfile(profile);
  if (!profile) throw new Error('A launcher-owned current profile is required');
  const home = physicalDirectory(profile.home);
  const dir = physicalDirectory(profile.dir);
  const candidate = CANDIDATE.exec(path.basename(dir));
  const trial = TRIAL.exec(path.basename(home));
  let mode = 'live';
  if (candidate || trial) {
    if (!candidate || !trial || candidate[1] !== trial[1]
      || path.dirname(dir) !== path.dirname(home) || profile.name !== 'desktop'
      || typeof process.env.DSH_DESKTOP_PROFILE_DIR !== 'string'
      || !path.isAbsolute(process.env.DSH_DESKTOP_PROFILE_DIR)
      || physicalDirectory(process.env.DSH_DESKTOP_PROFILE_DIR) !== dir) throw new Error('Community isolated trial paths do not match the current desktop launcher');
    mode = 'trial';
    launcherFiles(profile, dir);
  } else {
    const profiles = path.join(home, 'profiles');
    if (path.dirname(dir) !== profiles || dir === profiles) throw new Error('Community profile must belong to its DSH_HOME/profiles');
    if (options.requireLauncherFiles) launcherFiles(profile, dir);
  }
  if (options.requireHomeEnvironment || mode === 'trial') {
    const environment = process.env.DSH_HOME;
    if (typeof environment !== 'string' || !environment.trim() || !path.isAbsolute(environment)
      || physicalDirectory(environment) !== home) throw new Error('Current profile and absolute DSH_HOME disagree');
  }
  return { home, dir, mode };
}
export function assertCommunityLiveProfile(facts) {
  if (facts.mode !== 'live') throw new Error('Private host Apply and Revert are unavailable during an isolated community installation trial');
}
