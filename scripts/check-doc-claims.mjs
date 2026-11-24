#!/usr/bin/env node
/**
 * ── check-doc-claims: a comment that says 「no dependencies」 must not outlive the fact ──────────
 *
 * WHY (lead §三十五.3): after `devDependencies.typescript` was declared, three comments still said
 *
 *     this package declares no dependencies, `npm install` installs nothing
 *
 * **and nothing turned red.** The comments were not stale in a cosmetic way: the paragraph around them
 * described a 533-pass / 13-skip split that could no longer happen, so the next reader would take a
 * measurement that had already stopped being true as the current one. 一条真的历史读数，被当成现状。
 *
 * ── THE AXIS IS THE QUALIFIER, NOT THE PHRASE ─────────────────────────────────────────────────────
 *
 * The true statement has not changed: RUNTIME `dependencies` must stay empty (that is B4-A, and
 * `check-runtime-deps.mjs` enforces it). What changed is that `devDependencies` is no longer empty, so
 * 「declares no dependencies」 with no qualifier is now a false sentence about the manifest.
 *
 * So the rule is: when `devDependencies` is NON-EMPTY, an unqualified 「declares no dependencies」 /
 * 「installs nothing」 fails the push. When it is empty, those sentences are true and are allowed.
 *
 * **Both directions are asserted.** A gate that banned the phrase outright would be red on a future
 * checkout that legitimately declares nothing — and the obvious "fix" would be to weaken the gate.
 *
 * Usage: node scripts/check-doc-claims.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Phrases that are only true while `devDependencies` is empty. */
const UNQUALIFIED = ['declares no dependencies', 'installs nothing', 'has none to install']

/** A line that names RUNTIME is making the narrower, still-true claim. */
const QUALIFIER = /\bruntime\b/iu

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const devCount = Object.keys(manifest.devDependencies ?? {}).length

/**
 * Only the scripts and docs a reader consults for the manifest story. Scanning the whole tree would flag
 * test fixtures that deliberately quote the old wording to prove this very gate works.
 *
 * THIS FILE IS EXCLUDED, and the reason is not convenience: a gate that forbids a sentence must be able to
 * WRITE the sentence down (its own header quotes it twice). Measured on the first run: without this
 * exclusion the gate failed on `check-doc-claims.mjs:7`, i.e. on its own explanation — the same
 * 「the checker matches itself」 shape as a regex that matched `auto is ON`.
 */
const SELF = join('scripts', 'check-doc-claims.mjs')
const FILES = ['README.md', 'ARCHITECTURE.md', ...readdirSync(join(ROOT, 'scripts')).filter((name) => name.endsWith('.mjs')).map((name) => join('scripts', name))].filter(
  (name) => name !== SELF,
)

/**
 * A line that QUOTES the phrase is describing it, not asserting it — the same distinction the whole batch
 * keeps drawing (「形式」 vs 「事实」). Measured: after the exclusion above, the gate then failed on the two
 * lines of `check-readme-counts.mjs` that explain the history of the sentence, both of which quote it
 * inside 「」.
 *
 * So quoted spans are removed before matching. An unquoted claim is an assertion about the manifest;
 * a quoted one is a mention of it.
 */
const stripQuoted = (line) => {
  let bare = line
    .replace(/「[^」]*」/gu, ' ')
    .replace(/『[^』]*』/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
    .replace(/"[^"]*"/gu, ' ')
  /**
   * A quote may SPAN lines (measured: `check-readme-counts.mjs:167` opens 「 and closes it on the next
   * line). When a line opens a quote it does not close, everything from that point on is quotation —
   * blank it, or the first half of a quoted sentence reads as an assertion.
   */
  const open = (bare.match(/「/gu) ?? []).length
  const close = (bare.match(/」/gu) ?? []).length
  if (open > close) bare = bare.slice(0, bare.lastIndexOf('「'))
  return bare
}

const offenders = []
for (const relative of FILES) {
  let text
  try {
    text = readFileSync(join(ROOT, relative), 'utf8')
  } catch {
    continue
  }
  text.split('\n').forEach((line, index) => {
    const bare = stripQuoted(line).toLowerCase()
    for (const phrase of UNQUALIFIED) {
      if (!bare.includes(phrase)) continue
      if (QUALIFIER.test(bare)) continue
      offenders.push(`${relative}:${index + 1}  «${phrase}»  ${line.trim().slice(0, 110)}`)
    }
  })
}

if (devCount === 0) {
  /**
   * NEGATIVE HALF: with an empty `devDependencies` these sentences are TRUE. The gate must say so rather
   * than leaving the reader to infer it from silence.
   */
  console.log(
    `doc-claims: OK — devDependencies is EMPTY, so 「declares no dependencies」/「installs nothing」 are true (${offenders.length} such line(s) allowed)`,
  )
  process.exit(0)
}

if (offenders.length > 0) {
  console.error(
    `doc-claims: FAILED — devDependencies has ${devCount} entr(y/ies), so these unqualified claims are FALSE:`,
  )
  for (const line of offenders) console.error(`  ❌ ${line}`)
  console.error(
    '\nFix the sentence, do not weaken the gate: say 「no RUNTIME dependencies」 (still true — `dependencies` stays empty).',
  )
  process.exit(1)
}

console.log(`doc-claims: OK — devDependencies has ${devCount} entr(y/ies) and no unqualified 「no dependencies」 claim survives`)