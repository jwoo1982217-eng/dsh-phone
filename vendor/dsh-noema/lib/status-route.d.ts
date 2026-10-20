import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import type { NoemaServerManager } from './server-manager.js';
import type { MemoryImportService } from './import-service.js';
import type { NoemaMemorySettings } from './settings.js';
/** Trust the transport peer, including Node's IPv4-mapped IPv6 forms. */
export declare function isLoopbackRemoteAddress(address: string | undefined): boolean;
/** Register the status route; returns the route disposer. */
export declare function registerNoemaStatusRoute(webServer: WebServer, manager: NoemaServerManager, resolveConfig: () => NoemaMemorySettings, resolveConfigWriter?: () => ((patch: Partial<NoemaMemorySettings>) => Promise<void>) | undefined, importService?: MemoryImportService): () => void;
