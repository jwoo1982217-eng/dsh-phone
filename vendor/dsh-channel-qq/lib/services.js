/** Minimal structural views of the harness services this channel consumes.
 *
 * The real declarations come from the harness packages via Cordis declaration
 * merging at runtime; here they are deliberately narrow so the plugin builds
 * against `@deepseek-ai/cordis` alone and cannot grow hidden dependencies on
 * host internals. Shapes mirror the call sites in `packages/webhook/webhook/src/session.ts`.
 */
export function asSessionId(value) {
    return value;
}
export function pluginUserMessage(text, source) {
    return {
        content: [{ type: 'text', text }],
        source,
    };
}
