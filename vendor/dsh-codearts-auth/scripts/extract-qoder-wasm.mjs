// 从本机 Qoder 安装提取内嵌 WASM，刷新 `src/qoder-auth-wasm.wasm`。
//
// ## 何时需要跑
//
// Qoder 升级后签名协议可能变化。判据：对话报 `Signature invalid` /
// 或服务端返回难以解释的 `[FAIL]node:...`。
//
// ## 用法
//
// ```
// node scripts/extract-qoder-wasm.mjs            # 自动找最新版本
// node scripts/extract-qoder-wasm.mjs 0.3.4      # 指定版本
// ```
//
// 之后必须 `pnpm build:assets`（或 `pnpm build:all`）把新 WASM 同步到 `lib/`。
//
// ## 为什么用 `.qoder-versions/<v>` 而不是 `resources/`
//
// Qoder 会把各版本解到 `.qoder-versions/<version>/`，而 `resources/` 可能
// 指向与 IDE 实际运行的**不同**版本（实测 IDE 用 0.3.4，但 `resources/`
// 下是别的）。取实际运行的那个才与线上签名一致。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const OUT = resolve(packageRoot, 'src/qoder-auth-wasm.wasm')

/** Qoder 安装根（可用 `DSH_QODER_HOME` 覆盖）。 */
const QODER_HOME = process.env.DSH_QODER_HOME
  ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Qoder')

/** 从 `runtime-info.json` 读版本（比目录名可靠）。 */
function runtimeVersion(workerDir) {
  try {
    const info = JSON.parse(readFileSync(join(workerDir, 'runtime-info.json'), 'utf8'))
    return typeof info.version === 'string' ? info.version : undefined
  } catch {
    return undefined
  }
}

/** 候选 `_worker` 目录，按版本号降序。 */
function candidateWorkerDirs() {
  const out = []
  const versionsDir = join(QODER_HOME, '.qoder-versions')
  if (existsSync(versionsDir)) {
    for (const name of readdirSync(versionsDir)) {
      const dir = join(versionsDir, name, 'resources', 'app.asar.unpacked', 'node_modules',
        '@qoder-ai', 'qoder-agent-sdk', 'dist', '_worker')
      if (existsSync(dir)) out.push({ label: `versions/${name}`, dir, version: runtimeVersion(dir) })
    }
  }
  const plain = join(QODER_HOME, 'resources', 'app.asar.unpacked', 'node_modules',
    '@qoder-ai', 'qoder-agent-sdk', 'dist', '_worker')
  if (existsSync(plain)) out.push({ label: 'resources', dir: plain, version: runtimeVersion(plain) })
  return out.sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))
}

/** 在 obf.mjs 里找出含目标导出的那个 base64 WASM。 */
function extractWasm(obfPath) {
  const content = readFileSync(obfPath, 'utf8')
  let from = 0
  for (;;) {
    const i = content.indexOf('AGFzbQ', from)
    if (i < 0) break
    from = i + 1
    const q = content.lastIndexOf('"', i)
    const e = content.indexOf('"', i)
    if (q < 0 || e <= q) continue
    const literal = content.slice(q + 1, e)
    if (!/^[A-Za-z0-9+/=]+$/.test(literal)) continue
    const bytes = Buffer.from(literal, 'base64')
    try {
      const names = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((x) => x.name)
      // 认准含全部关键私有函数的那个模块（只匹配一个函数会挑错模块）
      if (names.includes('model_cache_decrypt') && names.includes('qodercontext_prepareInferRequest')) {
        return { bytes, exportCount: names.length }
      }
    } catch { /* 不是合法 wasm，继续找 */ }
  }
  return undefined
}

const wanted = process.argv[2]
const candidates = candidateWorkerDirs()
if (candidates.length === 0) {
  console.error(`未在 ${QODER_HOME} 找到 Qoder 的 worker 产物。`)
  console.error('可用环境变量 DSH_QODER_HOME 指定安装根目录。')
  process.exit(1)
}

const chosen = wanted === undefined
  ? candidates[0]
  : candidates.find((c) => c.label.endsWith(wanted) || c.version === wanted)

if (chosen === undefined) {
  console.error(`未找到版本 "${wanted}"。可用：`)
  for (const c of candidates) console.error(`  ${c.label}  (runtime ${c.version ?? '?'})`)
  process.exit(1)
}

const obfPath = join(chosen.dir, 'qoder-worker-runtime.obf.mjs')
if (!existsSync(obfPath)) {
  console.error(`缺少 ${obfPath}`)
  process.exit(1)
}

console.log(`来源: ${chosen.label}  (runtime ${chosen.version ?? '?'})`)
const extracted = extractWasm(obfPath)
if (extracted === undefined) {
  console.error('未在该 obf.mjs 中找到目标 WASM（Qoder 可能改了打包方式）。')
  process.exit(1)
}

const before = existsSync(OUT) ? statSync(OUT).size : 0
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, extracted.bytes)

console.log(`已写出 ${OUT}`)
console.log(`  ${before} → ${extracted.bytes.length} bytes（${extracted.exportCount} 个导出）`)
if (before === extracted.bytes.length) {
  console.log('⚠️ 大小未变 —— 可能本来就是同一版本，或该版本未改动 WASM。')
}
