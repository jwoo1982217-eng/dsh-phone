/** Text-to-image via an OpenAI-compatible images gateway.
 *
 * POST {base}/images/generations → {data:[{url|b64_json}]}; the artifact is
 * downloaded to the channel cache and returned as a local path for the
 * OneBot `image` segment. Long budgets: seedream runs ~60s per picture.
 */
export declare const IMAGE_MODELS: string[];
export interface DrawResult {
    imagePath: string;
    model: string;
    bytes: number;
}
export declare function drawImage(options: {
    prompt: string;
    model?: string;
    size?: string;
    base?: string;
    apiKey?: string;
}): Promise<DrawResult>;
