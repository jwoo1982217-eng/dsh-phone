import type { JSX } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Client services required by this plugin. */
export declare const inject: string[];
interface PanelProps {
    ctx: ClientContext;
}
/** The settings section body. */
export declare function NoemaMemorySettingsPanel({ ctx }: PanelProps): JSX.Element;
/** Register the settings section slot. */
export declare function apply(ctx: ClientContext): void;
export {};
