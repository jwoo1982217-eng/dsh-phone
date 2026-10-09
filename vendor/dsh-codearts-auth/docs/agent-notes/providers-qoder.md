<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠️ 安装（git 插件）的 allowBuilds 键在 pnpm 10 / 11 语义**互不兼容**（Issue IKJCOC）

**用户报障**（2026-09-30，Gitee issue IKJCOC）：「DSH Desktop 内置 pnpm 下
`dsh plugin add` 安装失败：allowBuilds 的 git URL 键触发
`ERR_PNPM_INVALID_VERSION_UNION`」。报错里 `Found:` 的那个键，正是当时 README
「方式一」与本仓库 `pnpm-workspace.yaml` 里那行
`dsh-codearts-auth@git+https://gitee.com/iJetLi/deepseek-harness-codearts.git`。

**实测结论：这不是"换个键写法"就能了事，而是两代 pnpm 的键语义互不兼容** ——
同一个键在一代上"非法"、在另一代上"合法但永不匹配"。本机实测（Windows 11，
2026-09-30；依赖侧统一用**本地 git 仓库**里的同名包，带 `prepare` 脚本，
⚠️ **每个变体都换一个新 commit**，因为 pnpm 的 side-effect cache 命中时会跳过
allowBuilds 判定，不换 commit 会得到假的"成功"）：

| `allowBuilds` 键 | pnpm 10.28.0 | pnpm 11.7.0 |
|---|---|---|
| `dsh-codearts-auth@git+<url>`（旧 README / 旧仓库写法） | ❌ `ERR_PNPM_INVALID_VERSION_UNION` | ❌ `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`（缺 `#commit`，永不匹配） |
| `dsh-codearts-auth@git+<url>#<当前commit>`（**pnpm 自己打印的键**） | ❌ `ERR_PNPM_INVALID_VERSION_UNION` | ✅ 放行成功 |
| `dsh-codearts-auth@git+<url>#<旧commit>` | — | ❌ `NOT_ALLOWED`（换 commit 即失效） |
| `dsh-codearts-auth`（纯包名；**issue 建议的"已验证修复"**） | ✅ 放行成功 | ❌ `NOT_ALLOWED` |
| `dsh-codearts-auth@0.1.0`（精确版本） | — | ❌ `NOT_ALLOWED` |
| `dangerouslyAllowAllBuilds: true`（顶层） | ✅ | ✅ |
| `add --allow-build=dsh-codearts-auth`（CLI） | — | ❌（它只写入纯包名键，本次仍不放行） |

- pnpm 11.7.0 取自本机安装的 DSH Desktop：
  `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\pnpm`
  （`DeepSeek Harness.exe` 的 FileVersion `0.2.0-rc.2`）；pnpm 10.28.0 用
  `npx pnpm@10.28.0`（issue 报告的内置版本是「10.28.0 定制构建」，与本机这版**不同**，
  故两代都必须覆盖）。
- ⚠️ **issue 建议的纯包名键不能直接采纳**：它只在 pnpm 10 上有效。pnpm 11 的
  `createAllowBuildFunction` 里
  `trustPackageIdentity = name && version && !nonSemverVersion` —— git 包的
  `nonSemverVersion` 非空 ⇒ 直接 `return undefined`，**纯包名/精确版本键一律不参与匹配**，
  只有 `allowedDepPathBuilds` 里的 `name@git+...#sha` 能命中。
- ⚠️ **pnpm 10 的坑更深：它连自己打印的键都拒绝**。11.7.0 有 `isDepPathAllowBuildKey()`
  把含 `:` / `/` / `#` 的键当 depPath 键，从而**绕开**版本并集解析；10.28.0 没有这层保护，
  所有键都走 `parseVersionPolicyRule()` → `semver.valid('git+https://…')` 为 `null` →
  抛 `INVALID_VERSION_UNION`。⇒ pnpm 10 上「复制 pnpm 打印的键」这条官方提示**走不通**，
  只能写纯包名键或 `dangerouslyAllowAllBuilds: true`。
- ⚠️ **失败表现的版本差异**（排查时先看这个）：本机 desktop（11.7.0）**不复现**
  `ERR_PNPM_INVALID_VERSION_UNION`，而是报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；
  两者根因同为"那个键不可用"。**不要**因为报错文案与 issue 不一致就判定"desktop 下没问题"。
- ⚠️ **pnpm 只对 git 托管包打印提示、不写占位符**（实测 `pnpm-workspace.yaml` 未被改动），
  所以 DSH 的「允许这些脚本并重试」按钮覆盖不到 git 插件安装 ——
  `readPendingBuilds`（`packages/boot/plugin-manager/src/build-approval.ts`）只认值为
  `set this to true or false` 的条目。用户只能手写键。这属 DSH 侧可改进项，不在本仓库范围。

**端到端复现与修复验证**（本机、离线、不动工作区；`git clone` 到临时目录后按场景改写
并 **commit** —— ⚠️ pnpm 取的是**提交内容**，只在工作区覆盖文件是无效的，第一次就这么白跑了一遍）：

| 场景 | 结果 |
|---|---|
| 修复前（仓库保留那行 git 键）+ pnpm 10.28.0，profile 已按 issue 写纯包名键 | ❌ 插件自己的 `pnpm install` 阶段：`ERR_PNPM_INVALID_VERSION_UNION … Found: "dsh-codearts-auth@git+https://…"` → `ERR_PNPM_PREPARE_PACKAGE … Exit status 1`（issue 描述的第二个失败点，原样复现） |
| 修复后（删掉那行键）+ pnpm 10.28.0 + profile 纯包名键 | ✅ install + `prepare`（tsc / copy-assets / client 打包）跑通，`lib/index.js` 产出 |
| 修复后 + DSH Desktop 内置 pnpm 11.7.0 + profile 精确键（`…#<commit>`） | ✅ 85 个依赖装好、`esbuild` postinstall 执行、`prepare` 全跑通（`lib/qoder-auth-wasm.wasm`、`lib/client/jet-hub.js` 均产出） |

⇒ **两条不要改回去的红线**：

1. **本仓库 `pnpm-workspace.yaml` 里不得出现 `包名@git+URL` 键**。本包不依赖
   `dsh-codearts-auth`，该键永远匹配不上；而在 pnpm 10.x 下它会**毒化整个 clone**：
   从 git 安装时 pnpm 要在 clone 里跑 `pnpm install`，读到这行即抛
   `ERR_PNPM_INVALID_VERSION_UNION`，`prepare`（`pnpm build:all`）根本起不来。
   （`esbuild: true` 必须保留 —— registry 包的版本是 semver，纯名键在两代都生效。）
2. **README「方式一」的放行键必须按 pnpm 大版本分别给出**，不能把某一代的写法写成通用解。
   唯一跨版本可用的是 `dangerouslyAllowAllBuilds: true`（代价：放行该 profile 里所有依赖的
   构建脚本）。改完请照上表重跑一遍验证 —— 尤其**要换新 commit**，否则缓存会骗你。
