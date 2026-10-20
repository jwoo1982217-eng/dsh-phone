// Extract only the installed 2.0.26 pure palette engine; no updater/host/browser code.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const file=process.argv[2];if(!file)throw Error('Provide the original installed OpenCode 2.0.26 client bundle');
const source=await readFile(file,'utf8'),wanted=['resolve','map-dsh','font-names','generate','zh-names','registry','grouping','index'];
const chunks=source.split('(function () {');
const reviewed=[];
for(const chunk of chunks){const name=chunk.match(/__mods\["([\w-]+)"\] = /)?.[1];if(!wanted.includes(name))continue;const end=chunk.indexOf('})();');if(end<0)throw Error('Missing pure engine module '+name);reviewed.push('(function () {'+chunk.slice(0,end+5));}
if(reviewed.length!==wanted.length)throw Error('Pure engine boundaries changed');
const code='const __mods={"font-face":{FONT_FACE_CSS:""}};\n'+reviewed.join('\n')+'\nexport const engine=__mods["index"];export const names=__mods["zh-names"];\n';
// Validate the extracted deterministic engine before saving this derivative.
const engine=vm.runInNewContext(code.replace(/export const engine[\s\S]*$/,'__mods["index"]'),{console},{timeout:1000});if(engine.themeNames().length!==38||engine.auditAll().broken.length)throw Error('OpenCode palette audit failed');
await writeFile(new URL('./opencode-engine.mjs',import.meta.url),code);
await writeFile(new URL('./opencode-provenance.json',import.meta.url),JSON.stringify({package:'dsh-opencode-palette',version:'2.0.26',source:'https://github.com/FeatherHunter/dsh-opencode-palette',sourceSha256:createHash('sha256').update(source).digest('hex'),scope:'Pure appearance engine and 38 palettes; embedded fonts/updater/host functions excluded'},null,2));
console.log(JSON.stringify({themes:engine.themeNames().length,sourceSha256:createHash('sha256').update(source).digest('hex'),engineBytes:code.length}));
