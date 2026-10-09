import { execFile } from 'node:child_process'
import { dirname, resolve, relative } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const generatorScript = resolve(dirname(fileURLToPath(import.meta.url)), 'source/generate-deck.mjs')
const themeNames = {
  ocean: '深海指挥舱',
  airlab: '晴空研究所',
  swiss: '瑞士编辑',
  gallery: '午夜美术馆',
}
const focusNames = {
  plugin: '方法结构',
  human: '用户参与',
  result: '成果证据',
}

export const name = 'dsh-motion-deck'
export const inject = ['tools']

const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string', enum: ['render', 'inspect'] },
    project: { type: 'string' },
    output: { type: 'string' },
    title: { type: 'string' },
    bytes: { type: 'integer' },
    pages: { type: 'integer' },
    theme: { type: 'string' },
    themeName: { type: 'string' },
    focus: { type: 'string' },
    focusName: { type: 'string' },
    motions: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'action', 'project', 'output', 'title', 'bytes', 'pages', 'theme', 'themeName', 'focus', 'focusName', 'motions', 'checks'],
}

function caseRootFor(exec) {
  return resolve(exec.agent?.session.header.cwd ?? process.cwd())
}

function projectArgFor(caseRoot, value) {
  if (typeof value !== 'string' || !/^generated\/[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw new Error('project_dir 必须是 generated/<kebab-case-name>')
  }
  const absolute = resolve(caseRoot, value)
  const rel = relative(caseRoot, absolute)
  if (rel.startsWith('..') || rel === '') throw new Error('project_dir 超出当前案例目录')
  return value
}

async function runGenerator(caseRoot, args, signal) {
  const result = await execFileAsync(process.execPath, [generatorScript, ...args, '--workspace', caseRoot], {
    cwd: caseRoot,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    signal,
  })
  return JSON.parse(result.stdout.trim())
}

function canonical(action, value) {
  return {
    ...value,
    action,
    themeName: themeNames[value.theme] ?? value.theme,
    focusName: focusNames[value.focus] ?? value.focus,
  }
}

function renderResult(_args, value) {
  const verb = value.action === 'render' ? '已从新大纲生成并验收' : '已复验'
  return [{
    type: 'text',
    text: `${verb}：${value.title}\n项目：${value.project}\n输出：${value.output}\n默认模板：${value.themeName}（${value.theme}）\n叙事重点：${value.focusName}（${value.focus}）\n页面：${value.pages}；动画：${value.motions.length}/8；检查：${value.checks.length} 项通过`,
  }]
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'render_motion_deck',
    description: '读取 generated/<项目>/input/outline.json，将用户的新内容装入四套模板和 8 个动画配方，生成新的 output/index.html；不会改写案例根部旧成果。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project_dir: {
          type: 'string',
          pattern: '^generated/[a-zA-Z0-9][a-zA-Z0-9-]*$',
          description: '新项目相对目录，例如 generated/ai-retail-2026。目录内必须已有 input/outline.json。',
        },
        theme: {
          type: 'string',
          enum: Object.keys(themeNames),
          description: '默认模板：ocean、airlab、swiss 或 gallery。最终 HTML 仍可切换全部四套模板。',
        },
        focus: {
          type: 'string',
          enum: Object.keys(focusNames),
          description: '叙事重点：plugin=方法结构、human=用户参与、result=成果证据。',
        },
      },
      required: ['project_dir', 'theme', 'focus'],
    },
    output: { schema: resultSchema, render: renderResult },
    async execute(args, exec) {
      const caseRoot = caseRootFor(exec)
      const project = projectArgFor(caseRoot, args.project_dir)
      const value = await runGenerator(caseRoot, ['render', '--project', project, '--theme', args.theme, '--focus', args.focus], exec.signal)
      return canonical('render', value)
    },
    presentCall(args) {
      return { card: 'generic', title: `从新大纲生成 · ${themeNames[args.theme]}`, kind: 'execute' }
    },
  })

  ctx.tools.register({
    name: 'inspect_motion_deck',
    description: '复验 generated/<项目>/output/index.html 是否真实包含新大纲、8 页、8 种动画、四套模板、离线资源和有效脚本。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project_dir: {
          type: 'string',
          pattern: '^generated/[a-zA-Z0-9][a-zA-Z0-9-]*$',
          description: '要验收的新项目相对目录。',
        },
      },
      required: ['project_dir'],
    },
    output: { schema: resultSchema, render: renderResult },
    async execute(args, exec) {
      const caseRoot = caseRootFor(exec)
      const project = projectArgFor(caseRoot, args.project_dir)
      const value = await runGenerator(caseRoot, ['verify', '--project', project], exec.signal)
      return canonical('inspect', value)
    },
    presentCall() {
      return { card: 'generic', title: '复验新 HTML 动效演示', kind: 'read' }
    },
  })
}
