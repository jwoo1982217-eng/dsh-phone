#!/usr/bin/env node

const REGISTRY = 'https://registry.npmjs.org'
const SEARCH = `${REGISTRY}/-/v1/search`
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000

function usage(message) {
  const stream = message === undefined ? process.stdout : process.stderr
  if (message !== undefined) stream.write(`${message}\n`)
  stream.write('Usage: node find-plugins.mjs --query "browser automation" [--limit 5]\n')
  if (message !== undefined) process.exitCode = 2
}

function argumentsOf(argv) {
  let query
  let limit = 5
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--query') query = argv[index += 1]
    else if (value === '--limit') limit = Number(argv[index += 1])
    else if (value === '--help' || value === '-h') return { help: true }
    else throw new Error(`Unknown argument: ${String(value)}`)
  }
  if (typeof query !== 'string' || query.trim() === '') throw new Error('--query must be a non-empty string')
  if (query.length > 160) throw new Error('--query must be at most 160 characters')
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('--limit must be an integer from 1 to 10')
  return { help: false, query: query.trim(), limit }
}

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function strings(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

async function json(url, label) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${label} returned HTTP ${String(response.status)}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error(`${label} response is too large`)
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new Error(`${label} response is too large`)
  return JSON.parse(body)
}

function repositoryOf(metadata) {
  const repository = metadata.repository
  if (typeof repository === 'string') return repository
  return typeof object(repository)?.url === 'string' ? object(repository).url : undefined
}

function publisherOf(metadata, fallback) {
  if (typeof metadata.author === 'string') return metadata.author
  const author = object(metadata.author)
  if (typeof author?.name === 'string') return author.name
  return fallback
}

function validBundle(metadata, expectedName, expectedVersion) {
  if (metadata.name !== expectedName || metadata.version !== expectedVersion) return false
  if (!strings(metadata.keywords).includes('dsh-plugin')) return false
  const dsh = object(metadata.dsh)
  const bundle = object(dsh?.bundle)
  if (typeof bundle?.patch !== 'string' || bundle.patch.trim() === '') return false
  const dist = object(metadata.dist)
  if (typeof dist?.integrity !== 'string' || !dist.integrity.startsWith('sha512-')) return false
  if (typeof dist?.tarball !== 'string') return false
  try {
    return new URL(dist.tarball).origin === REGISTRY
  } catch {
    return false
  }
}

function searchScore(entry, query) {
  const pkg = object(entry.package) ?? {}
  const score = object(entry.score) ?? {}
  const detail = object(score.detail) ?? {}
  const haystack = [pkg.name, pkg.description, ...strings(pkg.keywords)]
    .filter(value => typeof value === 'string').join(' ').toLocaleLowerCase()
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  const matches = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
  const relevance = terms.length === 0 ? 0 : matches / terms.length
  return relevance * 3
    + Number(score.final ?? 0)
    + Number(detail.popularity ?? 0) * 0.7
    + Number(detail.quality ?? 0) * 0.4
    + Number(detail.maintenance ?? 0) * 0.3
}

function matchesQuery(entry, query) {
  const pkg = object(entry.package) ?? {}
  const haystack = [pkg.name, pkg.description, ...strings(pkg.keywords)]
    .filter(value => typeof value === 'string').join(' ').toLocaleLowerCase()
  return query.toLocaleLowerCase().split(/\s+/u).filter(Boolean).some(term => haystack.includes(term))
}

async function searchPlugins(query, limit) {
  const url = new URL(SEARCH)
  url.searchParams.set('text', `keywords:dsh-plugin ${query}`)
  url.searchParams.set('size', '250')
  const response = object(await json(url, 'npm plugin search'))
  const candidates = Array.isArray(response?.objects) ? response.objects : []
  const ranked = candidates
    .filter((entry) => strings(object(entry)?.package?.keywords).includes('dsh-plugin'))
    .filter(entry => matchesQuery(entry, query))
    .sort((left, right) => searchScore(right, query) - searchScore(left, query))
    .slice(0, Math.max(limit * 3, 12))

  const inspected = await Promise.all(ranked.map(async (entry) => {
    const item = object(entry)
    const pkg = object(item?.package)
    if (typeof pkg?.name !== 'string' || typeof pkg.version !== 'string') return undefined
    try {
      const versionUrl = new URL(`/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`, REGISTRY)
      const metadata = object(await json(versionUrl, `${pkg.name}@${pkg.version}`))
      if (metadata === undefined || !validBundle(metadata, pkg.name, pkg.version)) return undefined
      const score = object(item.score)
      const detail = object(score?.detail)
      const dsh = object(metadata.dsh)
      const pluginCenter = object(dsh?.pluginCenter)
      const keywords = strings(metadata.keywords)
      return {
        packageName: pkg.name,
        version: pkg.version,
        description: typeof metadata.description === 'string' ? metadata.description : '',
        publisher: publisherOf(metadata, object(pkg.publisher)?.username ?? 'npm publisher'),
        updatedAt: typeof pkg.date === 'string' ? pkg.date : undefined,
        keywords,
        kind: keywords.includes('dsh-skill-pack') ? 'skill-pack' : 'plugin',
        hasClient: object(dsh?.client) !== undefined,
        repository: repositoryOf(metadata),
        homepage: typeof metadata.homepage === 'string' ? metadata.homepage : undefined,
        catalogSummary: typeof pluginCenter?.summary === 'string' ? pluginCenter.summary : undefined,
        scores: {
          final: Number(score?.final ?? 0),
          popularity: Number(detail?.popularity ?? 0),
          quality: Number(detail?.quality ?? 0),
          maintenance: Number(detail?.maintenance ?? 0),
        },
      }
    } catch {
      return undefined
    }
  }))
  return inspected.filter(Boolean).slice(0, limit)
}

let args
try {
  args = argumentsOf(process.argv.slice(2))
} catch (error) {
  usage(error instanceof Error ? error.message : String(error))
}

if (args?.help) usage()
else if (args !== undefined) {
  try {
    const results = await searchPlugins(args.query, args.limit)
    process.stdout.write(`${JSON.stringify({
      query: args.query,
      source: 'npm-public-dsh-plugin',
      generatedAt: new Date().toISOString(),
      count: results.length,
      results,
    }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`find-plugins: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
