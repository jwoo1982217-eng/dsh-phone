/** dsh-channel-qq — QQ channel plugin for DeepSeek Harness over OneBot v11.
 *
 * Ported from the OpenClaw `extensions/qq` channel. What moved over:
 *   - OneBot v11 transport (forward/reverse WS, echo API calls, reconnect)
 *   - trigger gate (mention / keyword / talk-value probability)
 *   - keyword reaction hints, smart segmentation, rate limiting, length caps
 *   - a OneBot tool subset for the agent
 *   - lite sticker stealing / auto-send
 * What deliberately did not move: the plugin's own access-control and
 * moderation stack (the harness's permission presets own that), its custom
 * model-caller rotation (the harness's llm seam owns that), and its
 * heartflow/PFC brain (the harness agent loop owns that). Persona comes from
 * the agent preset + workspace instruction files, not from channel config.
 */
import { Service } from '@deepseek-ai/cordis';
export declare class ChannelQQ extends Service {
    static inject: string[];
    private readonly config;
    private client;
    private bridge;
    private emoji;
    private scheduler;
    private emojiLibrary;
    private readonly log;
    constructor(ctx: ConstructorParameters<typeof Service>[0], config: unknown);
    [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void>;
    private onEvent;
}
export default ChannelQQ;
