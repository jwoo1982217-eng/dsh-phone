import * as core from "./core.js";
import fs from "node:fs";
import { selectPatches } from "./hooks-deny.js";
import { currentPrivateOverlay, applyPrivateOverlay, restorePrivateOverlay } from "./community-overlay.js";
import { validateCommunityProfilePaths, assertCommunityLiveProfile, canonicalCommunityProfile } from "./community-profile-paths.js";

function profileOf(ctx) {
  const profile = canonicalCommunityProfile(ctx?.get?.("profileContext"));
  if (!profile) throw new Error("Community adaptation requires a profile launched by DSH 0.2.1-alpha.1");
  return profile;
}
export function initializeCommunityProfile(ctx) {
  const profile = profileOf(ctx);
  if (!process.env.DSH_HOME) process.env.DSH_HOME = profile.home;
  const current = currentPrivateOverlay(ctx);
  return core.configureCommunityProfileScope(profile, current ? { aiBase: current.aiBase } : {});
}
export async function applyCurrentProfile(ctx) {
  const profile = profileOf(ctx);
  assertCommunityLiveProfile(validateCommunityProfilePaths(profile, { requireLauncherFiles: true, requireHomeEnvironment: true }));
  const result = await applyPrivateOverlay(ctx, {
    patch: async aiBase => {
      core.configureCommunityProfileScope(profile, { aiBase });
      const files = [...new Set(Object.values(core.targetFiles(aiBase)).flat().filter(Boolean))];
      const snapshots = files.map(file => {
        core.assertCommunityManagedPath(file);
        const backup = file + ".dshpurge.bak";
        core.assertCommunityManagedPath(backup);
        return { file, bytes: fs.readFileSync(file), backup, backupBytes: fs.existsSync(backup) ? fs.readFileSync(backup) : null };
      });
      try {
      const backup = await core.backupAll(aiBase);
      if (backup.errors.length) throw new Error("当前 profile 的原件备份失败，已取消写入。");
      const selected = selectPatches(core.ALL_PATCHES, { hooksDenyBypass: false });
      const report = await core.applyPatches(aiBase, selected, { preserveClientBundles: false });
      const summary = core.summarizeApplyReport(report, selected);
      if (summary.failed.length) {
        const error = new Error("宿主补丁存在失败项，已停止挂载；共享安装与原 profile 配置未改写。失败补丁：" + summary.failed.map(row => row.patch_id || row.id).join(", "));
        error.failed_items = summary.failed;
        throw error;
      }
      const unmatched = report.filter(row => !["applied", "already"].includes(row.status));
      return { ok: true, complete: true, applied: summary.applied, already: summary.already, failed: 0, failed_items: [], unmatched_items: unmatched, unmatched: unmatched.length, report };
      } catch (error) {
        for (const snapshot of snapshots) {
          await core.atomicWriteFile(snapshot.file, snapshot.bytes);
          if (snapshot.backupBytes !== null) await core.atomicWriteFile(snapshot.backup, snapshot.backupBytes);
          else { core.assertCommunityManagedPath(snapshot.backup); await fs.promises.unlink(snapshot.backup).catch(failure => { if (failure.code !== "ENOENT") throw failure; }); }
        }
        throw error;
      }
    },
  });
  return { ...result.report, currentProfileOnly: true, nativeScope: result.aiBase, privateRows: result.privateRows, mountedPackages: result.mountedPackages, restarting: false, restart_after_apply: false, requiresManualRestart: true, note: "已在当前 profile 的私有宿主副本应用。请完全退出当前 DSH 客户端后重新打开；此进程不会自动重启，也不会改写共享安装。未匹配的可选补丁见结果，不能据此推定全部作者功能有效。", communityAdaptation: true };
}
export async function revertCurrentProfile(ctx) {
  const profile = profileOf(ctx);
  assertCommunityLiveProfile(validateCommunityProfilePaths(profile, { requireLauncherFiles: true, requireHomeEnvironment: true }));
  const result = await restorePrivateOverlay(ctx, {
    revert: async aiBase => {
      core.configureCommunityProfileScope(profile, { aiBase });
      const report = await core.revertAll(aiBase);
      if (report.errors.length) throw new Error("当前 profile 私有副本还原失败；保留配置和备份。");
      return report;
    },
  });
  return { ok: true, ...result.report, currentProfileOnly: true, requiresManualRestart: result.restartRequired, restarting: false, note: result.restored ? "已还原当前 profile 的私有宿主配置。请完全退出当前 DSH 客户端后重新打开；用户自己追加的配置与数据保留。" : "当前 profile 没有已应用的社区宿主副本。", communityAdaptation: true };
}
