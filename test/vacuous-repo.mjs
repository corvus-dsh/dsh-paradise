/**
 * ── VACUOUS REPO: build the state a criterion needs, in a throwaway git repo ─────────────────────
 *
 * 路径：**共享测试辅助**（`test/vacuous-repo.mjs`），配 `v341` 判据与 `check-source-assertions` 的门禁。
 *
 * ── WHY (lead §四十七.4) ───────────────────────────────────────────────────────────────────────
 *
 * `v136x` needed a tree with NO diff against HEAD. It got one by ASKING this repository:
 *
 *     const status = execFileSync('git', ['status', '--porcelain', '--', 'src'], …)
 *     if (status !== '' || diff) return          // 「脏树时跳过」
 *
 * That guard reads a GLOBAL, SHARED, MUTABLE state, and the test suite runs files CONCURRENTLY —
 * so another test could dirty `src/` between the guard and the assertion. Measured: green when run
 * alone, red inside the full suite, green again on the next run.
 *
 * > **判据必须只依赖它自己构造的输入。**
 * > **部分依赖比完全依赖更难发现**：完全依赖会稳定红，部分依赖会时红时绿，
 * > 于是被当成「偶发」记录，然后再没人管。
 *
 * Six other defects in this batch are the same shape (see `v341`'s header): a criterion whose
 * conclusion depends on somebody else's test, on which branch ran, on how far a sync got, on a run
 * that already finished, on a letter inside a comment, or on its own explanatory prose.
 *
 * ── WHAT THIS HELPER GUARANTEES ────────────────────────────────────────────────────────────────
 *
 *   - a real git repo (`git init`) — not a mock, because the thing under test shells out to git;
 *   - a deterministic identity, so `git commit` cannot fail on a machine with no global config;
 *   - **no reference to this working tree at all**, so concurrent tests cannot perturb it;
 *   - `dispose()` removes it even when the assertion throws.
 *
 * It deliberately does NOT try to be a general sandbox. It builds the smallest repo that makes a
 * criterion's premise true, and a caller that needs something else should extend it rather than
 * reach back into the real tree.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export class VacuousRepo {
  #root

  constructor(prefix = 'dsh-vacuous-') {
    this.#root = mkdtempSync(join(tmpdir(), prefix))
    this.git(['init', '-q'])
    /** A commit must not depend on the machine's global identity. */
    this.git(['config', 'user.email', 'vacuous@example.invalid'])
    this.git(['config', 'user.name', 'vacuous-repo'])
    this.git(['config', 'commit.gpgsign', 'false'])
  }

  get root() {
    return this.#root
  }

  /** Run git in the sandbox, returning stdout. Throws on non-zero with the output attached. */
  git(args, options = {}) {
    return execFileSync('git', args, {
      cwd: this.#root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
  }

  /** Write a file, creating parent directories. Paths are repo-relative and use `/`. */
  write(relPath, content) {
    const full = join(this.#root, ...relPath.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
    return full
  }

  /** Stage everything and commit. Returns the commit sha. */
  commit(message = 'baseline') {
    this.git(['add', '-A'])
    this.git(['commit', '-q', '-m', message])
    return this.git(['rev-parse', 'HEAD']).trim()
  }

  /** Does the working tree differ from HEAD (path-limited)? Never touches the real repository. */
  isDirty(relPath) {
    const status = this.git(['status', '--porcelain', '--', relPath]).trim()
    if (status !== '') return true
    try {
      this.git(['diff', '--quiet', 'HEAD', '--', relPath])
      return false
    } catch {
      return true
    }
  }

  /** Run a node script from THIS repository inside the sandbox, returning `{ code, out }`. */
  runNode(scriptPath, args = [], options = {}) {
    try {
      const out = execFileSync(process.execPath, [scriptPath, ...args], {
        cwd: this.#root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...options,
      })
      return { code: 0, out }
    } catch (error) {
      return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
  }

  /** Remove the sandbox. Safe to call twice. */
  dispose() {
    try {
      rmSync(this.#root, { recursive: true, force: true })
    } catch {
      /** A leftover temp dir is cheaper than a failing assertion. */
    }
  }
}

/** Convenience wrapper: `await withVacuousRepo(repo => { … })`. */
export async function withVacuousRepo(fn, prefix) {
  const repo = new VacuousRepo(prefix)
  try {
    return await fn(repo)
  } finally {
    repo.dispose()
  }
}
