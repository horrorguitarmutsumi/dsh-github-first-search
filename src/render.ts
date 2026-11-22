/**
 * Pure renderers and factories for tool outputs — no imports, unit-testable
 * offline. Renderers must be total: every field is guarded, nothing throws.
 */

/** One repository row of a search result. (type aliases — not interfaces — so
 *  these satisfy `Record<string, JsonValue>` via TS implicit index signatures.) */
export type RepoHit = {
  full_name: string
  html_url: string
  description: string
  stars: number
  forks: number
  language?: string | null
  topics: string[]
  updated_at: string
  open_issues: number
}

export type SearchValue = {
  query: string
  total_count: number
  results: RepoHit[]
  note?: string
}

export type ReadmeValue = {
  repo: string
  path: string
  html_url: string
  content: string
  truncated: boolean
  note?: string
}

const TOTAL = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const stars = (value: unknown): string => TOTAL(value).toLocaleString('en-US')

function withNote(text: string, note?: string): string {
  const trimmed = note?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? `${text}\n\n${trimmed}` : text
}

/** Canonical empty result — also the degraded shape used on engine failures. */
export function emptySearch(query: string): SearchValue {
  return { query, total_count: 0, results: [] }
}

export function renderSearch(value: SearchValue): string {
  const results = Array.isArray(value.results) ? value.results : []
  if (results.length === 0) {
    return withNote(`没有找到匹配的仓库（query: ${String(value.query ?? '')}）。`, value.note)
  }
  const blocks = results.map((hit, index) => {
    const lang =
      typeof hit.language === 'string' && hit.language.length > 0 ? ` [${hit.language}]` : ''
    const updated =
      typeof hit.updated_at === 'string' && hit.updated_at.length >= 10
        ? ` | updated: ${hit.updated_at.slice(0, 10)}`
        : ''
    const head = `${index + 1}. ${hit.full_name ?? ''} ★${stars(hit.stars)}${lang} — ${hit.description ?? ''}`
    const meta = `   ${hit.html_url ?? ''} | forks: ${stars(hit.forks)}${updated}`
    const topics =
      Array.isArray(hit.topics) && hit.topics.length > 0 ? `   topics: ${hit.topics.join(', ')}` : ''
    return topics === '' ? `${head}\n${meta}` : `${head}\n${meta}\n${topics}`
  })
  const footer = `共 ${stars(value.total_count)} 个匹配，显示前 ${results.length} 个。立项前优先阅读同领域的成熟实现；要参考某个仓库可直接 git clone <url>。`
  return withNote(`${blocks.join('\n\n')}\n\n${footer}`, value.note)
}

export function renderReadme(value: ReadmeValue): string {
  const head = `README ${value.repo ?? ''}（${value.path || 'README'}）${value.truncated ? ' [已截断]' : ''}`
  const link = value.html_url ? `\n在线阅读: ${value.html_url}` : ''
  const body =
    typeof value.content === 'string' && value.content.length > 0 ? `\n\n${value.content}` : '\n\n（空）'
  const tail = value.truncated === true ? '\n\n…[内容已截断，完整内容请访问在线链接]' : ''
  return withNote(`${head}${link}${body}${tail}`, value.note)
}
