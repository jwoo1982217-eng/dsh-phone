// Adapted from mortyandtimo/dsh-purge-plus 1.3.6 (MIT).
// Keep the community private-profile patch lifecycle and all existing patches.
// Unlike the original fork, respect the request's resolver/cancellation and
// never admit an IP literal. Probe results expire after 60 seconds.
export const helper = `// [dsh-purge] TUN fake-ip compatibility v1
const purgeFakeIpCache = new WeakMap();
function purgeFakeIpAddress(input) {
  try {
    let addr = ipaddr.parse(stripIpv6Brackets(String(input)));
    if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
    return ["198.18.0.0/15", "fdfe:dcba:9876::/48"].some(cidr => {
      const [network, prefix] = ipaddr.parseCIDR(cidr);
      return addr.kind() === network.kind() && addr.match(network, prefix);
    });
  } catch { return false; }
}
async function purgeFakeIpTunnelActive(signal, resolver) {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  const cached = purgeFakeIpCache.get(resolver);
  if (cached && Date.now() >= cached.at && Date.now() - cached.at < 60000) return cached.active;
  let active = false;
  for (const host of ["example.com", "www.cloudflare.com", "one.one.one.one"]) {
    try {
      const answers = await raceWithSignal(resolver(host, { all: true, order: "verbatim" }), signal);
      if (answers.some(entry => purgeFakeIpAddress(entry.address))) { active = true; break; }
    } catch (error) { if (signal?.aborted) throw signal.reason ?? error; }
  }
  purgeFakeIpCache.set(resolver, { at: Date.now(), active });
  return active;
}
`;

const anchor = 'const IPV4ONLY_SENTINELS = new Set(["192.0.0.170", "192.0.0.171"]);\n/**';
const refusal = '\t\tif (!isPublicIpAddress(entry.address)) throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, "WEB_BLOCKED_URL");';
const quote = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const tunFakeIpPatch = {
  id: 86,
  name: 'WEB_FETCH_FAKE_IP_TUNNEL',
  layer: '代码', layer_en: 'Code',
  desc: 'TUN fake-IP 域名兼容（保留私网、字面地址与 NAT64 检查） / TUN fake-IP compatibility',
  file: ['web-fetch-http'], optional: true,
  replacements: [
    { pattern: new RegExp(quote(anchor) + '([\\s\\S]*?)' + quote(refusal)),
      replace: anchor.slice(0, -3) + helper + '/**$1\t\tif (!isPublicIpAddress(entry.address) && !(literalFamily === 0 && purgeFakeIpAddress(entry.address) && await purgeFakeIpTunnelActive(signal, resolver))) throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, "WEB_BLOCKED_URL");' },
  ],
  markers: ['// [dsh-purge] TUN fake-ip compatibility v1', 'literalFamily === 0 && purgeFakeIpAddress(entry.address) && await purgeFakeIpTunnelActive(signal, resolver)'],
};
