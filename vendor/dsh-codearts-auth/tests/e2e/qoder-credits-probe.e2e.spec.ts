/**
 * Qoder 积分 e2e 探针：**只读**，绝不领取。
 *
 * ⚠️ 本文件**不调用** `/sash/api/v1/me/campaigns/{id}/claim` —— 那是写操作。
 * 它只做两件事：
 * 1. 逐账号查询签到状态（`fetchQoderCheckinStatus`，纯 GET）→
 *    打印可领积分与已领标记；
 * 2. 校验**设备身份（`Cosy-MachineToken` + `Cosy-MachineType`）确实生效** ——
 *    即服务端认可我们发出的身份并下发领分类活动。
 *
 * 因此它**不消耗任何积分、也不改动领取状态**，可安全重复运行。
 * 领取入口是 Jet Hub 的「一键领取积分 / 一键签到」，无独立写探针
 * （领取会改动当日状态，日常验证用只读探针即可）。
 *
 * ## 为什么这个探针必须存在（单测覆盖不到的部分）
 *
 * `tests/unit/qoder-machine.spec.ts` 只能断言「请求头里有没有 Token/Type」，
 * **断言不了服务端是否因此下发可领活动** —— 那必须打真实端点。
 * 而且单测配置（`vitest.config.ts`）刻意把 `QODER_RUNTIME_INFO` 指到不存在的
 * 路径以**禁用 spawn**（否则每条用例真跑约 3.8 秒、且结果随开发机是否装了
 * 桌面端而变），所以「实时生成身份」这条**主路径在单测里根本不执行**。
 * 本文件跑在 `vitest.e2e.config.ts` 下（不设该变量），因此走真实生成路径。
 *
 * ## 覆盖的两个真实缺陷
 *
 * - **① 缺 machine 头**（2026-09-25）：服务端只回 1 条 `VIEW_DETAILS`
 *   （`claimable:false`），插件误判「今天已领」。
 * - **② 读陈旧磁盘缓存**（2026-09-26，用户报障）：加入**第二个**账号后，
 *   一键领取对它报「当前没有可领取的活动」，而 IDE 里可领。根因是初版读
 *   `machine_token.json`，而那是 `runtime-info.exe` 的陈旧缓存（实测停在
 *   179 天前、且跑 exe 也不更新设备身份）。
 *   ⚠️ **该缺陷只在多账号 + 真实 exe 下暴露**，故下面的**逐账号**断言是它
 *   唯一的自动化回归 —— 别把它改成只测第一个账号。
 *
 * 闸门：`DSH_QODER_E2E=1`。未设置时整体 skip，不产生任何网络调用。
 * 前置：先在 Jet Hub 的 Qoder 面板登录至少一个账号（覆盖②需两个）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QODER } from '../../src/qoder-product.js'
import { fetchQoderCheckinStatus } from '../../src/qoder-credits.js'
import { resetQoderMachineIdentityCache, resolveQoderMachineIdentity } from '../../src/qoder-machine.js'
import { readQoderCredentialsFromDshStore } from './qoder-credential.js'

const enabled = process.env.DSH_QODER_E2E === '1'
const describeGate = enabled ? describe : describe.skip

/**
 * 本机是否有 `runtime-info.exe`（Qoder 桌面端的 UMID 模块）。
 *
 * 没有它时设备身份只能退回读磁盘缓存 —— 那是**纯插件登录用户的预期降级**，
 * 此时缺陷①②不会显现。相关用例需**显式跳过并说明**，而不是假通过。
 */
function runtimeInfoAvailable(): boolean {
  const binDir = join(homedir(), '.qoder', '.bin')
  try {
    const dir = readdirSync(binDir).find((n) => n.startsWith('umid-'))
    if (dir === undefined) return false
    const exe = join(binDir, dir, process.platform === 'win32' ? 'runtime-info.exe' : 'runtime-info')
    return existsSync(exe)
  } catch {
    return false
  }
}

const hasRuntimeInfo = runtimeInfoAvailable()

describeGate('Qoder 积分探针（只读，不领取）', () => {
  const credentials = readQoderCredentialsFromDshStore()

  it('至少有一个已登录的 Qoder 账号', () => {
    // 前置条件缺失时给出可操作的提示，而不是一个费解的断言失败。
    expect(
      credentials.length,
      '未找到 Qoder 凭据。请先在 Jet Hub 的 Qoder 面板登录一个账号，'
      + '或确认 DSH profile 的 .credentials.yaml 路径正确。',
    ).toBeGreaterThan(0)
  })

  /**
   * 前置：本机必须能实时生成设备身份，否则下面两条核心断言**覆盖不到缺陷**。
   *
   * 不 fail —— 未安装 Qoder 桌面端是合法场景。但必须显式说出来，
   * 避免「跑了 e2e 就以为覆盖了」的假安全感。
   */
  it('前置：本机能实时生成设备身份（否则核心断言覆盖不到缺陷）', () => {
    if (!hasRuntimeInfo) {
      console.log('  ⚠️ 本机无 runtime-info.exe（未装 Qoder 桌面端）：')
      console.log('     → 主路径不可用，身份退化为读磁盘缓存（预期降级）')
      console.log('     → 缺陷①②在本机无法被覆盖，需在装了桌面端的机器上跑')
      return
    }
    resetQoderMachineIdentityCache()
    const identity = resolveQoderMachineIdentity()
    expect(identity, '实时生成设备身份失败（exe 存在但未产出身份）').toBeDefined()
    // 只打印长度与 type，不打印 token 本体
    console.log(`  ✓ 实时身份已生成：token 长度 ${identity!.token.length}，type ${identity!.type}`)
  })

  /**
   * ⚠️ **核心断言（缺陷①②的行为契约）**：**逐账号**用真实产品函数
   * （`fetchQoderCheckinStatus`）查签到状态。
   *
   * 每个账号必须落入以下**三种合法状态之一**（否则判为缺陷）：
   *
   * | 状态 | 判据 | 含义 |
   * |---|---|---|
   * | 已开通·可领 | `dailyCredit > 0` | 服务端认可设备身份并下发了可领活动 |
   * | 已开通·已领 | `todayCheckedIn` | 同上，今天已领过 |
   * | **未开通** | `actionRequired === true` | **账号本身在 Qoder 侧没有每日领取**，需用户先去官方客户端登录一次 |
   *
   * ⚠️ **第三种是合法状态，不能当失败**（2026-09-26 用户实测确认）：
   * 用本插件经 GitHub 授权**新注册**的账号在 Qoder 侧确实没有该活动
   * （只有一条 `VIEW_DETAILS`），这**不是**设备身份问题 ——
   * 实测 4 个不同 uid 经 `runtime-info.exe` 产出**完全相同**的身份。
   *
   * 而「拿不到活动却**没有** `actionRequired` 标记」才是缺陷②
   * （首个账号正常、后续账号拿不到，即身份未被服务端认可）。
   *
   * 故必须**逐账号**断言；只测第一个账号会让缺陷②漏网。
   */
  it('每个账号都处于合法状态：可领 / 已领 / 明确未开通（多账号回归，缺陷①②）', async () => {
    const problems: string[] = []
    let notActivated = 0
    for (const entry of credentials) {
      // 清缓存：强制每个账号都重新解析一次身份
      // （身份实测是设备级、清不清结果相同，但清掉能顺带验证解析对每个账号都成功）
      resetQoderMachineIdentityCache()
      const status = await fetchQoderCheckinStatus(entry.credential, QODER)
      if (status === null) {
        problems.push(`${entry.uid}: 状态查询失败（null）`)
        console.log(`  ✗ ${entry.uid}: 查询失败`)
        continue
      }
      const hasBenefit = status.dailyCredit > 0 || status.todayCheckedIn
      // 未开通是**合法状态**，但必须被显式标记出来 —— 否则就是缺陷②
      const declaredNotActivated = status.actionRequired === true
      const ok = hasBenefit || declaredNotActivated
      if (declaredNotActivated) notActivated += 1

      console.log(
        `  ${ok ? '✓' : '✗'} ${entry.uid}:`
        + ` dailyCredit=${status.dailyCredit}`
        + ` todayCheckedIn=${status.todayCheckedIn}`
        + ` actionRequired=${declaredNotActivated}`
        + ` activity=${status.activityName || '(无)'}`,
      )
      if (!ok) {
        problems.push(
          `${entry.uid}: 拿不到领分类活动，且**未**标记 actionRequired`
          + '（dailyCredit=0、未标已领、也未声明未开通）',
        )
      }
    }
    expect(
      problems,
      '以下账号既拿不到领分类活动、又没被标记为「未开通」——\n'
      + '这正是缺陷②的形态（设备身份未被服务端认可），而非账号本身的限制：\n'
      + problems.map((p) => `  · ${p}`).join('\n'),
    ).toEqual([])

    // 显式记录分布，便于人工核对（未开通是合法状态，不是错误）
    console.log(
      `  分布：${credentials.length - notActivated} 个已开通，`
      + `${notActivated} 个明确未开通（需用户先用官方客户端登录）`,
    )
  })

  /**
   * ⚠️ **`actionRequired` 必须真的能在真实响应里被触发**（若一个都没有，
   * 说明该字段的判据可能失效，用例会静默变成「永远验证不到」）。
   *
   * 不 fail —— 全部账号都已开通是合法状态。仅提示，避免「跑了 e2e 以为覆盖了」。
   */
  it('提示：本机是否有「未开通」账号（决定 actionRequired 判据是否被真实触发）', () => {
    console.log('  （见上一条用例的「分布」行；若全部已开通，则该分支未被真实触发）')
    expect(credentials.length).toBeGreaterThan(0)
  })

  /**
   * 显式提示多账号覆盖率：单账号时缺陷②**不可能**被上面那条用例发现。
   *
   * 不 fail（单账号是合法状态），但必须说出来，否则容易误以为已覆盖。
   */
  it('提示：账号数 > 1 才能覆盖多账号缺陷②', () => {
    if (credentials.length === 1) {
      console.log('  ⚠️ 仅 1 个 Qoder 账号：多账号缺陷②未被覆盖，建议再登录一个后重跑')
    } else {
      console.log(`  ✓ 共 ${credentials.length} 个账号，多账号场景已覆盖`)
    }
    expect(credentials.length).toBeGreaterThan(0)
  })
})
