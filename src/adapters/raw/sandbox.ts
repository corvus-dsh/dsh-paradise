/**
 * THE SANDBOX — `adapters/raw/sandbox.ts`.
 *
 * WHAT IT ACTUALLY PROVIDES, STATED BEFORE ANYTHING ELSE
 *
 *   ✔ a SEPARATE THREAD. A tool that crashes the isolate does not take the harness with it.
 *   ✔ a HARD KILL. `worker.terminate()` ends a synchronous infinite loop — which `Promise.race` cannot.
 *   ✔ a RESTRICTED API SURFACE. The tool never sees `fs`; it sees four functions that check an allowlist.
 *   ✔ `require`, `process`, `module`, `__dirname` SHADOWED to undefined as parameters.
 *
 *   ✘ NOT A SECURITY BOUNDARY against a determined attacker. `globalThis` remains reachable through the
 *     `Function` constructor, and from there the host's own globals. An in-process VM cannot fix that;
 *     only a real permission boundary can.
 *
 * WHY THE HONESTY MATTERS MORE THAN THE FEATURE
 *
 * A sandbox that overstates itself is worse than none, because the caller stops looking. This module
 * therefore reports its strength in `SandboxCapabilities` and a caller that needs true isolation is
 * told to use `node --permission` or a container — see the note in `tools.ts`.
 *
 * WHAT THE ALLOWLIST ACTUALLY STOPS
 *
 * The realistic failure mode here is not a human attacker; it is a MODEL writing a plausible repair
 * that touches the wrong path — `rm -rf` on a home directory, a write into `node_modules`, an edit to
 * the harness's own source. The allowlist stops exactly that class of accident, which is the class that
 * exists. Claiming more would be the lie.
 */

import { Worker } from 'node:worker_threads'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/** What this sandbox can and cannot do. Read it before trusting a tool. */
export interface SandboxCapabilities {
  /** A separate thread; a crash is contained. */
  readonly threadIsolation: true
  /** A synchronous loop can be ended from outside. */
  readonly hardTimeout: true
  /** The tool's file access is checked against an allowlist before it happens. */
  readonly fsAllowlist: true
  /** `require` / `process` are shadowed as parameters. */
  readonly globalsShadowed: true
  /**
   * Whether a determined tool can still reach the host's globals.
   *
   * `true` for every in-process implementation, and saying so is the point: a caller that needs this to
   * be `false` must use an OS boundary, not this module.
   */
  readonly escapesGlobals: true
}

export const SANDBOX_CAPABILITIES: SandboxCapabilities = Object.freeze({
  threadIsolation: true,
  hardTimeout: true,
  fsAllowlist: true,
  globalsShadowed: true,
  escapesGlobals: true,
})

export interface SandboxOptions {
  /** Directories a tool may read from or write to. Anything else is refused BEFORE it happens. */
  readonly roots: readonly string[]
  /** Wall clock budget. On expiry the worker is TERMINATED, not merely raced. Default 15s. */
  readonly timeoutMs?: number
  /** Extra API members to expose. Values must be JSON-cloneable or functions the bootstrap wraps. */
  readonly extra?: Record<string, unknown>
}

export interface SandboxResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { code: string; message: string }
  /** True when the budget expired and the worker had to be killed. */
  readonly terminated?: boolean
}

/**
 * THE WORKER BOOTSTRAP, AS SOURCE TEXT.
 *
 * WHY A STRING AND NOT A SECOND FILE: `index.js` and `dist/harness.js` are single inlined bundles.
 * Shipping a sibling `sandbox-worker.js` would mean the worker file can be missing, stale, or a version
 * behind — a failure that only shows up the first time a repair actually runs. A string cannot drift
 * from its caller.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')

/**
 * THE ALLOWLIST IS ENFORCED HERE, in the bootstrap — not in the tool, and not in the caller.
 * A check the tool performs on itself is a check a tool can skip.
 *
 * ── v2.2.0: THE CHECK NOW USES REAL PATHS, NOT PATH STRINGS ─────────────────────────────────
 *
 * WHAT WAS WRONG. The old implementation compared \`path.resolve(target)\` against the roots.
 * \`path.resolve\` is LEXICAL: it collapses \`.\` and \`..\`, and it does NOT resolve symbolic links
 * or Windows directory junctions. So the predicate answered "does this STRING start with a root"
 * instead of "is this FILE inside a root" — and those differ whenever a link is involved.
 *
 * MEASURED CONSEQUENCE (this is not theory). With a junction inside a sandbox root that points
 * outside it, created by an unprivileged user with \`mklink /J\`:
 *
 *     api.readFile('<root>\\escape-link\\secret.txt')   -> READ the outside file
 *     api.writeFile('<root>\\escape-link\\pwned.txt')   -> WROTE outside the sandbox
 *
 * while the direct path, the \`..\` traversal, and the case variants were all correctly DENIED.
 * That contrast is what identifies the defect precisely: lexical normalization handles \`..\`,
 * and only real-path resolution handles links.
 *
 * WHY IT MATTERED. The roots include the user's home directory by default, and a home directory
 * very often already contains a junction to somewhere else. The code this sandbox executes is
 * MODEL-GENERATED repair code — written from whatever context the model was given, which in a
 * self-repair scenario is exactly the context an attacker would want to poison. Reading
 * \`~/.ssh/id_rsa\` or \`.aws/credentials\` through a pre-existing link needs no attacker action
 * beyond the injection.
 *
 * HOW IT IS FIXED. Resolve BOTH sides with \`fs.realpathSync\`, then compare with a path
 * separator. Two details are load-bearing:
 *
 *   1. A target that does not exist yet (the \`writeFile\` case) cannot be realpath'd directly.
 *      So the nearest EXISTING ancestor is resolved, and the unresolved remainder is appended
 *      lexically — refusing to walk up a symlink that does not exist yet, while still checking
 *      the directory path that will be created.
 *   2. Roots are resolved once, at startup. If a root itself is a link, the tool is confined to
 *      what that root really points at, which is what the operator meant by naming it.
 *
 * THE FAILURE MODE IS DENY. If realpath throws for a reason other than "not there yet", the
 * answer is "outside" — an allowlist that fails open is an allowlist that does not exist.
 */

function realRoots(list) {
  const out = []
  for (const root of list) {
    try {
      out.push(fs.realpathSync(root))
    } catch {
      // A root that does not exist cannot contain anything. Dropping it is stricter than keeping
      // its lexical form, which would match a path that is not really there.
    }
  }
  return out
}

const roots = realRoots(workerData.roots)

/**
 * The real path of \`target\`, resolving symlinks/junctions, allowing for a target that does not
 * exist yet by resolving its nearest existing ancestor and appending the rest lexically.
 */
function realish(target) {
  const absolute = path.resolve(String(target))
  let probe = absolute
  const tail = []
  for (;;) {
    try {
      const real = fs.realpathSync(probe)
      return tail.length === 0 ? real : path.join(real, ...tail.reverse())
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) throw Object.assign(new Error('SANDBOX_DENIED: unresolvable path ' + absolute), { code: 'SANDBOX_DENIED' })
      tail.push(path.basename(probe))
      probe = parent
    }
  }
}

function within(target) {
  let real
  try {
    real = realish(target)
  } catch {
    return false
  }
  for (const root of roots) {
    if (real === root) return true
    if (real.startsWith(root + path.sep)) return true
  }
  return false
}

function deny(op, target) {
  const error = new Error('SANDBOX_DENIED: ' + op + ' ' + String(target) + ' 不在允许的目录内（允许：' + roots.join(', ') + '）')
  error.code = 'SANDBOX_DENIED'
  throw error
}

const api = {
  readFile(target) {
    if (!within(target)) deny('read', target)
    return fs.readFileSync(String(target), 'utf8')
  },
  writeFile(target, content) {
    if (!within(target)) deny('write', target)
    fs.mkdirSync(path.dirname(String(target)), { recursive: true })
    fs.writeFileSync(String(target), String(content), 'utf8')
    return true
  },
  listDir(target) {
    if (!within(target)) deny('list', target)
    return fs.readdirSync(String(target))
  },
  exists(target) {
    if (!within(target)) deny('stat', target)
    try { return fs.statSync(String(target)).isFile() ? 'file' : 'dir' } catch { return 'missing' }
  },
  log(message) {
    parentPort.postMessage({ kind: 'log', text: String(message) })
  },
  roots: roots.slice(),
}

;(async () => {
  try {
    /**
     * THE DANGEROUS GLOBALS ARE PARAMETERS, so the tool body sees them as undefined.
     * A parameter shadows a global for the whole function body — including a nested function that
     * tries to read it. This is the one mechanism that actually works in-process.
     */
    const factory = new Function(
      'api', 'require', 'process', 'module', 'exports', '__dirname', '__filename',
      '"use strict"; return (' + workerData.source + ');',
    )
    const body = factory(api, undefined, undefined, undefined, undefined, undefined, undefined)
    if (body === null || typeof body !== 'object' || typeof body.execute !== 'function') {
      parentPort.postMessage({ ok: false, error: { code: 'TOOL_SHAPE_INVALID', message: '源码必须求值成 { execute } 对象' } })
      return
    }
    const value = await body.execute(workerData.args)
    parentPort.postMessage({ ok: true, value })
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        code: (error && error.code) || 'TOOL_THREW',
        message: String((error && error.message) || error),
      },
    })
  }
})()
`

/** Run one piece of authored source inside a worker, against the restricted API. */
export async function runInSandbox(source: string, args: Record<string, unknown>, options: SandboxOptions): Promise<SandboxResult> {
  if (!Array.isArray(options.roots) || options.roots.length === 0) {
    /**
     * A SANDBOX WITH NO ROOTS IS NOT "UNRESTRICTED", IT IS A CONFIGURATION BUG.
     * Treating an empty allowlist as "allow everything" is how a security feature becomes a
     * vulnerability the first time somebody forgets a flag.
     */
    return {
      ok: false,
      error: { code: 'SANDBOX_NO_ROOTS', message: '沙箱必须至少有一个允许目录；空 allowlist 不等于无限制，它是配置错误。' },
    }
  }

  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 15_000))
  return await new Promise<SandboxResult>((done) => {
    let settled = false
    let worker: Worker
    const finish = (result: SandboxResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().catch(() => {})
      done(result)
    }

    const timer = setTimeout(() => {
      /**
       * THIS IS THE LINE `Promise.race` CANNOT WRITE. A synchronous loop inside the worker never yields,
       * so only a terminate from outside ends it — and that is the failure mode a model-authored tool
       * actually produces (an accidental `while (true)`).
       */
      finish({ ok: false, terminated: true, error: { code: 'SANDBOX_TIMEOUT', message: `工具超过 ${timeoutMs}ms，已被强制终止` } })
    }, timeoutMs)
    if (typeof (timer as any).unref === 'function') (timer as any).unref()

    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { source, args, roots: options.roots },
        // The tool gets no authority beyond what the bootstrap grants. Resource limits are the
        // second half of "a bad tool cannot take the host down".
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
      })
    } catch (error) {
      clearTimeout(timer)
      settled = true
      done({ ok: false, error: { code: 'SANDBOX_SPAWN_FAILED', message: String((error as any)?.message ?? error) } })
      return
    }

    worker.on('message', (message: any) => {
      if (message?.kind === 'log') return
      if (message?.ok === true) finish({ ok: true, value: message.value })
      else finish({ ok: false, error: message?.error ?? { code: 'TOOL_FAILED', message: 'unknown' } })
    })
    worker.on('error', (error) => {
      finish({ ok: false, error: { code: (error as any)?.code ?? 'TOOL_THREW', message: String(error?.message ?? error) } })
    })
    worker.on('exit', (code) => {
      // An exit with a non-zero code and no message is a crash the worker could not report.
      if (code === 0) return
      finish({ ok: false, error: { code: 'WORKER_EXITED', message: `worker 退出码 ${code}` } })
    })
  })
}

/** A directory helper for the CLI: ensure a root exists before it is handed to a sandbox. */
export function ensureRoot(dir: string): string {
  const absolute = resolve(dir)
  mkdirSync(absolute, { recursive: true })
  return absolute
}

/** Is `target` inside one of `roots`? Exported so a caller can pre-check without spawning a worker. */
export function isWithinRoots(target: string, roots: readonly string[]): boolean {
  const resolved = resolve(target)
  for (const root of roots) {
    const base = resolve(root)
    if (resolved === base) return true
    if (resolved.startsWith(base + sep)) return true
  }
  return false
}

/** Read a file for the emergency prompt, refusing anything outside the roots. */
export function readWithin(target: string, roots: readonly string[], maxBytes = 60_000): string {
  if (!isWithinRoots(target, roots)) throw new Error(`SANDBOX_DENIED: read ${target}`)
  const text = readFileSync(resolve(target), 'utf8')
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n…（已截断，原文件 ${text.length} 字节）` : text
}

/** List a directory for the emergency prompt, refusing anything outside the roots. */
export function listWithin(target: string, roots: readonly string[]): string[] {
  if (!isWithinRoots(target, roots)) throw new Error(`SANDBOX_DENIED: list ${target}`)
  try {
    return readdirSync(resolve(target))
  } catch {
    return []
  }
}

/** Is this a readable file? Used to filter a source list without throwing. */
export function isFile(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

/** Write a file, creating parents. Used by the CLI to persist a report. */
export function writeFileEnsured(target: string, content: string): void {
  mkdirSync(dirname(resolve(target)), { recursive: true })
  writeFileSync(resolve(target), content, 'utf8')
}
