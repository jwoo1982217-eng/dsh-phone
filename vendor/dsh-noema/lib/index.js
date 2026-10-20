import { humanMemoryService } from "./human-memory.js";
import { PLUGIN_NAME, NOEMA_TOOL_NAMES } from "./names.js";
import {
  Config,
  installNoemaMemorySettings,
  resolveNoemaMemorySettings
} from "./settings.js";
import { NoemaServerManager } from "./server-manager.js";
import { MemoryImportService } from "./import-service.js";
import { createNoemaTools } from "./tools.js";
import { noemaGuidanceText, NOEMA_GUIDANCE_SECTION } from "./guidance.js";
import { registerNoemaStatusRoute } from "./status-route.js";
import { recallAcceptedMemory } from "./shared-recall.js";
import { PLUGIN_NAME as PLUGIN_NAME2, NOEMA_TOOL_NAMES as NOEMA_TOOL_NAMES2, NOEMA_MEMORY_SETTINGS_NAMESPACE, NOEMA_STATUS_ROUTE } from "./names.js";
import { NOEMA_MEMORY_SETTINGS_NS, NOEMA_MEMORY_SETTINGS_SCHEMA, NOEMA_MEMORY_SETTINGS_DEFAULTS } from "./settings.js";
import { McpStdioClient, McpStdioError, MCP_PROTOCOL_VERSION } from "./mcp-stdio.js";
import { DSH_NOEMA_VERSION } from "./version.js";
import { NoemaServerManager as NoemaServerManager2, resolveNoemaLaunch, tokenizeCommand } from "./server-manager.js";
import { BUNDLED_NOEMA_COMMAND, NOEMA_PLATFORM_PACKAGES, bundledNoemaCandidates, noemaPlatformKey, noemaPlatformPackage, resolveBundledNoemaBinary, tryResolveBundledNoemaBinary } from "./bundled-binary.js";
import { createNoemaTools as createNoemaTools2 } from "./tools.js";
import { noemaGuidanceText as noemaGuidanceText2 } from "./guidance.js";
import { registerNoemaStatusRoute as registerNoemaStatusRoute2 } from "./status-route.js";
const name = PLUGIN_NAME;
const inject = ["tools"];
async function apply(ctx, config) {
  const hostCtx = ctx;
  const entry = config ?? {};
  let settingsSource = () => resolveNoemaMemorySettings(entry);
  let settingsWriter;
  installNoemaMemorySettings(ctx, entry, {
    setSource: (source) => {
      settingsSource = source;
    },
    setWriter: (writer) => {
      settingsWriter = writer;
    },
    onChange: () => {
    }
  });
  const manager = new NoemaServerManager(() => settingsSource(), ctx.logger);
  const importService = new MemoryImportService(manager, () => settingsSource(), ctx.logger);
  ctx.provide("dshNoemaRecall", { recall: (request) => recallAcceptedMemory(manager, request, settingsSource()) });
  ctx.provide("dshNoemaHumanMemory", humanMemoryService(manager));
  const disposers = [];
  for (const tool of createNoemaTools(manager, () => settingsSource(), importService)) {
    disposers.push(ctx.effect(
      () => hostCtx.tools.register(tool),
      "dsh-noema: " + tool.name + " tool"
    ));
  }
  ctx.inject(["systemPrompt"], (promptCtx) => {
    const systemPrompt = promptCtx.systemPrompt;
    systemPrompt.section({
      name: NOEMA_GUIDANCE_SECTION.name,
      order: NOEMA_GUIDANCE_SECTION.order,
      text: () => noemaGuidanceText(settingsSource())
    });
  });
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.webServer;
    return registerNoemaStatusRoute(
      webServer,
      manager,
      () => settingsSource(),
      () => settingsWriter,
      importService
    );
  });
  const initial = settingsSource();
  if (initial.enabled && initial.autoStart) {
    manager.ensureRunning().catch((error) => {
      ctx.logger.warn("dsh-noema: " + (error instanceof Error ? error.message : String(error)));
    });
  }
  manager.startKeepAlive();
  if (initial.enabled && initial.importEnabled && initial.importOnStartup) {
    importService.run({}).catch((error) => {
      ctx.logger.warn("dsh-noema startup import: " + (error instanceof Error ? error.message : String(error)));
    });
  }
  ctx.logger.info("dsh-noema mounted (" + NOEMA_TOOL_NAMES.length + " memory tools; settings: " + (initial.enabled ? "enabled" : "disabled") + ")");
  return async () => {
    for (const dispose of disposers.reverse()) await dispose();
    await manager.dispose();
  };
}
export {
  BUNDLED_NOEMA_COMMAND,
  Config,
  DSH_NOEMA_VERSION,
  MCP_PROTOCOL_VERSION,
  McpStdioClient,
  McpStdioError,
  NOEMA_MEMORY_SETTINGS_DEFAULTS,
  NOEMA_MEMORY_SETTINGS_NAMESPACE,
  NOEMA_MEMORY_SETTINGS_NS,
  NOEMA_MEMORY_SETTINGS_SCHEMA,
  NOEMA_PLATFORM_PACKAGES,
  NOEMA_STATUS_ROUTE,
  NOEMA_TOOL_NAMES2 as NOEMA_TOOL_NAMES,
  NoemaServerManager2 as NoemaServerManager,
  PLUGIN_NAME2 as PLUGIN_NAME,
  apply,
  bundledNoemaCandidates,
  createNoemaTools2 as createNoemaTools,
  inject,
  name,
  noemaGuidanceText2 as noemaGuidanceText,
  noemaPlatformKey,
  noemaPlatformPackage,
  registerNoemaStatusRoute2 as registerNoemaStatusRoute,
  resolveBundledNoemaBinary,
  resolveNoemaLaunch,
  tokenizeCommand,
  tryResolveBundledNoemaBinary
};
