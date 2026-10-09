import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 兜底登录链接必须有复制按钮（授权 URL 300+ 字符，手工框选漏字符会得到「授权失败」假象）。
 *
 * react 不在单测依赖里（`node_modules/react` 不存在），组件渲染不了，
 * 所以这里只钉源码契约 —— 用 `\s` 跨空白，源文件是 CRLF。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8');
const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8');

describe('兜底登录链接的复制按钮', () => {
  it('链接与按钮同在一个 flex 行里', () => {
    expect(source).toMatch(/className:\s*'dim-jh-loginLinkRow'/);
    expect(source).toMatch(/className:\s*'dim-jh-loginLink'/);
  });

  it('按钮调用 copyToClipboard 并回写三态文案', () => {
    expect(source).toMatch(/onClick:\s*async\s*\(\)\s*=>\s*setLoginLinkCopied\(await copyToClipboard\(loginUrlForManual\)\)/);
    expect(source).toContain("'已复制 ✓'");
    expect(source).toContain('复制失败，请手动选中');
  });

  it('按钮写 type=button —— 落在表单里默认 submit 会连带提交表单', () => {
    expect(source).toMatch(/type:\s*'button'/);
  });

  it('换新链接时复位复制状态，不残留「已复制 ✓」', () => {
    expect(source).toMatch(/setLoginUrlForManual\(loginUrl\);\s*\n\s*setLoginLinkCopied\(null\);/);
  });

  it('样式给链接 min-width: 0，否则长 URL 把按钮顶出可视区', () => {
    expect(styles).toMatch(/\.dim-jh-loginLinkRow\s*\{[^}]*display:\s*flex/);
    expect(styles).toMatch(/\.dim-jh-loginLink\s*\{[^}]*min-width:\s*0/);
  });

  it('复制失败时链接一次点击全选，用户能直接 Ctrl+C', () => {
    expect(styles).toMatch(/\[data-copy-state="failed"\]\s*\.dim-jh-loginLink\s*\{[^}]*user-select:\s*all/);
    expect(source).toMatch(/'data-copy-state':\s*loginLinkCopied === false \? 'failed' : 'idle'/);
  });
});
