/**
 * Bridge to the Rust engine (`engine/` cargo project).
 *
 * One spawn per call: argv in, a single JSON document on stdout.
 * Exit 0 → result; exit 1 → `{"error": {"kind", "message"}}`.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE_EXE = process.platform === 'win32' ? 'github-first.exe' : 'github-first'

/**
 * Locate the engine binary: `DSH_GITHUB_FIRST_SEARCH_BIN` override → local cargo
 * release build → debug build → Release-downloaded copy in `bin/`. The env
 * override is authoritative even when the path does not exist (explicit user
 * intent wins, and the spawn error names the exact path). Local dev builds
 * always win over the `bin/` copy, which is produced by postinstall /
 * `npm run install:engine` for users without a Rust toolchain.
 */
export function resolveEngineBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.DSH_GITHUB_FIRST_SEARCH_BIN
  if (typeof override === 'string' && override.length > 0) return override
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'engine', 'target', 'release', ENGINE_EXE),
    join(here, '..', 'engine', 'target', 'debug', ENGINE_EXE),
    join(here, '..', 'bin', ENGINE_EXE),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

export interface SearchInput {
  query: string
  limit?: number
  sort?: string
  language?: string
  min_stars?: number
}

/** Pure argv builder — `github-first search --query … --limit …`. */
export function buildSearchArgs(input: SearchInput): string[] {
  const argv = ['search', '--query', input.query]
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    argv.push('--limit', String(Math.max(1, Math.min(Math.trunc(input.limit), 20))))
  }
  if (typeof input.sort === 'string' && input.sort.length > 0) {
    argv.push('--sort', input.sort)
  }
  if (typeof input.language === 'string' && input.language.trim().length > 0) {
    argv.push('--language', input.language.trim())
  }
  if (typeof input.min_stars === 'number' && Number.isFinite(input.min_stars)) {
    argv.push('--min-stars', String(Math.max(0, Math.trunc(input.min_stars))))
  }
  return argv
}

/** Pure argv builder — `github-first readme owner/name --max-chars N`. */
export function buildReadmeArgs(repo: string, maxChars = 20000): string[] {
  return ['readme', repo, '--max-chars', String(maxChars)]
}

export interface EngineErrorPayload {
  kind: string
  message: string
}

export interface EngineRun {
  ok: boolean
  value?: Record<string, unknown>
  error?: EngineErrorPayload
  stderr: string
}

export interface RunOptions {
  /** Extra environment (e.g. the resolved GITHUB_TOKEN credential). */
  env?: NodeJS.ProcessEnv
  /** Forwarded from the tool run context; aborting kills the engine process. */
  signal?: AbortSignal
}

/**
 * Run the engine once and parse its stdout. Never throws — every failure is a
 * structured `EngineRun` so tools can degrade with a note instead of erroring.
 */
export function runEngine(bin: string, argv: string[], options: RunOptions = {}): Promise<EngineRun> {
  return new Promise(resolve => {
    const child = spawn(bin, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
      signal: options.signal,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (run: EngineRun): void => {
      if (!settled) {
        settled = true
        resolve(run)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      stdout += chunk
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => {
      finish({
        ok: false,
        error: {
          kind: 'spawn',
          message: `无法启动引擎 (${error.message})。请先运行 npm run build:engine（需要 Rust 工具链），或将 DSH_GITHUB_FIRST_SEARCH_BIN 指向 github-first 可执行文件。`,
        },
        stderr,
      })
    })
    child.on('close', code => {
      const trimmed = stdout.trim()
      let parsed: unknown
      try {
        parsed = trimmed.length > 0 ? JSON.parse(trimmed) : undefined
      } catch {
        parsed = undefined
      }
      const payload = parsed as { error?: EngineErrorPayload } | undefined
      if (code === 0 && payload !== undefined && payload.error === undefined) {
        finish({ ok: true, value: payload, stderr })
      } else if (payload?.error !== undefined) {
        finish({ ok: false, error: payload.error, stderr })
      } else {
        finish({
          ok: false,
          error: {
            kind: 'engine',
            message: `引擎异常退出 (code=${code ?? 'null'})${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ''}`,
          },
          stderr,
        })
      }
    })
  })
}
