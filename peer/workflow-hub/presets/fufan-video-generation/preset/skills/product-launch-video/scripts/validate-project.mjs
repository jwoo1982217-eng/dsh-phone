#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const projectArg = process.argv[2];
if (!projectArg) {
  console.error('用法：node validate-project.mjs <generated-project>');
  process.exit(2);
}

const root = path.resolve(projectArg);
const required = ['RESEARCH.md', 'BRIEF.md', 'frame.md', 'STORYBOARD.md', 'hyperframes.json', 'package.json', 'index.html'];
const failures = [];

for (const name of required) {
  if (!fs.existsSync(path.join(root, name))) failures.push(`缺少 ${name}`);
}

const framesDir = path.join(root, 'compositions', 'frames');
const frames = fs.existsSync(framesDir)
  ? fs.readdirSync(framesDir).filter((name) => name.endsWith('.html')).sort()
  : [];
if (frames.length < 3) failures.push(`frame HTML 只有 ${frames.length} 个，至少需要 3 个`);

const textFiles = [
  ...required.filter((name) => fs.existsSync(path.join(root, name))).map((name) => path.join(root, name)),
  ...frames.map((name) => path.join(framesDir, name)),
];
const combined = textFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const research = fs.existsSync(path.join(root, 'RESEARCH.md'))
  ? fs.readFileSync(path.join(root, 'RESEARCH.md'), 'utf8')
  : '';
const sourceUrls = [...new Set(research.match(/https?:\/\/[^\s|)>]+/g) ?? [])];

if (/deepseek-harness-product-launch-22s\.mp4|assets\/screens\/formal|\.\.\/output\//i.test(combined)) {
  failures.push('发现旧案例素材或旧成片引用');
}
if (/https?:\/\//i.test(
  [path.join(root, 'index.html'), ...frames.map((name) => path.join(framesDir, name))]
    .filter(fs.existsSync)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n'),
)) {
  failures.push('生成的 HTML 含远程 URL；请改用本地脚本、字体和素材');
}
if (!/data-composition-id=/i.test(combined)) failures.push('未发现 data-composition-id');
if (!/window\.__timelines/i.test(combined)) failures.push('未注册 HyperFrames timeline');
if (!/music:\s*none/i.test(combined)) failures.push('无配音快路径必须在 STORYBOARD.md 标记 music: none');
if (!/status:\s*animated/i.test(combined)) failures.push('STORYBOARD.md 尚未把完成段落标记为 animated');
if (sourceUrls.length < 8) failures.push(`RESEARCH.md 只有 ${sourceUrls.length} 个去重来源，至少需要 8 个`);
if (!/产品事实[\s\S]*用户问题[\s\S]*同类表达[\s\S]*视觉线索/i.test(research)) {
  failures.push('RESEARCH.md 未覆盖产品事实、用户问题、同类表达和视觉线索四个维度');
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, root, frames: frames.length, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  root,
  artifacts: required,
  frames,
  checks: ['fresh-artifacts', 'no-case-reuse', 'local-assets', 'hyperframes-contract', 'silent-marker'],
  researchSources: sourceUrls.length,
}, null, 2));
