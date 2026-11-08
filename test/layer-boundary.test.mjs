/**
 * P0 (audit 2026-11-08) — THE LAYER BOUNDARY: L1 MUST NOT NAME AN UPPER LAYER.
 *
 * ── THE DEFECT THIS PINS ───────────────────────────────────────────────────────────────────────
 *
 * `src/adapters/dsh/policy.ts` carried:
 *
 *     export const PROMPT_MARKER = '[dsh-observer 点火]'
 *
 * That is a layer inversion: this package is L1 (the physical host adapter). It may not know that
 * `dsh-observer` exists. Worse, the constant doubled as the IDEMPOTENCE KEY — so an upper layer
 * renaming its own marker would have silently stopped every prior ignition from being recognised,
 * re-triggering sessions that were already running.
 *
 * The fix moved the identity to the caller. These assertions are what keep it moved: a future edit
 * that reintroduces a sibling package's name fails HERE, at the layer that is not allowed to know it,
 * rather than at runtime as a missed idempotence check.
 *
 * ── WHY A SOURCE SCAN AND NOT A TYPE CHECK ────────────────────────────────────────────────────
 *
 * Types cannot express "this module must not mention that string". The dependency is a real one the
 * moment a literal appears, regardless of whether anything imports it — that is exactly how the
 * original constant happened.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PROMPT_MARKER, isPromptText, markerToStamp } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'src')

function walk(dir, ext = '.ts') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, ext))
    else if (entry.name.endsWith(ext)) out.push(full)
  }
  return out
}

/** Names of the sibling packages this layer must never know about. */
const UPPER_LAYER_NAMES = ['dsh-observer', 'dsh-graft-slice', 'dsh-memory']

test('L1: no upper-layer package name appears in any source file', () => {
  const offenders = []
  for (const file of walk(srcDir)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      for (const name of UPPER_LAYER_NAMES) {
        if (!line.includes(name)) continue
        /**
         * PROSE IS EXEMPT, CODE IS NOT. A comment explaining the history ("it used to name
         * dsh-observer") is documentation, not a dependency — and forbidding it would make the
         * reason for this rule unwritable. What must never come back is the name in a STRING
         * LITERAL or an identifier, which is what the checks below distinguish.
         */
        const trimmed = line.trim()
        const isComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
        if (isComment) continue
        offenders.push(`${file.replace(srcDir, 'src')}:${index + 1}: ${trimmed.slice(0, 120)}`)
      }
    })
  }
  assert.deepEqual(
    offenders,
    [],
    'dsh-paradise is the LAYER. A name here means the dependency runs backwards:\n' + offenders.join('\n'),
  )
})

test('L1: the default marker is NEUTRAL — it names no plugin', () => {
  assert.equal(typeof DEFAULT_PROMPT_MARKER, 'string')
  assert.ok(DEFAULT_PROMPT_MARKER.length > 0)
  for (const name of UPPER_LAYER_NAMES) {
    assert.ok(
      !DEFAULT_PROMPT_MARKER.includes(name),
      `the default marker must not name ${name}: ${DEFAULT_PROMPT_MARKER}`,
    )
  }
  assert.match(DEFAULT_PROMPT_MARKER, /plugin|插件|点火/u, 'it still has to say "a plugin started this"')
})

test('L1: isPromptText accepts a STRING and a LIST, and matches any entry', () => {
  const current = '[plugin 点火]'
  const legacy = '[dsh-observer 点火]'
  const text = `${legacy} 请开始执行。`

  assert.equal(isPromptText(text, current), false, 'a string compares only against that one marker')
  assert.equal(isPromptText(text, legacy), true)
  assert.equal(isPromptText(text, [current, legacy]), true, 'the list form must honour the alias')
  assert.equal(isPromptText(`${current} go`, [current, legacy]), true)
  assert.equal(isPromptText('人类自己说的话', [current, legacy]), false, 'a human prompt is never ours')
  assert.equal(isPromptText(undefined, current), false)
  assert.equal(isPromptText(42, current), false)
})

test('L1: an empty or malformed list entry is skipped, never matched by accident', () => {
  assert.equal(isPromptText('[plugin 点火] go', ['', '[plugin 点火]']), true)
  assert.equal(isPromptText('anything', ['', '   ']), false, 'blank entries must not match everything')
  assert.equal(isPromptText('anything', []), false)
})

test('L1: markerToStamp chooses exactly ONE marker, never a list', () => {
  assert.equal(markerToStamp(undefined), DEFAULT_PROMPT_MARKER, 'absent falls back to the neutral default')
  assert.equal(markerToStamp('  [custom 点火]  '), '[custom 点火]', 'a string is trimmed')
  assert.equal(markerToStamp(['[current 点火]', '[old 点火]']), '[current 点火]', 'entry 0 is the stamp')
  assert.equal(markerToStamp(['', '[old 点火]']), '[old 点火]', 'a blank first entry falls through')
  assert.equal(markerToStamp([]), DEFAULT_PROMPT_MARKER)
})
