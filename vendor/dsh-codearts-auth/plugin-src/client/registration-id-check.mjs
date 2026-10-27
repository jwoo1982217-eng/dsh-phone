/**
 * 插件身份自检的**唯一实现**（Gitee issue IKLUME）。
 *
 * ⚠️ 为什么单独成文件：同一套判据原先在 `build.mjs`（安装期闸门）与
 * `tests/unit/client-registration-id.spec.ts`（回归用例）里**各写一份**，
 * 2026-10 对抗审计实测它们已经漂移，而且是**同一时刻、同一个源文件、
 * 结论相反**：
 *   - `cordis.patch.yml` 里放两条都正确的 `name:`：闸门绿（要求「每一处都
 *     等于包名」）、用例红（要求「恰好一条」）；
 *   - `PLUGIN_ID` 改成双引号并把闸门那份正则收窄：闸门红、用例毫无反应。
 * 这正命中 AGENTS.md 的红线「一文件两套同义判据」（PR !62）。
 *
 * ⚠️ 另一条教训：**闸门本体必须有守卫**。审计把 `build.mjs` 里的
 * `if (problems.length > 0)` 改成 `if (false)`（等价于让整条安装期防护失效），
 * 实测 **21/21 全绿** —— 全仓找不出一条**代码**引用 `build.mjs`。
 * 修法是「判据全部住进本文件、由单测直接打」+「`build.mjs` 顶层无条件调用
 * `assertRegistrationIdFromFiles()`（没有分支可以短路，删掉调用即被接线断言抓住）」。
 *
 * 判据三层（每一层都能被单测直接打，不需要真去跑一次构建）：
 *   ① `jet-hub-styles.js` 的 `PLUGIN_ID` **声明**必须等于包名；
 *   ② 同一文件里的**署名使用点**不得写死字面量（审计 F2 的「声明对、使用点错」）；
 *   ③ `cordis.patch.yml` 的加载行 `name:` 必须等于包名。
 *
 * ⚠️ **已知射程**（如实登记，别把它当成全覆盖）：
 *   - ② 只拦「直接写字面量」；把正确的声明复制进一个同名遮蔽作用域、再用那个
 *     局部变量署名（审计 G13）拦不住 —— 那一格由**行为用例**拦（实测 8 条红），
 *     而行为用例在安装路径上不跑。
 *   - ③ 只认「`name:` 基本独占一行」的写法（行尾 `#` 注释已能剥离），且**对缩进
 *     深度不敏感**：`config:` 块里的 `name` 也会被当成加载行（审计 G5；本包当前
 *     的 patch 没有这种结构，属合成场景）。
 *   - 本文件只判「三个载体彼此的**文本/用法**关系」；产物里真正写进去的 id
 *     由 `readRegisteredId()` 从**最终文本**回读比对（审计 F1：原先那句
 *     `wrapped.startsWith(header)` 是恒真式，等于没查）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 三个身份载体在仓库里的相对路径（相对包根）。 */
export const IDENTITY_FILES = {
  manifest: 'package.json',
  styles: 'plugin-src/client/jet-hub-styles.js',
  patch: 'cordis.patch.yml',
};

/**
 * 读一个「**行首**字面量声明」的值；读不到返回 `null`。
 *
 * ⚠️ 行首锚定是必需的：本仓库有案底 —— 一条
 * `// const X = '新值'` 的注释就能让不锚定的源码正则守卫恒绿。
 * 单/双引号/反引号都接受，只认声明形态，不锁死在某个引号或缩进上。
 *
 * @param {string} source
 * @param {string} variableName
 * @returns {string | null}
 */
export function declaredValue(source, variableName) {
  const pattern = new RegExp(
    `^[ \\t]*(?:const|let|var)[ \\t]+${variableName}[ \\t]*=[ \\t]*['"\`]([^'"\`]+)['"\`]`,
    'm',
  );
  return pattern.exec(source)?.[1] ?? null;
}

/**
 * 剥掉 YAML 的行尾注释（`#` 只有**前接空白**时才是注释开始，引号内的 `#` 是值）。
 *
 * ⚠️ 审计 F4 实测：`name: "dsh-providers-hub" # 加载行` 是**完全合法的 YAML**
 * （DSH 自带的那份 `yaml` 解析器解析出的值正确），原先的判据却报
 * 「**没有找到加载行 name:**」并让安装硬失败 —— 最坏的一种误导：把一个
 * 惯用写法说成「你没写」。故必须先剥注释再匹配。
 *
 * @param {string} line
 * @returns {string}
 */
export function stripYamlComment(line) {
  let out = '';
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      out += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) break;
    out += char;
  }
  return out;
}

/**
 * 收集 `cordis.patch.yml` 里所有「加载行 `name:`」的值（已剥注释）。
 *
 * @param {string} patchSource
 * @returns {string[]}
 */
export function loadLineNames(patchSource) {
  const names = [];
  for (const rawLine of patchSource.split(/\r?\n/)) {
    const matched = /^[ \t]*name:[ \t]*['"]?([^'"\s#]+)['"]?[ \t]*$/.exec(stripYamlComment(rawLine));
    if (matched !== null) names.push(matched[1]);
  }
  return names;
}

/**
 * 从**最终产物文本**里回读注册 id（带引号，如 `"dsh-providers-hub"`）；读不到返回 `null`。
 *
 * ⚠️ 只有这一条能真正守住「产物注册的 id」。它对头部形态**不敏感**
 * （单行 / 多行、缩进任意），所以既不会像审计 S6 那样把行为等价的写法重构
 * 判成红，也不会像原先那句恒真式自检那样什么都不查。
 *
 * @param {string} bundleText
 * @returns {string | null}
 */
export function readRegisteredId(bundleText) {
  return /window\.__ModuleLoader__\.load\(\{\s*id:\s*("(?:[^"\\]|\\.)*")/.exec(bundleText)?.[1] ?? null;
}

/**
 * 判据本体（纯函数，不碰文件系统）。
 *
 * @param {{ loaderId: unknown, stylesSource: string, patchSource: string }} input
 * @returns {string[]} 问题清单，空数组 = 通过
 */
export function checkRegistrationId({ loaderId, stylesSource, patchSource }) {
  if (typeof loaderId !== 'string' || loaderId === '') {
    return ['package.json 的 name 缺失或不是非空字符串 —— 它是客户端注册 id 的唯一权威'];
  }
  const problems = [];
  // 审计 F9：包名带尾随空格时，原先两条 problem 都在指责**另外两个载体**
  // （「必须是 "dsh-providers-hub "，实际 "dsh-providers-hub"」），会把真正该改的
  // 地方藏起来。显式先判一次。
  if (loaderId !== loaderId.trim()) {
    problems.push(
      `package.json 的 name ${JSON.stringify(loaderId)} 首尾带空白 —— `
      + '**这才是真因**，不是另外两处载体写错了（包名不该带空白）',
    );
  }
  // ① 声明
  const stylesPluginId = declaredValue(stylesSource, 'PLUGIN_ID');
  if (stylesPluginId !== loaderId) {
    problems.push(
      `plugin-src/client/jet-hub-styles.js 的 PLUGIN_ID 必须是 ${JSON.stringify(loaderId)}，`
      + `实际 ${JSON.stringify(stylesPluginId)}`
      + '（它是样式标签 data-plugin 的取值，必须等于宿主 ownerId = 包名）',
    );
  }
  // ② 使用点：声明对、署名写死字面量 —— 闸门原先完全看不见这一格
  const literalOwner = /(?:\.(?:plugin|pluginCss)[ \t]*=[ \t]*['"`])|(?:setAttribute\([ \t]*['"]data-plugin['"][ \t]*,[ \t]*['"`])/
    .exec(stylesSource);
  if (literalOwner !== null) {
    problems.push(
      'plugin-src/client/jet-hub-styles.js 的样式署名必须用 PLUGIN_ID 变量，不得写死字面量'
      + '（写死时注入的 <style> 会不属于本插件，被别的插件 claimStyles 认领后连带删除，见 issue IKK764）',
    );
  }
  // ③ cordis.patch.yml 的加载行
  const patchNames = loadLineNames(patchSource);
  if (patchNames.length === 0) {
    problems.push(
      'cordis.patch.yml 里没有找到**可识别的**加载行 name: —— 宿主就是靠它解析出包名的'
      + '（本检查要求 name: 基本独占一行；行尾 # 注释会被剥离）',
    );
  } else {
    for (const name of patchNames) {
      if (name !== loaderId) {
        problems.push(
          `cordis.patch.yml 的加载行 name: 必须是 ${JSON.stringify(loaderId)}，实际 ${JSON.stringify(name)}`
          + '（它就是宿主 resolveSource() 读到的加载行名，最终变成 client entry id）',
        );
      }
    }
  }
  return problems;
}

/**
 * 从仓库里读三个载体再判一次（安装期闸门与单测共用的入口）。
 *
 * @param {{ rootDir: string }} input
 * @returns {string[]}
 */
export function checkRegistrationIdFromFiles({ rootDir }) {
  const manifest = JSON.parse(readFileSync(join(rootDir, IDENTITY_FILES.manifest), 'utf8'));
  return checkRegistrationId({
    loaderId: manifest.name,
    stylesSource: readFileSync(join(rootDir, IDENTITY_FILES.styles), 'utf8'),
    patchSource: readFileSync(join(rootDir, IDENTITY_FILES.patch), 'utf8'),
  });
}

/**
 * 安装期闸门：有问题就抛。
 *
 * ⚠️ `pnpm add git+…` 走的是 `prepare → build:all`，**不跑 vitest** ——
 * 只有这里能在安装路径上生效。所以 `build.mjs` 对它是**顶层无条件调用**，
 * 不给任何 `if` 可以短路（审计 F3 的变异正是 `if (problems.length > 0)` → `if (false)`）。
 *
 * @param {{ rootDir: string }} input
 * @returns {void}
 */
export function assertRegistrationIdFromFiles({ rootDir }) {
  const problems = checkRegistrationIdFromFiles({ rootDir });
  if (problems.length > 0) {
    throw new Error(`客户端注册 id 自检失败（issue IKLUME）：\n- ${problems.join('\n- ')}`);
  }
}