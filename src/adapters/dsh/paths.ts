/**
 * THE ONE HOST'S PATH LAYOUT — `adapters/dsh/`.
 *
 * WHAT MOVED HERE, AND WHY THAT IS THE POINT OF THE EXERCISE
 *
 * `src/read/disk.ts` used to contain `escapeSessionDirName` and `sessionLogPath`. Both are FACTS
 * ABOUT ONE HOST: the percent-ish `~XXXX` escaping, the `--` wrapper, the `sessions/<escaped cwd>/
 * <id>/…` layout, the file name. None of that is a protocol concept — a second host would have a
 * completely different (or no) on-disk layout.
 *
 * So they live here. `read/` takes a path or a "give me the path" callback and stays neutral; an
 * adapter that knows a layout supplies it. That is exactly the shape `PARADISE_SPEC.md` tells the
 * next implementer to follow.
 *
 * THE ESCAPING IS MEASURED, NOT GUESSED
 *
 *   `D:\持久层能力架构` → `--D-~6301~4E45~5C42~80FD~529B~67B6~6784--`
 *   `D:\软件开发`        → `--D-~8F6F~4EF6~5F00~53D1--`
 *
 * Both were read off this machine's real sessions root and matched against the headers inside. A
 * wrong guess here produces a plausible-looking path that reads nothing, which is worse than saying
 * "unknown" — so the derivation always labels itself `derived:` and never claims authority.
 */

import { SESSION_LOG_FILENAME } from '../../policy.js'

/**
 * This host's session-directory escaping (NOT `encodeURIComponent`).
 *
 * `A-Za-z0-9` survive; every other character becomes `~` + its FOUR-digit uppercase UTF-16 code unit;
 * the drive colon is dropped and separators become `-`. The `--` on both ends is this layout's
 * wrapper.
 */
export function escapeSessionDirName(cwd: string): string {
  let body = ''
  for (const char of cwd) {
    if (/[A-Za-z0-9]/u.test(char)) {
      body += char
      continue
    }
    if (char === ':') continue // the drive colon is structural, not content
    if (char === '\\' || char === '/') {
      body += '-'
      continue
    }
    const code = char.codePointAt(0) ?? 0
    if (code > 0xffff) {
      /**
       * Astral: TWO UTF-16 code units, each escaped separately — this host escapes code UNITS, not
       * code points. `for (const unit of char)` would be wrong here: a string's iterator yields code
       * POINTS again, so it would hand back the same astral character and emit only the high
       * surrogate (D83C) while silently dropping the low one (DC04). Indexing does not lie.
       */
      body += `~${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      body += `~${char.charCodeAt(1).toString(16).toUpperCase().padStart(4, '0')}`
      continue
    }
    body += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return `--${body}--`
}

/**
 * Where one session's durable log lives — DERIVED, and labelled as derived.
 *
 * No service on this host exposes the durable path, so the only remaining option is the layout the
 * host demonstrably uses. A derived path that is WRONG produces "读文件失败", which is honest. A path
 * presented as authoritative when it is not would be the same class of lie as an invisible briefing.
 */
export function sessionLogPath(input: {
  cwd: string
  sessionId: string
  home?: string
  env?: Record<string, string | undefined>
}): { path: string; source: string; notes: string[] } {
  const notes: string[] = []
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
  const home = (() => {
    if (typeof input.home === 'string' && input.home.trim().length > 0) return input.home.trim()
    const env = input.env ?? (process.env as Record<string, string | undefined>)
    return typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  })()

  if (cwd.length === 0) {
    notes.push('调用方没有提供 cwd，无法推导日志路径')
    return { path: '', source: 'unavailable', notes }
  }
  if (home.length === 0) {
    notes.push('DSH_HOME 环境变量不可用，无法推导日志路径')
    return { path: '', source: 'unavailable', notes }
  }
  const escaped = escapeSessionDirName(cwd)
  const base = home.replace(/[\\/]+$/u, '')
  notes.push('日志路径由 cwd 推导（derived:sessions-layout），不是宿主直接给出的')
  return {
    path: `${base}\\sessions\\${escaped}\\${input.sessionId}\\${SESSION_LOG_FILENAME}`,
    source: 'derived:sessions-layout',
    notes,
  }
}
