import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveGatewayConfig, isLoopbackHost, isWildcardHost, stripHostBrackets, gatewayHttpUrl } from '../../src/openai-gateway/config.js'
import { loadOrCreateApiKey } from '../../src/openai-gateway/auth.js'

describe('OpenAI gateway config', () => {
  it('uses localhost and port 8326 by default', () => {
    expect(resolveGatewayConfig({})).toEqual({ host: '127.0.0.1', port: 8326 })
  })

  it('accepts a valid port override', () => {
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_PORT: '9382' }).port).toBe(9382)
  })

  it('rejects an invalid port override', () => {
    expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_PORT: '0' })).toThrow(/port/i)
  })

  /**
   * Issue IKL7UN：容器化部署下 host 硬编码 `127.0.0.1` 使端口映射**永不可达**
   * （容器内回环可达是假象，docker-proxy 走的是容器桥接 IP）。
   *
   * ⚠️ 默认值必须逐字节不变 —— 这是「不设置就与现在完全一致」的前提，
   * 否则本修复本身会变成一次行为变更。
   */
  it('★ 未设置 host 环境变量时默认仍是 127.0.0.1（行为零变化）', () => {
    expect(resolveGatewayConfig({}).host).toBe('127.0.0.1')
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_PORT: '9382' }).host).toBe('127.0.0.1')
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '' }).host).toBe('127.0.0.1')
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '   ' }).host).toBe('127.0.0.1')
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '127.0.0.1' }).host).toBe('127.0.0.1')
  })

  it('★ 接受具体的接口地址（容器桥接 IP / 其它回环地址），host 与 port 各自独立', () => {
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '172.21.0.8' }))
      .toEqual({ host: '172.21.0.8', port: 8326 })
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '127.0.0.2', DSH_OPENAI_GATEWAY_PORT: '9382' }))
      .toEqual({ host: '127.0.0.2', port: 9382 })
    // IPv6 具体地址：方括号是 URL 记法，**不是** listen() 的入参形态，必须剥掉。
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '::1' }).host).toBe('::1')
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '[::1]' }).host).toBe('::1')
    // 两端空白不应成为一个必然 EADDRNOTAVAIL 的 host。
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '  172.21.0.8  ' }).host).toBe('172.21.0.8')
  })

  /**
   * ⚠️ 通配地址必须**显式拒绝**，而不是静默监听全部网卡。
   *
   * 两层理由：
   * 1. README 的安全边界写着「只绑定 127.0.0.1，**不可**改成对外地址」；
   * 2. dsh 本体对 `--host 0.0.0.0` 也是硬拒绝（`dsh-web-app` 的 startup：
   *    `--host 0.0.0.0 is intentionally not supported yet for safety`）。
   *    两处姿态必须一致，否则用户会以为「Web 拒绝、网关允许」是有意的放宽。
   *
   * 判据用**URL 规范化**而不是比较字面量：`0` / `0x0` / `::0` / `0:0:0:0:0:0:0:0`
   * 在 Linux（issue 的容器场景）上都会落到同一张网卡上。
   */
  /**
   * ⚠️⚠️ **第二轮对抗审计实测出的新绕过**（2026-10-13）。
   *
   * 上一版判据枚举了不可见字符的码点，而 Unicode `Cf`（格式字符）有 160+ 个，
   * 枚举必然漏；漏掉后解析函数失败 ⇒ **放行**（fail-open 方向没变）。审计在
   * Windows 上端到端确证 7 条「判据放行 → 网关真的启动 → 从局域网 IP 拿到
   * HTTP 401」；系统扫描 134 个 `Cf`/`Zs`/`Cc` + 全角字符共 **25 条**可绕。
   *
   * ⇒ 判据必须按 **Unicode 类别**（`\p{Cf}` 等）+ **NFKC** 处理，不能枚举码点。
   */
  it('★★ 通配判据不得被 Unicode 不可见字符 / 全角数字绕过（第二轮审计实测）', () => {
    const bypasses = [
      // 全角数字（NFKC 折成半角后就是 0.0.0.0）
      '\uff10.\uff10.\uff10.\uff10',
      '\uff10',
      // Cf 类：软连字符 / 蒙古文元音分隔符 / CGJ / 函数应用 / 不可见运算符…
      '0.0.0.0\u00ad', '::\u00ad', '::\u180e', '::\u034f',
      '::\u2061', '::\u2062', '::\u2063', '::\u2064',
      '::\u206a', '::\u206b', '::\u206c', '::\u206d', '::\u206e', '::\u206f',
      '::\ufeff', '::\u200b', '\u200b::',
      // 空端口（原正则 `(?::\d+)?` 不匹配 ⇒ 整串原样放行）
      '[::]:', '[0:0:0:0:0:0:0:0]:', '0.0.0.0:',
      // 组合：不可见字符 + zone id / 端口
      '::%eth0\u00ad', '[\u200b::\u200b]:8326',
    ]
    for (const host of bypasses) {
      expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: host }), JSON.stringify(host)).toThrow(/DSH_OPENAI_GATEWAY_HOST/)
    }
  })

  /**
   * ⚠️⚠️ **第二轮审计实测的回归：zone id 不能被剥掉后再交给 `listen()`**。
   *
   * Linux 实测 `fe80::215:5dff:fe1c:fc88%eth0` **带 zone 能 bind**（scope id
   * 生效），剥成裸地址后反而 `EINVAL(22)`。故「判据串」与「listen 串」必须走
   * 两个函数：判据剥 zone（`::%eth0` 就是 `::` ⇒ 必须判通配），返回值保留 zone。
   */
  it('★★ zone id 必须保留在交给 listen 的地址里（否则绑不上 link-local）', () => {
    const linkLocal = 'fe80::215:5dff:fe1c:fc88%eth0'
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: linkLocal }).host).toBe(linkLocal)
    // 判据侧仍要认得出「剥掉 zone 之后是通配」——两个方向都不能少。
    expect(isWildcardHost('::%eth0')).toBe(true)
    expect(isLoopbackHost('::1%lo')).toBe(true)
    // ⚠️ 但回环/通配判定本身不得因为保留 zone 而失效。
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '::1%lo' }).host).toBe('::1%lo')
  })

  /**
   * ⚠️⚠️ **第三轮审计实测出的 fail-open 残余**（2026-10-13）。
   *
   * 前三版判据都是「**认不出来就放行**」，而攻击面**无界**：内核会把一批
   * **非 ASCII 的分隔符**当成 `.`。最典型的是 **`U+3002` 表意句号**（类别 `Po`，
   * NFKC **不**折它）—— 实测 `0。0。0。0`：
   *
   * - 判据：`parseIpv4` 解析失败 ⇒ 放行；
   * - 内核：**真的绑上全部网卡**（从局域网 IP 反连得到 `HTTP 200`）。
   *
   * ⇒ 修法是**方向反转**：只放行确定合法的字符（fail-closed），其余一律拒绝。
   * 逐个补分隔符是不可能的（`Po`/`Mc`/`Co`/`Cn`… 各类都有候选）。
   */
  it('★★ 非 ASCII 分隔符 / 兼容字符一律拒绝（fail-closed，第三轮审计实测）', () => {
    const illegal = [
      '0\u30020\u30020\u30020',       // U+3002 表意句号 —— **实测真的绑全部网卡**
      '\u3002', '\u3002\u3002',
      // ⚠️ 下面两条是**第三轮审计在 Linux 上逐个真 bind 实测**同样绑 `0.0.0.0` 的
      // 命中码点（连同 U+3002，HEAD 判据共放行了 3 条）：
      '0\uff610\uff610\uff610',       // U+FF61 半角表意句号
      '0\u18060\u18060\u18060',       // U+1806 蒙古文破折号（`Pd`）
      // 同一轮 Linux 扫描的完整命中集（12 个码点）——其余几个在此一并锁住：
      '0\u00ad0\u00ad0\u00ad0', '0\u200b0\u200b0\u200b0', '0\u200c0\u200c0\u200c0',
      '0\u200d0\u200d0\u200d0', '0\u20240\u20240\u20240', '0\u20600\u20600\u20600',
      '0\ufe520\ufe520\ufe520', '0\ufeff0\ufeff0\ufeff0', '0\uff0e0\uff0e0\uff0e0',
      '\uff10.\uff10.\uff10.\uff10',  // 全角数字
      '\uff10',
      '\u0660.\u0660.\u0660.\u0660',  // 阿拉伯-印度数字
      '\u06f0.\u06f0.\u06f0.\u06f0',  // 波斯数字
      '\u0966.\u0966.\u0966.\u0966',  // 天城文数字
      '\u2070',                        // 上标零 —— NFKC 折成 `0` ⇒ 按通配拒绝
      '::\u0903', '::\u093e',          // `Mc` 组合用间距标记
      '::\ue000', '::\uf8ff',          // `Co` 私用区
      '::\u0378',                      // `Cn` 未分配
      '::\u2028', '::\u2029',          // 行/段分隔
      'localhost\u3002com',
      '0\u30020\u30020\u30020.0',
    ]
    for (const host of illegal) {
      expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: host }), JSON.stringify(host)).toThrow(/DSH_OPENAI_GATEWAY_HOST/)
    }
    // ⚠️ 三类**刻意不列入**，因为它们实测**无害**（NFKC 折成合法 ASCII 或
    // 直接折成通配写法，且内核绑不上）：
    //   - `\uff1a`（全角冒号）→ 折成 `:`，内核 ENOTFOUND；
    //   - `\u2460` / `\u2160` / `\u00b2`（带圈 1 / 罗马 I / 上标 2）→ 折成
    //     `1` / `I` / `2`，内核 ENOTFOUND；
    //   - `127.0.0.1\u00a0`（NBSP）/ `\u3000`（表意空格）/ `\n` / `\t` → 被不可见
    //     字符剥离 ⇒ 剩下合法地址或空串（后者回落默认值，均无害）。
    // fail-closed 的目的是「挡住能绑全网卡的形态」，不是「挡住所有怪异字符串」。
  })

  /**
   * ⚠️⚠️ **URL 里必须剥 zone id**（第三轮审计实测的回归）。
   *
   * `listen()` 侧要**保留** zone（`fe80::1%eth0` 才绑得上 link-local，见下一条），
   * 但 URL 语法里没有 zone 的位置 —— 实测 `new URL('http://[fe80::1%eth0]:8326/v1')`
   * 抛 `ERR_INVALID_URL`。⇒ 面板与日志会给出抄走连不上的地址（第一轮修过的同型缺陷）。
   */
  it('★★ gatewayHttpUrl 必须产出**合法** URL（含 zone id 的地址要剥掉 zone）', () => {
    // 正例：含 zone 的 IPv6 —— 剥掉 zone 后必须是合法 URL。
    for (const host of ['fe80::1%eth0', 'fe80::215:5dff:fe1c:fc88%eth0', '::1%lo']) {
      const url = gatewayHttpUrl(host, 8326, '/v1')
      expect(url, host).not.toContain('%')
      expect(() => new URL(url), `${host} -> ${url}`).not.toThrow()
    }
    expect(gatewayHttpUrl('fe80::1%eth0', 8326, '/v1')).toBe('http://[fe80::1]:8326/v1')
    expect(gatewayHttpUrl('::1%lo', 8326, '/v1')).toBe('http://[::1]:8326/v1')
    // 普通形态不受影响。
    expect(gatewayHttpUrl('::1', 8326, '/v1')).toBe('http://[::1]:8326/v1')
    expect(gatewayHttpUrl('127.0.0.1', 8326, '/v1')).toBe('http://127.0.0.1:8326/v1')
    expect(gatewayHttpUrl('172.21.0.8', 8326, '/v1')).toBe('http://172.21.0.8:8326/v1')
    expect(gatewayHttpUrl('localhost', 8326, '/v1')).toBe('http://localhost:8326/v1')
    // ⚠️ 反向：**listen 串仍必须保留 zone**（两条修法各管一个方向，别互相吃掉）。
    expect(stripHostBrackets('fe80::1%eth0')).toBe('fe80::1%eth0')
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: 'fe80::1%eth0' }).host).toBe('fe80::1%eth0')
  })

  /**
   * ⚠️ 反向：fail-closed **不得误伤**合法字符集。
   * 合法集合 = ASCII 字母数字 + `.` `:` `%` `_` `-`（覆盖 IPv4/IPv6/主机名/zone id）。
   */
  it('★★ fail-closed 不得误伤合法主机字符（含 zone id 与下划线主机名）', () => {
    for (const host of [
      '127.0.0.1', '127.0.0.2', '127.1', '172.21.0.8', '192.168.3.125',
      '::1', '[::1]', '::1%lo', 'fe80::1', 'fe80::1%eth0', 'fe80::215:5dff:fe1c:fc88%eth0',
      '::ffff:127.0.0.1', '2001:db8::1',
      'localhost', 'host.docker.internal', 'dsh.internal', 'my_host', 'my-host',
      'a.b.c.d.e', 'xn--fsq.com',
    ]) {
      expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: host }), host).not.toThrow()
    }
  })

  it('★ 拒绝通配地址：写出各种等价写法都不许静默监听全部网卡', () => {
    const wildcards = [
      '0.0.0.0',
      '::',
      '0:0:0:0:0:0:0:0',
      '0000:0000:0000:0000:0000:0000:0000:0000',
      '0::',
      '::0',
      '::ffff:0.0.0.0',
      '::ffff:0:0',
      '[::]',
      '[0:0:0:0:0:0:0:0]',
      '0',
      '0x0',
      '0.0',
      '0.0.0',
      '00.0.0.0',
      '0.0.0.0.',
      // ⚠️ 下面这几条是**我自查时补的**：在 Linux（issue 的容器场景）上，
      // `socket.getaddrinfo` 实测把它们全部解析成 `0.0.0.0`
      // （`0x0.0x0.0x0.0x0` / `0x00000000` 走十六进制、`00` 走八进制）。
      '00',
      '000',
      '0x0.0x0.0x0.0x0',
      '0x00000000',
      '0X0',
    ]
    for (const host of wildcards) {
      expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: host }), host).toThrow(/DSH_OPENAI_GATEWAY_HOST/)
    }
  })

  /**
   * ⚠️ 反向边界：**内核解析不了的紧凑写法必须放行**（不能一律当通配拒掉）。
   *
   * 实测（Windows `dns.lookup` 与 Linux `getaddrinfo` 双平台一致）：
   * `0x.0` / `0e0` / `0.0.0.0e0` / `-0` / `0x` 在两边都**解析失败**
   * （`ENOTFOUND` / `gaierror`）⇒ 它们绑不上任何东西，交给内核报错即可。
   * 把它们判成通配会把「名为 `0x` 的容器」这类真实主机名误挡。
   *
   * ⚠️⚠️ **本用例是弱判据（第四轮审计实测点名）**：它把「**我们的**解析器解析不出来」
   * 当成了对外契约（`toBe(host)`），而不是锚定「内核真的绑不上」。实测把
   * `parseIpv4` 退化成「只认点分四段」（**严格性回退**，会让 `0` / `0x0` / `00` /
   * `0.0.0.0.` 变成放行 —— 危险方向）时，**本用例仍然全绿**。
   * ⇒ 真正守住那次退化的是另外几条（「拒绝通配地址：写出各种等价写法」等）。
   * **别把本用例当成通配判据的防线**；它的职责只是「防误伤真实主机名」。
   *
   * ⚠️ `+0` **不在此列**：`+` 不是合法主机字符，被 fail-closed 闸门拒掉
   * （那是**有意的**——`+` 在 `inet_aton` 里是「接受」的正号写法，属危险方向）。
   */
  it('★ 内核解析不了的写法不得被判成通配（否则误伤真实主机名；⚠️ 弱判据，不防严格性回退）', () => {
    for (const host of ['0x.0', '0e0', '0.0.0.0e0', '-0', '0x']) {
      expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: host }).host, host).toBe(host)
    }
    // 危险方向：带 `+` 的写法一律拒绝（`+` 不在合法字符集内）。
    expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '+0' })).toThrow(/DSH_OPENAI_GATEWAY_HOST/)
  })

  /**
   * ⚠️⚠️ **本条来自两轮独立审计的实测证伪**（2026-10-13）。
   *
   * 初版判据是「URL 规范化后比较 3 个字面量」，注释还写了「实测无假阴性」。
   * 审计用**真绑 socket + 反连局域网地址**证明那是错的：下面这批写法在
   * Windows 与 Linux（WSL Ubuntu-22.04）上**都会真的绑上全部网卡**，却因为
   * WHATWG URL 抛错而落进 `catch { return false }`（fail-open）被放行：
   *
   * | 写法 | 为什么 URL 会抛 | 内核为什么照样绑全网卡 |
   * |---|---|---|
   * | `::%0` / `::%eth0` / `::%nonexistent0` | host 含 `%` ⇒ `ERR_INVALID_URL` | `bind()` **先剥 zone id** 再解析，`%` 后接什么都不影响 ⇒ 等价 `::` |
   * | `::\u200b` / `\u200b::` | 含零宽空格 ⇒ `ERR_INVALID_URL` | glibc 忽略不可见字符 ⇒ 等价 `::` |
   * | `[::]:8326` / `[0:0:0:0:0:0:0:0]:8326` | 含端口 ⇒ 解析成畸形 host | docker 文档的 `host:port` 记法，剥端口后就是 `::` |
   * | `::ffff:000.000.000.000` | IPv4-mapped 带前导零 | 等价 `::ffff:0.0.0.0` ⇒ 全部 IPv4 网卡 |
   *
   * ⇒ 修法是**换判据**：含 `:` 的一律当 IPv6 字面量**显式展开**判断（不再依赖
   * WHATWG URL 的宽容度），并先把 zone id 与不可见字符剔除。
   */
  it('★★ 通配判据不得被 zone id / 不可见字符 / 端口记法绕过（审计实测的 14 条）', () => {
    const bypasses = [
      // zone id 族：`bind()` 先剥 `%…` 再解析（实测 %nonexistent 也照绑）
      '::%0', '::%1', '::%eth0', '::%lo', '::%nonexistent0',
      '0::%eth0', '::0%eth0', '0:0:0:0:0:0:0:0%eth0',
      '::ffff:0:0%1', '::ffff:0:0%0',
      // 不可见字符族：glibc 忽略它们
      '::\u200b', '\u200b::', '::ffff:0:0\u200b',
      // 端口记法族：docker 文档常见写法
      '[::]:8326', '[0:0:0:0:0:0:0:0]:8326', '0.0.0.0:8326', '[::ffff:0:0]:8326',
      // IPv4-mapped 前导零族
      '::ffff:000.000.000.000', '::ffff:00.00.00.00', '::ffff:0.00.0.0',
    ]
    for (const host of bypasses) {
      expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: host }), JSON.stringify(host)).toThrow(/DSH_OPENAI_GATEWAY_HOST/)
    }
  })

  /**
   * ⚠️ 反向要求：上面的加强**不得误伤具体地址**，否则本 issue 的正解
   * （绑容器自身 IP）会被自己的判据挡在门外。
   */
  it('★★ 加强后的判据仍不得误伤具体地址（含 IPv6 与带端口的具体地址）', () => {
    // ⚠️ 必须断言**具体值**（`toEqual`），不能用 `toBeTruthy()`：第二轮审计实测
    // `toBeTruthy()` 版本在「host 被改坏成 `host + '.evil'`」的变异下**不变红**
    // —— 它是弱判据。断言具体值才能锁住「归一化不得改动合法地址」。
    for (const [host, expected] of [
      ['127.0.0.1', '127.0.0.1'], ['127.0.0.2', '127.0.0.2'], ['127.1', '127.1'],
      ['172.21.0.8', '172.21.0.8'], ['192.168.3.125', '192.168.3.125'],
      ['::1', '::1'], ['[::1]', '::1'], ['::1%lo', '::1%lo'],
      ['fe80::1', 'fe80::1'], ['fe80::1%eth0', 'fe80::1%eth0'],
      ['::ffff:127.0.0.1', '::ffff:127.0.0.1'],
      ['localhost', 'localhost'], ['host.docker.internal', 'host.docker.internal'], ['dsh.internal', 'dsh.internal'],
      ['127.0.0.1:8326', '127.0.0.1'], ['[::1]:8326', '::1'],
    ] as const) {
      // 只要求「不被通配判据拒绝」且「归一化结果等于预期」。
      expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: host }).host, host).toBe(expected)
    }
  })

  /**
   * ⚠️ 回环判据必须与宿主侧**同源**（审计指出的两套判据漂移）。
   *
   * 客户端原先是字面量正则 + `=== '[::1]'`，于是 `127.1` / `0:0:0:0:0:0:0:1` /
   * `::ffff:127.0.0.1` / `localhost` 这些**内核实测只在回环可达**的写法被判成
   * 「已对外暴露」—— 面板会输出它自己声称要消除的那种错误陈述。
   */
  it('★★ isLoopbackHost：能绑成回环的各种写法都要判回环（内核实测口径）', () => {
    for (const host of [
      '127.0.0.1', '127.0.0.2', '127.1', '127.0.0.1.', '2130706433',
      '::1', '[::1]', '::1%lo', '0:0:0:0:0:0:0:1', '::0001', '::0:1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', 'localhost',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
    for (const host of [
      '172.21.0.8', '192.168.3.125', '10.0.0.1', '0.0.0.0', '::', '::ffff:0:0',
      'fe80::1', '::ffff:172.21.0.8', 'host.docker.internal',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })

  it('★ 地址归一化：不可见字符 / 方括号 / 端口都要被剥掉', () => {
    expect(stripHostBrackets('[::1]')).toBe('::1')
    expect(stripHostBrackets('[[::1]]')).toBe('::1')
    expect(stripHostBrackets('[::1]:8326')).toBe('::1')
    expect(stripHostBrackets('[::]:')).toBe('::')
    expect(stripHostBrackets('::\u200b')).toBe('::')
    expect(stripHostBrackets('::\u00ad')).toBe('::')
    expect(stripHostBrackets('::\u034f')).toBe('::')
    expect(stripHostBrackets('\uff10.\uff10.\uff10.\uff10')).toBe('0.0.0.0')
    expect(stripHostBrackets(' 127.0.0.1 ')).toBe('127.0.0.1')
    expect(stripHostBrackets('127.0.0.1:8326')).toBe('127.0.0.1')
    // ⚠️ zone id **刻意保留**（判据侧才剥）：见「zone id 必须保留」那条用例。
    expect(stripHostBrackets('::%eth0')).toBe('::%eth0')
    expect(stripHostBrackets('fe80::1%eth0')).toBe('fe80::1%eth0')
  })

  it('★ 报错必须给出可操作的替代做法（否则用户只会去搜「怎么关掉这个校验」）', () => {
    let message = ''
    try {
      resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: '0.0.0.0' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // ① 必须点名 env 本身，用户才知道要改哪个变量；
    expect(message).toContain('DSH_OPENAI_GATEWAY_HOST')
    // ② 必须给出做法（绑具体接口地址），而不是只说「不允许」；
    expect(message).toMatch(/具体|接口地址|hostname/)
    // ③ 容器场景正是本 issue 的来由，提示里必须能让人联想到它。
    expect(message).toMatch(/容器|桥接|eth0/i)
  })

  /**
   * ⚠️ 通配判据**不得误伤**具体地址 —— 假阴性会让「绑容器 IP」这个正解被拒。
   * 这批是本 issue 报告者真实要用的形态，逐条锁住。
   */
  it('★ 通配判据不得误伤具体地址', () => {
    // ⚠️ 同上一节：断言具体值而不是 `toBeTruthy()`（后者是弱判据，第二轮审计实测）。
    for (const [host, expected] of [
      ['127.0.0.1', '127.0.0.1'], ['127.0.0.2', '127.0.0.2'], ['172.21.0.8', '172.21.0.8'],
      ['::1', '::1'], ['fe80::1', 'fe80::1'],
      ['localhost', 'localhost'], ['host.docker.internal', 'host.docker.internal'],
    ] as const) {
      expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_HOST: host }).host, host).toBe(expected)
    }
  })

  it('prefers the environment API key', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gateway-auth-'))
    // 返回结构而非裸字符串：设置页要据此显示「来自环境变量」并隐藏文件路径。
    const source = loadOrCreateApiKey(home, { DSH_OPENAI_GATEWAY_API_KEY: 'env-secret' })
    expect(source.value).toBe('env-secret')
    expect(source.fromEnv).toBe(true)
    expect(source.path).toBeNull()
  })

  it('generates and persists a key when the environment is empty', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gateway-auth-'))
    const first = loadOrCreateApiKey(home, {}).value
    const second = loadOrCreateApiKey(home, {}).value
    expect(first).toHaveLength(43)
    expect(second).toBe(first)
    expect(readFileSync(join(home, 'openai-gateway', 'api-key'), 'utf8')).toBe(first)
  })
})
