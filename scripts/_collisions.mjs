/**
 * Two checks the bundler does not make, both of which shipped a broken artifact once.
 *
 *   1. DUPLICATE TOP-LEVEL IDENTIFIERS. Inlining N modules into ONE scope means any name declared at
 *      the top level of two modules is a SyntaxError in the shipped file — invisible to the build,
 *      because the build never loads what it writes.
 *   2. DOES IT LOAD? The whole point of the bundle is that something can import it. A parse check does
 *      not prove that either (a duplicate identifier is a parse/instantiation error).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(root, 'index.js')
const bundle = readFileSync(bundlePath, 'utf8')

const DECL = /^(?:export\s+)?(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/gmu
const lines = bundle.split('\n')
const where = new Map()
const collisions = []
lines.forEach((line, index) => {
  const match = DECL.exec(line)
  DECL.lastIndex = 0
  if (match === null) return
  const name = match[1]
  const first = where.get(name)
  if (first === undefined) where.set(name, index + 1)
  else collisions.push(`${name}: 行 ${first} 与 行 ${index + 1}`)
})

console.log(`top-level declarations: ${where.size}`)
if (collisions.length === 0) console.log('no duplicate top-level identifiers')
else {
  console.log(`DUPLICATES (${collisions.length}):`)
  for (const line of collisions) console.log('  ' + line)
}

try {
  await import(pathToFileURL(bundlePath).href)
  console.log('bundle loads OK')
} catch (error) {
  console.log('LOAD ERROR:', String(error?.message ?? error).split('\n')[0])
  process.exitCode = 1
}
