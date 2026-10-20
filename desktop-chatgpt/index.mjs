import Schema from '@deepseek-ai/schemastery';
import { applyChatGpt } from './chatgpt.js';

export const name = 'desktop-chatgpt-account';
export const inject = ['credentials', 'connection', 'llm', 'webServer'];
export const Config = Schema.object({});
export function apply(ctx) {
  applyChatGpt(ctx, { desktop: true });
}
