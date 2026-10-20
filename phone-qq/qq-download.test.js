import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('QQ download rejects HTTP errors, corrupt files, incorrect architectures and unsafe archives', () => {
  execFileSync('python3', [fileURLToPath(new URL('./qq-download.test.py', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
});
