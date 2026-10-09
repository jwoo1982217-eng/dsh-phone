import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

/** Only shipped UI code is offered for reuse; no user files or API data. */
export function loadReusableUiScripts() {
  try {
    const file = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-ui-settings-account/client');
    let source = readFileSync(file, 'utf8');
    source = source.replace(/(?:\r?\n)?\/\/# sourceURL=[^\r\n]*(?:\r?\n)?$/, '')
      .replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/, '');
    if (!source.endsWith('\n')) source += '\n';
    const bytes = Buffer.from(source);
    return bytes.length >= 1048576 && bytes.length <= 8388608 ? [bytes] : [];
  } catch { return []; }
}
