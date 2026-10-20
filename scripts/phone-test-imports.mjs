// Tests resolve shared SDK imports through the pinned phone installation.
// This creates no dependency links in the source tree or production profile.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const canonical = new URL('../runtime/package.json', import.meta.url).href;
const selected = process.env.DSH_PHONE_TEST_MODULES
  ? pathToFileURL(path.join(process.env.DSH_PHONE_TEST_MODULES, '../package.json')).href : canonical;
const runtime = createRequire(selected);
const parents = [selected, canonical];
for (const name of ['@deepseek-ai/dsh', 'dsh-codearts-auth', 'dsh-peer']) {
  try { parents.push(pathToFileURL(runtime.resolve(name + '/package.json')).href); }
  catch (error) { if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error; }
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':') || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      for (const parentURL of parents) {
        try { return nextResolve(specifier, { ...context, parentURL }); }
        catch (candidate) { if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(candidate.code)) throw candidate; }
      }
      throw error;
    }
  },
});
