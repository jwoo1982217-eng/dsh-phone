import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { assertRegistrationIdFromFiles, readRegisteredId } from './registration-id-check.mjs';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/client/jet-hub.js');

/**
 * 插件身份的唯一真源 = `package.json` 的 `name`（Gitee issue IKLUME）。
 *
 * ⚠️ 这里**绝不能**再写一个字面量：产物注册的 id 必须等于宿主
 * `dsh-client-modules` 按**加载行包名**建出的 client entry id
 * （`nearestPackage()` 要求 `package.json.name === 加载行 name`，
 *  `reconcilePackage()` 以包名为 key 写入模块表）。两边不一致时该 entry
 * 永远 import 不到，启动即 `N entry did not activate`。
 * 历史上包名从 `dsh-codearts-auth` 改成 `dsh-providers-hub` 时，正是
 * 「这里和 jet-hub-styles.js 各留一份旧字面量、测试又只比对这两份」漏过去的。
 */
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
const loaderId = packageJson.name;
if (typeof loaderId !== 'string' || loaderId.length === 0) {
  throw new Error('package.json 的 name 缺失或不是非空字符串 —— 无法确定客户端注册 id');
}

/**
 * ⚠️ **安装期闸门**：`pnpm add git+…` 走的是 `prepare → build:all`，
 * **不跑 vitest** —— 只有能在本文件里跑的断言才在安装路径上生效。
 *
 * 判据本体住在 `plugin-src/client/registration-id-check.mjs`：安装期闸门与
 * `tests/unit/client-registration-id.spec.ts` **共用同一份**（原先两边各写一份，
 * 2026-10 对抗审计实测它们已经漂移 —— 同一时刻、同一个源文件、结论相反）。
 * 这里对它是**顶层无条件调用**：没有 `if` 可以短路，删掉这一行就会被那份用例的
 * 接线断言抓住（审计 F3 的变异正是把条件改成 `if (false)`，当时 21/21 全绿）。
 */
assertRegistrationIdFromFiles({ rootDir: packageRoot });

const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  // 默认 charset 为 'ascii'，会把所有中文转义成 \uXXXX：产物可读性差，
  // 且使「用 includes 校验产物文案」的做法天然失效。改用 utf8 后产物保留原文，
  // 加载器按 utf8 读取 bundle（dsh-client-modules 用 "utf8" 解码），故安全。
  charset: 'utf8',
  external: ['react', 'react-dom'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

/**
 * 产物头部。⚠️ 宿主**连批量脚本是否命中都不看**，它只认
 * `__ModuleLoader__.load({ id })` 这一处注册 —— 故 id 由 `loaderId` 生成。
 */
const header = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(loaderId)},`;
const wrapped = `${header}
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;

/**
 * ⚠️ 写盘前**从最终文本回读**注册 id —— 这里以前写的是
 * `if (!wrapped.startsWith(header))`，而 `wrapped` 就是用 `header` 拼出来的，
 * 那个判断**恒真**，等于什么都没查（2026-10 对抗审计 F1 实测：把 id 表达式换成
 * 写死的旧名后构建仍 exit 0、产物注册错名，而成功日志照样打印正确的 id）。
 *
 * `readRegisteredId()` 对头部形态不敏感：单行 / 多行、缩进任意都不假红，
 * 但任何与包名不同的取值都会在这里中止。
 */
const writtenId = readRegisteredId(wrapped);
if (writtenId !== JSON.stringify(loaderId)) {
  throw new Error(
    `内部错误：产物里注册的 id 是 ${writtenId ?? '(没读到 __ModuleLoader__.load({ id: … }) 这处注册)'}，`
    + `与 package.json 的 name ${JSON.stringify(loaderId)} 不一致`,
  );
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`Wrote ${outputPath} (registered id: ${loaderId})`);