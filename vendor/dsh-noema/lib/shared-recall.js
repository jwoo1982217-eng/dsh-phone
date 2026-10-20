import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const sourceIds = /* @__PURE__ */ new Set(["dsh", "codex", "claude-code", "opencode", "zcode", "cursor", "grok", "workbuddy", "antigravity", "trae", "qoder"]);
const canonical = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
function metadata(root, tenant, id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(tenant) || !/^mem_[a-zA-Z0-9-]{1,100}$/.test(id)) return void 0;
  try {
    root = fs.realpathSync(root);
    const users = path.join(root, "tenants", tenant, "users");
    if (fs.lstatSync(users).isSymbolicLink()) return void 0;
    for (const user of fs.readdirSync(users, { withFileTypes: true }).slice(0, 64)) {
      if (!user.isDirectory()) continue;
      for (const layer of ["cortex", "hippocampus"]) {
        const file = path.join(users, user.name, layer, id + ".md");
        try {
          const real = fs.realpathSync(file);
          if (!real.startsWith(root + path.sep) || fs.lstatSync(file).isSymbolicLink()) continue;
          const stat = fs.statSync(real);
          if (!stat.isFile() || stat.size > 262144) continue;
          const raw = fs.readFileSync(real, "utf8"), match = /^---json\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
          if (!match) continue;
          const value = JSON.parse(match[1]);
          if (value.schema_version === 1 && value.id === id && value.status === "active") return value;
        } catch {
        }
      }
    }
  } catch {
  }
  return void 0;
}
async function recallAcceptedMemory(manager, request, config) {
  if (!request.shared?.enabled || !Array.isArray(request.shared.sources) || !request.shared.sources.length || !["related", "project"].includes(request.mode)) return [];
  const selected = new Set(request.shared.sources.filter((id) => sourceIds.has(id)));
  if (!selected.size) return [];
  if (typeof request.query !== "string" || !request.query.trim() || request.query.length > 2e3) throw new Error("Invalid memory query");
  const result = await manager.call("noema_recall", { query: request.query, budget_tokens: 2500 }, { source: "automatic-recall", signal: request.signal });
  const parsed = JSON.parse(result.text);
  if (!Array.isArray(parsed?.memories)) throw new Error("Invalid shared memory response");
  const configured = config.noemaRoot.trim(), root = configured ? configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : configured : process.env.NOEMA_ROOT || path.join(os.homedir(), ".agent-memory");
  return parsed.memories.filter((m) => m && typeof m.id === "string" && typeof m.text === "string" && m.score > 0).flatMap((m) => {
    const meta = metadata(root, parsed.tenant_id || "personal", m.id);
    if (!meta) return [];
    const tags = Array.isArray(meta.tags) ? meta.tags : [], foreign = tags.filter((t) => typeof t === "string" && t.startsWith("source:")).map((t) => t.slice(7)).filter((s) => sourceIds.has(s));
    const sources = foreign.length ? foreign : tags.some((t) => t === "origin:interface" || t === "origin:agent") ? ["dsh"] : [];
    if (!sources.some((s) => selected.has(s))) return [];
    if (request.mode === "project" && (!request.cwd || !tags.some((t) => typeof t === "string" && t.startsWith("project:") && canonical(t.slice(8)) === canonical(request.cwd)))) return [];
    return [{ file: "Noema/" + m.id, lineStart: 1, memoryId: m.id, origin: "shared-agent-memory", agentSources: sources, text: m.text, lexical: 1, ...request.mode === "project" ? { cwd: request.cwd } : {} }];
  }).slice(0, 4);
}
export {
  recallAcceptedMemory
};
