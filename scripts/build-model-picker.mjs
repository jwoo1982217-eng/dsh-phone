import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'vendor/dsh-codearts-auth/package.json'));
const {transform} = require('esbuild');
export async function buildModelPicker() {
const relative = '@deepseek-ai/dsh-client-ui-model-selection/lib/client.js';
const target = path.join(root, 'runtime/overlays', relative);
const runtime = path.join(root, root.includes('dsh-phone-public') ? 'runtime' : 'desktop-runtime');
if (JSON.parse(await readFile(path.join(runtime, 'node_modules/@deepseek-ai/dsh-client-ui-model-selection/package.json'))).version !== '0.2.1-alpha.1') throw Error('Model picker requires pinned SDK 0.2.1-alpha.1');
let original = await readFile(target, 'utf8').catch(error => {if (error.code !== 'ENOENT') throw error; return readFile(path.join(runtime, 'node_modules', relative), 'utf8');});
const source = await readFile(path.join(root, 'runtime/client-src/model-picker.jsx'), 'utf8');
const css = await readFile(path.join(root, 'runtime/client-src/model-picker.css'), 'utf8');
const compiled = await transform(source, {loader:'jsx', jsxFactory:'react.createElement', jsxFragment:'react.Fragment', target:'es2022'});
const start = original.indexOf('\t\t//#region lib/types/client/ModelSelect.js');
const end = original.indexOf('\t\t//#region lib/types/client/locales.js', start);
if (start < 0 || end < 0) throw Error('Pinned model picker boundaries missing');
const replacement = `\t\t//#region lib/types/client/ModelSelect.js\n// DSH model picker overlay v1\n${compiled.code}\nconst pickerStyle = document.createElement('style');\npickerStyle.dataset.pluginCss = 'dsh-model-picker';\npickerStyle.textContent = ${JSON.stringify(css)};\ndocument.head.querySelector('style[data-plugin-css="dsh-model-picker"]')?.remove();\ndocument.head.appendChild(pickerStyle);\n\t\t//#endregion\n`;
// Preserve Host directory, selection, command and locale implementation byte for byte.
await mkdir(path.dirname(target), {recursive:true});
await writeFile(target, original.slice(0, start) + replacement + original.slice(end));
return target;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildModelPicker(); console.log('Built pinned composer model picker overlay');
}
