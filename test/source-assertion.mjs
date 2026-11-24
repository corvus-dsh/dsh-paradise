/**
 * ── SOURCE ASSERTIONS: the one way to read source text for an assertion ─────────────────────────
 *
 * Path: **shared test helper**（`test/mjs` 里被多个判据导入），不是新机制。
 *
 * ── WHY THIS FILE EXISTS (lead §四十五.2, P1) ───────────────────────────────────────────────────
 *
 * Three separate times in this batch, a criterion that greps SOURCE TEXT went green on the
 * EXPLANATION instead of the code:
 *
 *   1. `check-doc-claims` scanned its own documentation and matched the rule it was describing;
 *   2. `v329 ③`'s `/O/u` matched `a**o**uto is ON` — a comment, not a call site;
 *   3. `v336 ①` and `v337 ①` both failed on their own file headers, which have to QUOTE the shape
 *      they forbid;
 *   4. `v339 ③` went GREEN while the mechanism had been deleted, because the doc comment above it
 *      quoted the deleted spread.
 *
 * Three人工发现 ⇒ it must become a criterion. The rule:
 *
 *   > **任何对源码文本做 `assert.match` 的判据，必须先剥掉注释再匹配。**
 *
 * Two distinctions this helper keeps explicit, because collapsing them would break honest tests:
 *
 *   - **Comments are not code.** A file must be able to DOCUMENT a banned shape (「允许被提及、
 *     不许被采纳」, `v335 ②`). Stripping is what makes both halves possible.
 *   - **A string literal is not a comment either.** `'工作目录红线'` inside a string is data the
 *     code actually uses; only `//` and block comments are stripped here.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────────────────
 *
 * It does not parse TypeScript. It blanks comments while PRESERVING LINE COUNT, so a failure still
 * reports the real line number, and a regex that spans lines behaves as it did. A template literal
 * containing `//` will be mis-read — that is the honest limit, and it errs toward keeping text.
 */

/**
 * Blank out `//` line comments and block comments, preserving newlines and line numbers.
 *
 * Quote-aware: a `//` inside `'...'`, `"..."` or `` `...` `` is NOT a comment. This is the
 * distinction that separates 「documented shape」 from 「code」 without also deleting data.
 */
export function stripComments(source) {
  let out = ''
  let index = 0
  let quote
  const length = source.length
  while (index < length) {
    const char = source[index]
    if (quote !== undefined) {
      out += char
      if (char === '\\') {
        /** Keep the escaped character verbatim so `\'` does not close the string. */
        if (index + 1 < length) {
          out += source[index + 1]
          index += 2
          continue
        }
      }
      if (char === quote) quote = undefined
      index += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      /** Line comment: blank to end of line, keep the newline. */
      while (index < length && source[index] !== '\n') {
        out += ' '
        index += 1
      }
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      /** Block comment: blank it, but keep every newline so line numbers survive. */
      out += '  '
      index += 2
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        out += source[index] === '\n' ? '\n' : ' '
        index += 1
      }
      if (index < length) {
        out += '  '
        index += 2
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * Read a source file and return `{ raw, code }` — the line count of `code` equals `raw`'s, so an
 * assertion on `code` reports the same line numbers a reader sees in the editor.
 */
export function readSourceForAssertion(readFileSync, path, encoding = 'utf8') {
  const raw = readFileSync(path, encoding)
  return { raw, code: stripComments(raw) }
}
