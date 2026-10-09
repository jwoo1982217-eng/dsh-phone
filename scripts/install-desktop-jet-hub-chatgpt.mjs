import { readFile, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = path.join(root, 'vendor/dsh-codearts-auth');
const digest = data => createHash('sha256').update(data).digest('hex');
const readOptional = async file => {
  try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export async function installDesktopJetHubChatGpt(directory) {
  directory = await realpath(path.resolve(directory));
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-codearts-auth') throw Error('请选择电脑正在使用的 Jet Hub 插件目录');
  const baseline = JSON.parse(await readFile(path.join(root, 'desktop-chatgpt/jet-hub-source-hashes.json'), 'utf8'));
  const names = [...Object.keys(baseline), 'plugin-src/client/chatgpt-plan-panel.js', 'plugin-src/client/chatgpt-plan-rpc.js'];
  const plan = new Map(), originals = new Map();
  for (const name of names) {
    const file = path.join(directory, name), original = await readOptional(file), next = await readFile(path.join(sourceRoot, name));
    const hash = original && digest(original);
    if (hash !== digest(next) && (baseline[name] ? hash !== baseline[name] : original !== null)) {
      throw Error(`Jet Hub ${name} 与已核对版本不同，未覆盖任何文件`);
    }
    originals.set(file, original); plan.set(file, next);
  }

  // Compile the complete existing client with only these files overlaid. Nothing is
  // written until compilation succeeds, so unrelated desktop additions remain intact.
  const { build } = createRequire(path.join(directory, 'package.json'))('esbuild');
  const result = await build({
    entryPoints: [path.join(directory, 'plugin-src/client/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: ['chrome100'],
    charset: 'utf8', external: ['react', 'react-dom'], write: false,
    minify: process.env.NODE_ENV === 'production', legalComments: 'none',
    plugins: [{ name: 'chatgpt-account-overlay', setup(builder) {
      builder.onResolve({ filter: /^\./ }, args => {
        const file = path.resolve(path.dirname(args.importer), args.path);
        return plan.has(file) ? { path: file } : null;
      });
      builder.onLoad({ filter: /\.[cm]?js$/ }, args => plan.has(args.path)
        ? { contents: plan.get(args.path).toString('utf8'), loader: 'js', resolveDir: path.dirname(args.path) } : null);
    } }],
  });
  const bundled = result.outputFiles?.[0]?.text;
  if (!bundled) throw Error('Jet Hub 客户端编译未产出 bundle');
  const output = path.join(directory, 'lib/client/jet-hub.js');
  originals.set(output, await readOptional(output));
  plan.set(output, Buffer.from(`window.__ModuleLoader__.load({
  id: "dsh-codearts-auth",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`));
  for (const [file, original] of originals) {
    const current = await readOptional(file);
    if (current === null ? original !== null : original === null || !current.equals(original)) throw Error('Jet Hub 在编译中变化，未覆盖任何文件');
  }
  const written = [], temporary = [];
  try {
    for (const [file, next] of plan) {
      if (originals.get(file)?.equals(next)) continue;
      const temp = file + '.chatgpt-' + randomUUID(); temporary.push(temp);
      await writeFile(temp, next); await rename(temp, file); written.push(file);
    }
  } catch (error) {
    for (const file of written.reverse()) {
      const original = originals.get(file);
      if (original === null) await rm(file, { force: true }); else await writeFile(file, original);
    }
    throw error;
  } finally { await Promise.all(temporary.map(file => rm(file, { force: true }))); }
  return { directory, entry: '设置 → Jet Hub → ChatGPT 会员', files: [...plan].map(([file, data]) => ({ file: path.relative(directory, file), sha256: digest(data) })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await installDesktopJetHubChatGpt(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
