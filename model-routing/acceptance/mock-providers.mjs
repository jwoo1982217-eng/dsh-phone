/**
 * Local mock LLM providers for acceptance runs.
 *
 * Two providers, no network: `mock-strong` and `mock-cheap` both answer with a
 * fixed line naming the provider/model that actually served the request, so the
 * transcript itself proves which member the routing group picked. A global
 * switch (`globalThis.__MOCK_PLAN__`) lets one member fail with 429 to exercise
 * failover without touching any real account.
 *
 * This plugin is loaded only for an acceptance run and removed afterwards.
 *
 * @module mock-providers
 */

export const name = 'model-routing-mock'
export const inject = ['llm']

const MODELS = {
  'mock-strong': 'mock-strong-1',
  'mock-cheap': 'mock-cheap-1'
}

import fs from 'node:fs'

/** Behaviour is read per request from a file, so an external driver can flip it. */
const PLAN_FILE = '/tmp/mock-plan.json'
function planFor(provider) {
  try {
    const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'))
    return plan[provider] ?? 'ok'
  } catch {
    return 'ok'
  }
}

export function apply(ctx) {
  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: provider === 'mock-strong' ? 'Mock Strong' : 'Mock Cheap' }
    },
    // Full LlmAdapter contract: this kernel calls these on a plain object at
    // registration time, so a missing method fails the whole registration.
    providerRetryPolicy(_provider) {
      return undefined
    },
    imageRequestPricing(_provider, _model) {
      return undefined
    },
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },
    async listModels(provider) {
      return [{ provider, id: MODELS[provider] ?? `${provider}-1`, name: `${provider} (local mock)` }]
    },
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 200000 } }
    },
    async prepareCall(provider, model) {
      return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
    },
    async *stream(options) {
      const behavior = planFor(options.provider)
      if (behavior === 'emit-then-fail') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `[served by ${options.provider}/${options.model}] partial` }
        const error = new Error('mock: failed after output')
        error.code = 'SERVER'
        error.status = 500
        error.failure = { message: 'mock: failed after output', code: 'SERVER', status: 500 }
        throw error
      }
      if (behavior === 'rate-limit') {
        // The kernel preserves a structured failure only when error.code
        // matches error.failure.code; otherwise it normalizes to UNKNOWN.
        const error = new Error('mock: 429 rate limited')
        error.code = 'RATE_LIMIT'
        error.status = 429
        error.failure = { message: 'mock: 429 rate limited', code: 'RATE_LIMIT', status: 429 }
        throw error
      }
      const served = `${options.provider}/${options.model}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `[served by ${served}] ok` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `[served by ${served}] ok` } }
      yield { type: 'usage', usage: { input: 1, output: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  ctx.llm.registerAdapter(['mock-strong', 'mock-cheap'], adapter)
  try { ctx.emit('llm/adapters-updated') } catch { /* no listener */ }
}
