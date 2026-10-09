/**
 * Qoder 设备身份（`Cosy-MachineToken` + `Cosy-MachineType`）回归用例。
 *
 * ## 两次真实缺陷（本文件的用例分别锁死）
 *
 * ### ① 缺 machine 头 ⇒ 服务端不下发可领活动（2026-09-25）
 *
 * 「没领过却显示今日已领取」：配额/活动请求**缺少成对的 machine 头**时，
 * 服务端只回 1 条 `VIEW_DETAILS`（`claimable:false`），没有
 * `CLAIM_BENEFIT/CLAIMABLE`。实证来源：`qoder积分.pcapng` +
 * `SSLKEYLOGFILE` 解密；逐项消融确认 **Token 与 Type 必须成对**（缺一即失效）。
 *
 * ### ② 读**陈旧磁盘缓存** ⇒ 第二个账号看不到可领活动（2026-09-26）
 *
 * 加入第二个 Qoder 账号后，一键领取对它报「当前没有可领取的活动」，
 * 而 IDE 里可领。根因：初版**读 `machine_token.json`**，而那是
 * `runtime-info.exe` 的陈旧缓存（实测停在 179 天前，且**跑 exe 也不更新**）。
 * native 的真实做法是**每次按需 spawn** `runtime-info.exe --account-stdin`。
 * 实测对照（第二个账号）：
 *   - 磁盘缓存（`f677427e14…`）→ `claimable:false`，仅 1 条 `VIEW_DETAILS`
 *   - 实时生成（`15e6683914…`）→ `claimable:true`，含 `CLAIM_BENEFIT/CLAIMABLE/100`
 *
 * ⚠️ 本文件**不得真的 spawn 开发机上的 `runtime-info.exe`**：那会让用例
 * 每次都花约 3.8 秒、且结果随「开发机是否装了 Qoder 桌面端」而变。
 * 故所有用例都把 `QODER_RUNTIME_INFO` 指向不存在或受控的路径。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findRuntimeInfoExecutable,
  resetQoderMachineIdentityCache,
  resolveQoderMachineIdentity,
  resolveQoderMachineIdentityAsync,
  withQoderMachineHeaders,
  withQoderMachineHeadersAsync,
  runtimeInfoArgs,
} from '../../src/qoder-machine.js'

/** 真实的 `machine_token.json` 形状（取自开发机，token 已截断）。 */
const REAL = { token: 'P1gAqPZCWUi74rLzCPRlKoCcii6MYvi3', type: 'f677427e14abd0f6c1', updateAt: 1774862945355 }

let dir: string
let file: string

beforeEach(() => {
  // 每次用独立临时目录，避免污染真实 %APPDATA% 且用例互不影响。
  dir = mkdtempSync(join(tmpdir(), 'qoder-mach-'))
  file = join(dir, 'machine_token.json')
  process.env.QODER_MACHINE_TOKEN_PATH = file
  // ⚠️ 关键：把可执行文件指到不存在的路径，强制走「磁盘缓存」退路，
  // 从而不真的 spawn（既快，又不受开发机是否装了桌面端影响）。
  process.env.QODER_RUNTIME_INFO = join(dir, 'no-such-runtime-info')
  resetQoderMachineIdentityCache()
})

afterEach(() => {
  delete process.env.QODER_MACHINE_TOKEN_PATH
  delete process.env.QODER_RUNTIME_INFO
  resetQoderMachineIdentityCache()
  rmSync(dir, { recursive: true, force: true })
})

describe('Qoder 设备身份解析', () => {
  it('无实时可执行文件时退回磁盘缓存（token + type）', () => {
    writeFileSync(file, JSON.stringify(REAL))
    expect(resolveQoderMachineIdentity()).toEqual({ token: REAL.token, type: REAL.type })
  })

  /**
   * ⚠️ **必须成对**：只有 token 或只有 type 时一律视为「拿不到」。
   *
   * 实测依据（同一账号、同一 token、只改请求头）：只加 Token 或只加 Type
   * 服务端都仍只回 1 条 `VIEW_DETAILS`；两者都加才回
   * `CLAIM_BENEFIT/CLAIMABLE/100`。故发一半毫无意义，宁可整体不发。
   */
  it('只有 token 或只有 type 时视为拿不到（不可发一半）', () => {
    writeFileSync(file, JSON.stringify({ token: REAL.token }))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()

    writeFileSync(file, JSON.stringify({ type: REAL.type }))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()

    // 空串同样视为缺失（不能让空头出现在请求里）
    writeFileSync(file, JSON.stringify({ token: '', type: REAL.type }))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
  })

  it('文件缺失 / JSON 损坏 / 形状非法 → undefined 且不抛错', () => {
    // 文件不存在
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()

    writeFileSync(file, 'not json')
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()

    writeFileSync(file, JSON.stringify(['array']))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()

    writeFileSync(file, JSON.stringify({ token: 123, type: 456 }))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
  })

  it('缓存生效：首次读取后删除文件仍可解析（避免每请求 IO）', () => {
    writeFileSync(file, JSON.stringify(REAL))
    expect(resolveQoderMachineIdentity()).toEqual({ token: REAL.token, type: REAL.type })
    rmSync(file, { force: true })
    // 未清缓存 → 仍返回上次结果
    expect(resolveQoderMachineIdentity()).toEqual({ token: REAL.token, type: REAL.type })
  })

  it('「拿不到」也被缓存（不反复读盘）', () => {
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    // 缓存后再写入文件也不影响本次进程的结果，直到显式重置
    writeFileSync(file, JSON.stringify(REAL))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()
    expect(resolveQoderMachineIdentity()).toEqual({ token: REAL.token, type: REAL.type })
  })

  it('异步版语义与同步版一致（同一个退路）', async () => {
    writeFileSync(file, JSON.stringify(REAL))
    await expect(resolveQoderMachineIdentityAsync()).resolves.toEqual({ token: REAL.token, type: REAL.type })
  })

  it('异步版拿不到时返回 undefined（不抛错）', async () => {
    await expect(resolveQoderMachineIdentityAsync()).resolves.toBeUndefined()
  })
})

describe('withQoderMachineHeaders', () => {
  it('拿得到身份时并入两个头（成对）', () => {
    writeFileSync(file, JSON.stringify(REAL))
    const headers = withQoderMachineHeaders({ Accept: 'application/json', 'Cosy-ClientType': '10' })
    expect(headers['Cosy-MachineToken']).toBe(REAL.token)
    expect(headers['Cosy-MachineType']).toBe(REAL.type)
    // 原头必须保留
    expect(headers['Cosy-ClientType']).toBe('10')
    expect(headers.Accept).toBe('application/json')
  })

  /**
   * ⚠️ **保守降级**：拿不到身份时**原样返回**，不写空串头。
   *
   * 理由：纯插件登录（未装 Qoder 桌面端）的用户本机没有 exe 也没有该文件，
   * 此时不能让积分功能整体失败；发空头反而可能被服务端按非法设备处理。
   */
  it('拿不到身份时原样返回（不写空头，保持修复前行为）', () => {
    const input = { Accept: 'application/json', 'Cosy-ClientType': '10' }
    const headers = withQoderMachineHeaders(input)
    expect(headers).toEqual(input)
    expect(headers).not.toHaveProperty('Cosy-MachineToken')
    expect(headers).not.toHaveProperty('Cosy-MachineType')
  })

  it('异步版同样并入两个头', async () => {
    writeFileSync(file, JSON.stringify(REAL))
    const headers = await withQoderMachineHeadersAsync({ 'Cosy-ClientType': '10' })
    expect(headers['Cosy-MachineToken']).toBe(REAL.token)
    expect(headers['Cosy-MachineType']).toBe(REAL.type)
  })

  it('异步版拿不到身份时原样返回', async () => {
    const input = { 'Cosy-ClientType': '10' }
    await expect(withQoderMachineHeadersAsync(input)).resolves.toEqual(input)
  })
})

/**
 * ⚠️ **`runtime-info.exe` 的参数形态回归（2026-09-26 真实缺陷）**。
 *
 * ## 为什么必须单独锁这个
 *
 * 本文件所有其它用例都把 `QODER_RUNTIME_INFO` 指到不存在的路径（见 `beforeEach`），
 * 以**禁用真实 spawn**（否则每条用例 3.8 秒、且结果随开发机是否装了桌面端而变）。
 * 代价是：**真实调用参数从未被执行到** —— 这正是「漏传 `environment`」这个
 * 缺陷能长期潜伏的原因。
 *
 * ## 缺陷本身
 *
 * 正确形态是 `runtime-info.exe <environment> --account-stdin`，其中
 * `environment` 是**第一个位置参数**（asar：`O3e` 传 `e === 'global' ? 3 : 0`）。
 * 漏掉它（只传 `--account-stdin`）会拿到**另一套身份**：
 *
 * | 调用 | machineType | 服务端下发的活动 |
 * |---|---|---|
 * | 只传 `--account-stdin`（漏 env） | `15e6683914666dab9f` | 仅 1 条 `VIEW_DETAILS` |
 * | **`3 --account-stdin`（IDE 实际）** | **`3582ddfb14d9bf289a`** | **`CLAIM_BENEFIT/CLAIMABLE/100`** |
 *
 * 后者与 IDE 实时抓包（`qoder-live.pcapng`）**逐字节一致**。
 *
 * 故这里直接断言参数数组 —— 它不依赖 spawn，快且稳定，又能精确锁住这个坑。
 */
describe('runtimeInfoArgs（参数形态回归）', () => {
  it('第一个参数是 environment，且 --account-stdin 在其后', () => {
    const args = [...runtimeInfoArgs()]
    expect(args).toHaveLength(2)
    // ⚠️ 顺序不可颠倒：environment 必须在最前（源码 `[String(environment), '--account-stdin']`）
    expect(args[0]).toBe('3')
    expect(args[1]).toBe('--account-stdin')
  })

  it('environment 取值为 3（对应源码 global 分支，与 IDE 抓包一致）', () => {
    // 值若改成 0/1/2 会拿到不同身份（实测 0 与漏参数同为 fallback 那套），
    // 故这里显式锁死 '3'。
    expect(runtimeInfoArgs()[0]).toBe('3')
  })

  it('绝不能退化成只传 --account-stdin（缺陷原形）', () => {
    const args = [...runtimeInfoArgs()]
    expect(args, '参数里缺少 --account-stdin').toContain('--account-stdin')
    // 关键：长度必须为 2；只有 1 个元素即为「漏 environment」
    expect(args.length, '漏了 environment 位置参数').toBeGreaterThan(1)
    expect(args[0], '第一参不能是 --account-stdin（那是漏 environment 的形态）')
      .not.toBe('--account-stdin')
  })
})

describe('runtime-info.exe 的多数据目录定位（设计文档 §9 缺陷修复）', () => {
  // 真实缺陷（复发风险）：`locateRuntimeInfo` 原先写死 `~/.qoder/.bin`。
  // 只装了中国版、没装国际版的用户没有 `~/.qoder`，于是找不到 exe →
  // 退到陈旧磁盘缓存 → 拿不到 machine 头 → `/sash/api/v1/me/campaigns`
  // 只回 VIEW_DETAILS → 插件误报「今天已领」。那正是 2026-09-25 修过的缺陷。
  //
  // ⚠️ 目录列表**不在** QoderProduct 上：实测两站同一 environment 返回同一身份
  // （两份 exe SHA256 相同），身份由「设备 + environment」决定、与产品无关。

  /** 造一个 `<home>/<dirName>/.bin/umid-<hash>/runtime-info(.exe)`。 */
  function fakeExe(home: string, dirName: string, hash: string): string {
    const exeDir = join(home, dirName, '.bin', `umid-win32-x64-${hash}`)
    mkdirSync(exeDir, { recursive: true })
    const exe = join(exeDir, process.platform === 'win32' ? 'runtime-info.exe' : 'runtime-info')
    writeFileSync(exe, '')
    return exe
  }

  it('只有中国版目录时也能找到（这是修复的核心场景）', () => {
    const home = mkdtempSync(join(tmpdir(), 'qoder-cn-only-'))
    try {
      const exe = fakeExe(home, '.qoder-cn', 'aaaa')
      expect(findRuntimeInfoExecutable(home)).toBe(exe)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('两个目录都有时按默认顺序取国际版（顺序即优先级）', () => {
    const home = mkdtempSync(join(tmpdir(), 'qoder-both-'))
    try {
      const intl = fakeExe(home, '.qoder', 'bbbb')
      fakeExe(home, '.qoder-cn', 'cccc')
      expect(findRuntimeInfoExecutable(home)).toBe(intl)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('可显式指定目录顺序（把中国版排前即取中国版）', () => {
    const home = mkdtempSync(join(tmpdir(), 'qoder-order-'))
    try {
      fakeExe(home, '.qoder', 'dddd')
      const cn = fakeExe(home, '.qoder-cn', 'eeee')
      expect(findRuntimeInfoExecutable(home, ['.qoder-cn', '.qoder'])).toBe(cn)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('两个目录都不存在时返回 undefined（正常降级，不抛错）', () => {
    const home = mkdtempSync(join(tmpdir(), 'qoder-none-'))
    try {
      expect(findRuntimeInfoExecutable(home)).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('目录存在但没有 umid-* 子目录时返回 undefined', () => {
    const home = mkdtempSync(join(tmpdir(), 'qoder-noumid-'))
    try {
      mkdirSync(join(home, '.qoder', '.bin'), { recursive: true })
      mkdirSync(join(home, '.qoder-cn', '.bin', 'something-else'), { recursive: true })
      expect(findRuntimeInfoExecutable(home)).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('命中第一个目录但 exe 文件缺失时继续试下一个目录', () => {
    // 场景：`.qoder/.bin/umid-x/` 存在但里面没有 exe（半安装/清理残留）。
    const home = mkdtempSync(join(tmpdir(), 'qoder-partial-'))
    try {
      mkdirSync(join(home, '.qoder', '.bin', 'umid-win32-x64-ffff'), { recursive: true })
      const cn = fakeExe(home, '.qoder-cn', 'gggg')
      expect(findRuntimeInfoExecutable(home)).toBe(cn)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
