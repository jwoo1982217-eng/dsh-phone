#!/usr/bin/env node
// Recover only this profile's owned community overlay without booting DSH.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './core.js';
import { restorePrivateOverlay } from './community-overlay.js';

const OWNER = 'dsh-purge-community-private-runtime-v1';
const help = 'Usage: dsh-purge-community-recover --profile <name> --home <absolute DSH_HOME>\nAn existing absolute DSH_HOME can supply --home. No default home or profile is selected.';
function physicalDirectory(file) {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) throw new Error('Recovery requires a physical directory');
  return absolute;
}
function regularFile(file) {
  if (!path.isAbsolute(file || '')) throw new Error('Recovery metadata requires an absolute file path');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file)) throw new Error('Recovery metadata is not a physical regular file');
  return file;
}
export async function recoverCommunityProfile(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--home', '--profile'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error(help);
    options[key] = value;
  }
  const requestedHome = options['--home'] || process.env.DSH_HOME;
  const name = options['--profile'];
  if (!requestedHome || !path.isAbsolute(requestedHome) || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$/.test(name || '')) throw new Error(help);
  const home = physicalDirectory(fs.realpathSync(requestedHome));
  physicalDirectory(path.join(home, 'profiles'));
  const dir = physicalDirectory(path.join(home, 'profiles', name));
  const ownerDir = path.join(dir, '.dsh-purge-runtime');
  if (!fs.existsSync(ownerDir)) return { ok: true, restored: false, note: 'This profile has no community overlay.' };
  physicalDirectory(ownerDir);
  const owner = JSON.parse(fs.readFileSync(regularFile(path.join(ownerDir, 'owner.json')), 'utf8'));
  if (owner.owner !== OWNER || owner.profileDir !== dir) throw new Error('Recovery refuses metadata belonging to another profile');
  const stateFile = path.join(ownerDir, 'current.json');
  if (!fs.existsSync(stateFile)) return { ok: true, restored: false, note: 'This profile has no active community overlay.' };
  const state = JSON.parse(fs.readFileSync(regularFile(stateFile), 'utf8'));
  if (state.owner !== OWNER || state.profileDir !== dir) throw new Error('Recovery state belongs to another profile');
  if (state.phase === 'reverted') return { ok: true, restored: false, note: 'This profile has no active community overlay.' };
  const installAnchor = regularFile(state.profileInstallAnchor);
  const profile = { name, home, dir, installAnchor, patchPath: path.join(dir, 'cordis.patch.yml') };
  const ctx = { profileContext: profile, get: key => key === 'profileContext' ? profile : undefined };
  process.env.DSH_HOME = home;
  const result = await restorePrivateOverlay(ctx, { revert: async aiBase => {
    core.configureCommunityProfileScope(profile, { aiBase });
    const reverted = await core.revertAll(aiBase);
    if (reverted.errors?.length) throw new Error('Private core restore failed; owned metadata and backups were retained');
    return reverted;
  } });
  return { ok: true, restored: result.restored, currentProfileOnly: true, requiresManualRestart: result.restartRequired, note: result.restored ? 'Owned bundle selections and name mappings were restored. Later user configuration and retained copies were preserved. Quit and restart this DSH profile.' : 'This profile has no active community overlay.' };
}
let invokedAsMain = false;
try { invokedAsMain = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { /* Imported helpers are not a CLI invocation. */ }
if (invokedAsMain) {
  recoverCommunityProfile().then(result => console.log(result.help || JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
