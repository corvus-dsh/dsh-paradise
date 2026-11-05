#!/usr/bin/env node
/**
 * Build index.js from src/**.ts with Node's built-in type stripper.
 *
 * The contract is the same one `dsh-observer` uses: add a module under `src/`, import it from
 * `src/index.ts`, and the bundle picks it up in dependency order with no further work.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { composeBundle } from './bundle.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const { output, modules } = composeBundle(root)
writeFileSync(join(root, 'index.js'), output, 'utf8')
process.stdout.write(
  `built index.js (${Buffer.byteLength(output)} bytes, ${modules.length} inlined module(s): ${modules.join(', ')})\n`,
)
