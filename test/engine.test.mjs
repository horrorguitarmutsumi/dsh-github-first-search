import test from 'node:test'
import assert from 'node:assert/strict'

import { buildReadmeArgs, buildSearchArgs, resolveEngineBin } from '../lib/engine.js'
import { emptySearch, renderReadme, renderSearch } from '../lib/render.js'

test('buildSearchArgs maps tool args to engine argv', () => {
  assert.deepEqual(
    buildSearchArgs({ query: 'terminal ui', limit: 5, sort: 'stars', language: 'rust', min_stars: 100 }),
    ['search', '--query', 'terminal ui', '--limit', '5', '--sort', 'stars', '--language', 'rust', '--min-stars', '100'],
  )
  assert.deepEqual(buildSearchArgs({ query: 'todo' }), ['search', '--query', 'todo'])
})

test('buildSearchArgs clamps limit into 1..20', () => {
  const argv = buildSearchArgs({ query: 'q', limit: 999 })
  assert.equal(argv[argv.indexOf('--limit') + 1], '20')
  const low = buildSearchArgs({ query: 'q', limit: 0 })
  assert.equal(low[low.indexOf('--limit') + 1], '1')
})

test('buildReadmeArgs builds readme argv', () => {
  assert.deepEqual(buildReadmeArgs('tokio-rs/tokio'), ['readme', 'tokio-rs/tokio', '--max-chars', '20000'])
})

test('resolveEngineBin honors the DSH_GITHUB_FIRST_SEARCH_BIN override', () => {
  const resolved = resolveEngineBin({ DSH_GITHUB_FIRST_SEARCH_BIN: '/some/custom/github-first' })
  assert.equal(resolved, '/some/custom/github-first')
})

test('resolveEngineBin falls back to a real binary on this machine', () => {
  const resolved = resolveEngineBin({})
  assert.equal(typeof resolved, 'string')
  assert.match(resolved, /github-first(\.exe)?$/)
})

test('renderSearch lists hits with stars, link and footer', () => {
  const text = renderSearch({
    query: 'tui',
    total_count: 42,
    results: [{
      full_name: 'a/b',
      html_url: 'https://github.com/a/b',
      description: 'demo',
      stars: 1234,
      forks: 5,
      language: 'Rust',
      topics: ['cli'],
      updated_at: '2026-01-02T00:00:00Z',
      open_issues: 1,
    }],
  })
  assert.match(text, /1\. a\/b ★1,234 \[Rust\] — demo/)
  assert.match(text, /https:\/\/github\.com\/a\/b/)
  assert.match(text, /topics: cli/)
  assert.match(text, /共 42 个匹配/)
})

test('renderSearch empty result carries the note', () => {
  const text = renderSearch({ ...emptySearch('q'), note: 'GitHub 速率受限' })
  assert.match(text, /没有找到匹配的仓库/)
  assert.match(text, /GitHub 速率受限/)
})

test('renderReadme shows truncation marker', () => {
  const text = renderReadme({
    repo: 'a/b',
    path: 'README.md',
    html_url: 'https://github.com/a/b#readme',
    content: 'hello',
    truncated: true,
  })
  assert.match(text, /README a\/b（README\.md） \[已截断\]/)
  assert.match(text, /hello/)
})
