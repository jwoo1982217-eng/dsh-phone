import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** Copy the real shipped lock implementation into isolated test deployments.
 * No mock lock and no dependence on a private work directory. */
export async function installNativeLockFixture(tree) {
    const root = process.env.DSH_MIGRATION_TEST_SDK_ROOT ? path.join(path.resolve(process.env.DSH_MIGRATION_TEST_SDK_ROOT),'@deepseek-ai') : fileURLToPath(new URL('../runtime/node_modules/@deepseek-ai/', import.meta.url));
    const target = path.join(tree, 'node_modules/@deepseek-ai');
    await mkdir(target, { recursive: true, dereference: true });
    await cp(path.join(root, 'node-addon-system'), path.join(target, 'node-addon-system'), { recursive: true, dereference: true });
    if (process.platform === 'darwin' || process.platform === 'linux') {
        const name = 'node-addon-system-' + process.platform + '-' + process.arch;
        await cp(path.join(root, name), path.join(target, name), { recursive: true, dereference: true });
    }
}
