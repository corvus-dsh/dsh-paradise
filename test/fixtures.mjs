/**
 * dsh-paradise — SHARED FIXTURES for the durable-log reader.
 *
 * WHY THE FIXTURES ARE A MODULE AND NOT INLINE IN ONE TEST FILE
 *
 * The multi-frame trap is the whole reason this layer exists: a v4 log is an append-only file of
 * COMPRESSED FRAMES, and `zstdDecompressSync(wholeFile)` decodes exactly ONE. The header comes out,
 * every event does not, and the reading looks like proof that a write failed. That false "0 events"
 * reading cost an investigation cycle once; the fixture that produces it must be reachable from every
 * test that touches the reader, including the tests in the PLUGINS that consume this layer.
 *
 * `writeFramedSession` therefore builds a REAL multi-frame file with `zstdCompressSync`, one frame per
 * group — the same shape the host appends.
 */

import { writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'

/** A v4 session header — the first line of every log, and NOT an event (no `seq`). */
export const HEADER = {
  type: 'session',
  version: 4,
  id: 'session-x',
  createdAt: 1,
  cwd: 'D:/w',
  isSeeded: false,
  delegationDepth: 0,
}

/** A minimal closed tape: skeleton + a visible briefing, exactly the shape an incubation writes. */
export const TAPE = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
  {
    type: 'system/message',
    seq: 2,
    time: 3,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'head' }] },
    },
    surfaceOp: 'append',
  },
  {
    type: 'user/message',
    seq: 3,
    time: 4,
    data: { role: 'user', content: [{ type: 'text', text: 'THE PLAN' }], source: { kind: 'plugin:observer-briefing' } },
    surfaceOp: 'append',
  },
  { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
]

/**
 * Write a REAL multi-frame zstd session log.
 *
 * The header goes in the first chunk and each subsequent chunk holds `framesPerGroup` events, which
 * is how the host appends. With `framesPerGroup: 1` a six-event tape becomes seven frames — a
 * single-decompress reader sees the header and nothing else.
 *
 * @returns the number of bytes written
 */
export function writeFramedSession(path, header, events, framesPerGroup = 1) {
  const chunks = [JSON.stringify(header)]
  for (let index = 0; index < events.length; index += framesPerGroup) {
    const group = events.slice(index, index + framesPerGroup)
    chunks.push(group.map((event) => JSON.stringify(event)).join('\n'))
  }
  const bytes = Buffer.concat(chunks.map((chunk) => zstdCompressSync(Buffer.from(`${chunk}\n`, 'utf8'))))
  writeFileSync(path, bytes)
  return bytes.length
}

/** A plain (uncompressed) JSONL log — the other shape a fixture may take. */
export function writePlainSession(path, header, events) {
  const text = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join('\n') + '\n'
  writeFileSync(path, text, 'utf8')
  return Buffer.byteLength(text)
}

/** The tape with its briefing demoted to `developer/message` — the invisible shape. */
export function invisibleTape() {
  return TAPE.map((event) =>
    event.type === 'user/message'
      ? {
          ...event,
          type: 'developer/message',
          data: {
            turn: 1,
            step: 1,
            message: {
              role: 'developer',
              source: { kind: 'system-prompt' },
              content: [{ type: 'text', text: 'THE PLAN' }],
            },
          },
        }
      : event,
  )
}

/** A ctx-shaped pathProbe whose backend reports the file it wrote — the only real authority. */
export const probeTo = (path) => () => ({ path, source: 'sessionPersistence.pathOf()' })
