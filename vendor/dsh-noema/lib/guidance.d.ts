/**
 * System-prompt guidance section: teaches the model when and how to use the
 * Noema memory tools. Rendered per assembly from the live settings source,
 * so disabling the plugin or the guidance toggle drops it immediately.
 * @module @zseven-w/dsh-noema/guidance
 */
import type { NoemaMemorySettings } from './settings.js';
/**
 * Render the guidance text for one assembly. Empty text contributes nothing
 * (the system-prompt assembler drops empty sections).
 */
export declare function noemaGuidanceText(config: NoemaMemorySettings): string;
/** Registration descriptor for the system-prompt service. */
export declare const NOEMA_GUIDANCE_SECTION: {
    name: string;
    order: number;
};
