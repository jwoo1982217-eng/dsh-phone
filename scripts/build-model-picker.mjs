import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'vendor/dsh-codearts-auth/package.json'));
const {transform} = require('esbuild');

/** Generate only the reviewed ModelSelect region, retaining the selected SDK's Host and renderer APIs. */
export async function buildModelPicker({
  runtimeRoot = path.join(root, root.includes('dsh-phone-public') ? 'runtime' : 'desktop-runtime'),
  overlayRoot = path.join(root, 'runtime/overlays'),
} = {}) {
  const name = '@deepseek-ai/dsh-client-ui-model-selection';
  const relative = name + '/lib/client.js';
  const metadata = JSON.parse(await readFile(path.join(runtimeRoot, 'node_modules', name, 'package.json'), 'utf8'));
  if (!['0.2.1-alpha.1', '0.2.1-rc.2'].includes(metadata.version)) {
    throw Error('Model picker requires reviewed pinned SDK 0.2.1-alpha.1 or 0.2.1-rc.2');
  }
  if (metadata.name !== name) throw Error('Model picker package identity mismatch');
  // Never choose an existing output as the base: it may belong to a different SDK release.
  const original = await readFile(path.join(runtimeRoot, 'node_modules', relative), 'utf8');
  const source = await readFile(path.join(root, 'runtime/client-src/model-picker.jsx'), 'utf8');
  const css = await readFile(path.join(root, 'runtime/client-src/model-picker.css'), 'utf8');
  const compiled = await transform(source, {loader:'jsx', jsxFactory:'react.createElement', jsxFragment:'react.Fragment', target:'es2022'});
  const startMark = '\t\t//#region lib/types/client/ModelSelect.js';
  const endMark = '\t\t//#region lib/types/client/locales.js';
  const start = original.indexOf(startMark);
  const end = original.indexOf(endMark, start);
  if (start < 0 || end < 0 || original.split(startMark).length !== 2 || original.split(endMark).length !== 2) {
    throw Error('Reviewed model picker boundaries missing or ambiguous');
  }
  if (!source.includes('conversation.input.model.label') || !source.includes('accountProviderName')) {
    throw Error('Reviewed picker source must preserve renderer label slots and account provider labels');
  }
  const replacement = `${startMark}\n// DSH model picker overlay v1\n// Reviewed SDK ${metadata.version}; optional renderer labels retain the Host model metadata.\n${compiled.code}\nconst pickerStyle = document.createElement('style');\npickerStyle.dataset.pluginCss = 'dsh-model-picker';\npickerStyle.textContent = ${JSON.stringify(css)};\ndocument.head.querySelector('style[data-plugin-css="dsh-model-picker"]')?.remove();\ndocument.head.appendChild(pickerStyle);\n\t\t//#endregion\n`;
  const target = path.join(overlayRoot, relative);
  await mkdir(path.dirname(target), {recursive:true});
  await writeFile(target, original.slice(0, start) + replacement + original.slice(end));
  return target;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildModelPicker(); console.log('Built reviewed composer model picker overlay');
}
