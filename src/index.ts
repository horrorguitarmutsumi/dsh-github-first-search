/**
 * dsh-github-first-search — GitHub-first research for DeepSeek Harness.
 *
 * 立项/选型前，agent 应优先搜索 GitHub 找参考实现，而不是直接动手或泛泛地
 * web 搜索。本插件提供两个工具，全部逻辑在 Rust 引擎（engine/），此文件只是
 * defineTool → spawn → JSON 的薄桥接：
 *
 *  - search_github_repos:  GitHub 仓库实时搜索（按 star 排序）
 *  - read_github_readme:   读取某仓库 README（markdown）
 *
 * 行为规则的落地方式：通过工具 description 告知 agent 何时必须调用（与官方
 * dsh-find-plugin 相同的模式）；另可在用户侧 AGENTS.md 里追加一条固定规则，
 * 见 README.md。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  buildReadmeArgs,
  buildSearchArgs,
  resolveEngineBin,
  runEngine,
  type EngineRun,
} from './engine.ts'
import { emptySearch, renderReadme, renderSearch, type ReadmeValue, type SearchValue } from './render.ts'

export const name = 'dsh-github-first-search'
export const inject = ['tools', 'systemPrompt']

/** DSH credential name; `credentialRef()` is a runtime identity, so no import. */
const GITHUB_TOKEN_REF = 'GITHUB_TOKEN'

/**
 * Resolve the optional GITHUB_TOKEN credential. The credentials service is an
 * **optional** dependency, so read it with `ctx.get()` rather than declaring it
 * in `inject` — a missing required service would stop this plugin from loading.
 */
async function resolveGitHubToken(ctx: Context): Promise<string | undefined> {
  try {
    const credentials = typeof ctx.get === 'function'
      ? (ctx.get('credentials') as
        | { resolve?: (ref: string) => Promise<{ value?: string } | undefined> }
        | undefined)
      : undefined
    if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined
    const resolved = await credentials.resolve(GITHUB_TOKEN_REF)
    const value = resolved?.value
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

const SEARCH_NOTE =
  'GitHub 实时搜索。立项前优先阅读同领域成熟仓库的实现；复用代码时注意许可证（MIT/Apache-2.0 等）。配置 DSH GITHUB_TOKEN 凭据可提高速率上限。'

const NO_ENGINE_NOTE =
  '引擎二进制未找到：先运行 `npm run build:engine`（需要 Rust 工具链），或将 DSH_GITHUB_FIRST_SEARCH_BIN 指向 github-first 可执行文件。'

/** Human-facing failure note; degrades instead of throwing so the agent can adapt. */
function describeFailure(run: EngineRun): string {
  const kind = run.error?.kind ?? 'unknown'
  if (kind === 'rate_limited') {
    return `GitHub 速率受限（${run.error?.message ?? 'quota exceeded'}）。配置 DSH GITHUB_TOKEN 凭据可提高上限，稍后重试。`
  }
  if (kind === 'spawn') return run.error?.message ?? '引擎启动失败。'
  if (kind === 'http') {
    const status = /\b(40\d|50\d)\b/.exec(run.error?.message ?? '')?.[1]
    if (status === '404') return '目标不存在（HTTP 404）：请检查仓库名是否拼写正确。'
    return `GitHub API 出错（${run.error?.message ?? 'HTTP error'}）。`
  }
  const stderr = run.stderr.trim()
  return `引擎调用失败（${kind}）：${run.error?.message ?? 'unknown error'}${stderr ? `; stderr: ${stderr.slice(0, 300)}` : ''}`
}

const OBJECT_OUTPUT = { schema: { type: 'object', additionalProperties: true } } as const

/**
 * 全局行为规则（无例外）：只要本轮需要联网搜索，第一步必须是 GitHub。
 * 注册在 TOOL_WEB_SEARCH(2000) 之前的 1990 位，正好排在宿主 web 搜索指引前面，
 * 模型读到 web 搜索说明时已经带着这条规则。
 */
const GITHUB_FIRST_POLICY = [
  'GitHub-first search policy (plugin dsh-github-first-search) — NO exceptions:',
  '- MANDATORY ORDER: whenever ANY search would help answer the user — news, current events, research, comparisons, how something works, tools or libraries, debugging, project setup, any topic at all — call `search_github_repos` FIRST, before any other search tool. Derive keywords from the question (try both English and the user\'s language).',
  '- Even for pure news: search GitHub FIRST for the first-hand source (the project / org / user named in the news), then use generic web search to supplement coverage.',
  '- Generic web search is only allowed AFTER a GitHub search has been performed in the same turn. If GitHub returned nothing relevant, say so explicitly, then continue with web search.',
  '- 任何需要联网搜索的场景——包括新闻、资讯、事件——第一步必须先调用 search_github_repos 搜 GitHub（新闻也先搜当事项目/组织名拿一手出处），之后才允许用普通 web 搜索补充；GitHub 没搜到要明确说明。',
].join('\n')

export function apply(ctx: Context): void {
  const bin = resolveEngineBin()

  ctx.systemPrompt.section({
    name: 'dsh-github-first-search:policy',
    order: 1990,
    text: GITHUB_FIRST_POLICY,
  })

  ctx.tools.register(defineTool({
    name: 'search_github_repos',
    description:
      'GitHub-first search: live GitHub repository search, star-ranked. IMPORTANT — this is the FIRST search ' +
      'tool for EVERY search need, with NO exceptions: news, current events, research, comparisons, tools or ' +
      'libraries, project setup, debugging — always call this before any other search tool, then supplement with ' +
      'generic web search afterwards if needed. Supports GitHub qualifiers (language:, stars:, org:) and returns ' +
      'clone URLs. Falls back to a clear note when GitHub is rate limited or the engine is missing; the note ' +
      'states the cause and how to fix it.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Keywords or natural-language phrase; GitHub qualifiers like language:rust pass through',
      },
      limit: {
        type: 'number',
        description: 'Max results (default 8, max 20)',
      },
      sort: {
        type: 'string',
        enum: ['stars', 'forks', 'updated', 'best-match'],
        description: 'Sort order (default stars)',
      },
      language: {
        type: 'string',
        description: 'Language filter, e.g. rust / typescript / go',
      },
      min_stars: {
        type: 'number',
        description: 'Minimum star count filter',
      },
    },
    output: {
      ...OBJECT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderSearch(value as unknown as SearchValue) }],
    },
    execute: async (args, exec) => {
      if (bin === undefined) return { ...emptySearch(args.query), note: NO_ENGINE_NOTE }
      const token = await resolveGitHubToken(ctx)
      const run = await runEngine(bin, buildSearchArgs(args), {
        env: token === undefined ? undefined : { GITHUB_TOKEN: token },
        signal: exec?.signal,
      })
      if (!run.ok || run.value === undefined) return { ...emptySearch(args.query), note: describeFailure(run) }
      const value = run.value as unknown as SearchValue
      return { ...value, note: value.note ?? SEARCH_NOTE }
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
  }))

  ctx.tools.register(defineTool({
    name: 'read_github_readme',
    description:
      'Fetch a GitHub repository README as markdown (owner/name form). Use after search_github_repos to ' +
      'inspect the top candidate before adopting its approach or scaffolding a similar project. Content is ' +
      'capped at ~20k chars; a clear note is returned when the repo does not exist or has no README.',
    parameters: {
      repo: {
        type: 'string',
        required: true,
        description: 'Repository in owner/name form, e.g. tokio-rs/tokio',
      },
    },
    output: {
      ...OBJECT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderReadme(value as unknown as ReadmeValue) }],
    },
    execute: async (args, exec) => {
      const empty = { repo: args.repo, path: '', html_url: '', content: '', truncated: false }
      if (bin === undefined) return { ...empty, note: NO_ENGINE_NOTE }
      const token = await resolveGitHubToken(ctx)
      const run = await runEngine(bin, buildReadmeArgs(args.repo, 20000), {
        env: token === undefined ? undefined : { GITHUB_TOKEN: token },
        signal: exec?.signal,
      })
      if (!run.ok || run.value === undefined) return { ...empty, note: describeFailure(run) }
      return run.value as unknown as ReadmeValue
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
  }))
}
