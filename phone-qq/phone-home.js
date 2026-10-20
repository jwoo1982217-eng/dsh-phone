import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

// Android exposes the same app directory through two bind-mount paths.
// realpath alone does not collapse those aliases on every device.
export function canonicalPhonePath(directory) {
  let probe = path.resolve(directory), suffix = [];
  while (true) {
    try { probe = realpathSync(probe); break; }
    catch { const parent = path.dirname(probe); if (parent === probe) break; suffix.unshift(path.basename(probe)); probe = parent; }
  }
  let resolved = path.join(probe, ...suffix);
  const android = /^\/data\/user\/0\/([^/]+)(\/.*)?$/.exec(resolved);
  if (android) {
    const original = '/data/user/0/' + android[1], alias = '/data/data/' + android[1];
    try {
      const a = statSync(original), b = statSync(alias);
      if (a.dev === b.dev && a.ino === b.ino) resolved = alias + (android[2] ?? '');
    } catch { /* Only map aliases proven to be the same app directory. */ }
  }
  return resolved;
}

export function canonicalPhoneHome(env = process.env) {
  return canonicalPhonePath(realpathSync(env.DSH_HOME ?? path.join(env.HOME, '.dsh')));
}

export function phoneWorkspaceVisible(cwd, home, sharedStorage) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const current = canonicalPhonePath(cwd), root = canonicalPhonePath(home);
  const inside = directory => current === directory || current.startsWith(directory + '/');
  return current === root || inside(path.join(root, 'workspaces')) || inside(path.join(root, 'projects')) ||
    !!sharedStorage && inside(canonicalPhonePath(sharedStorage));
}
