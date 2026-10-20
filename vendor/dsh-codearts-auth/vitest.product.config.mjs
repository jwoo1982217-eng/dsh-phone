import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('./', import.meta.url));
export default { test: { include: ['tests/unit/**/*.spec.ts'], fileParallelism: false, setupFiles: ['./tests/setup-isolation.ts'] }, resolve: { alias: {
  "@deepseek-ai/dsh-llm": source + "../../desktop-runtime/node_modules/@deepseek-ai/dsh-llm/lib/index.js",
  "@deepseek-ai/dsh-credentials": source + "../../desktop-runtime/node_modules/@deepseek-ai/dsh-credentials/lib/index.js",
  "@deepseek-ai/cordis": source + "../../desktop-runtime/node_modules/@deepseek-ai/cordis/lib/index.js",
  "@deepseek-ai/schemastery": source + "../../desktop-runtime/node_modules/@deepseek-ai/schemastery/lib/index.cjs",
  "@deepseek-ai/cosmokit": source + "../../desktop-runtime/node_modules/@deepseek-ai/cosmokit/lib/index.js",
  "undici": source + "../../desktop-runtime/node_modules/undici/index.js",
  "jose": source + "../../desktop-runtime/node_modules/jose/dist/webapi/index.js"
} } };
