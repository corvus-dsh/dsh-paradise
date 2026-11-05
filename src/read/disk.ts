/**
 * READ / DISK — decode a durable session log, frame by frame.
 *
 * WHAT THIS LAYER IS, IN HOST-NEUTRAL TERMS
 *
 * Given the BYTES of a durable conversation log, produce the events inside it and say what happened.
 * That is all. It does not know where the bytes came from, how the path was built, or what a
 * particular runtime calls its event kinds — a caller supplies the path (or a way to derive it) and
 * this module supplies the reading.
 *
 * WHY THE FRAME WALK IS THE REASON TO EXIST
 *
 * A durable log of this generation is an append-only file of COMPRESSED FRAMES. A whole-file
 * decompress decodes exactly ONE frame: the header comes out, every event does not, and the reading
 * looks like proof that a write failed. That false "0 events" reading cost a whole investigation
 * cycle once. The walk is not a helper — it is the layer.
 *
 * WHERE THE HOST-SPECIFIC PARTS WENT
 *
 * The directory escaping and the on-disk layout moved to `adapters/<host>/paths.ts`. This module
 * accepts `sessionLogPath` as an OPTION rather than importing one, so adding a second host does not
 * touch this file. That is the whole decoupling claim, in one import list.
 *
 * NEVER THROWS. Every failure — no path, no file, an unreadable frame, a torn tail — comes back as
 * `readable: false` plus a stated reason. Losing a diagnostic must never cost the caller the session
 * it just created, and "could not read" must never be dressed up as "is not there".
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/**
 * RENDERABILITY IS A HOST FACT, SO THE HOST SUPPLIES IT.
 *
 * This module used to import `isRenderedByConversation` from `../policy.js`. That was the last
 * remaining leak in the read layer: deciding "will the transcript show this?" requires knowing one
 * runtime's projection rules. Now an adapter registers its own answer through
 * `configureReadDefaults`, and a host that renders nothing (or everything) says so itself.
 *
 * The fallback below is deliberately CONSERVATIVE — it assumes nothing is rendered. A diagnostic that
 * under-claims ("the host may not show this") is recoverable; one that over-claims ("this is visible")
 * is the exact bug that cost a release.
 */
let rendersByDefault: (type: unknown) => boolean = () => false

/** Wire a host's rendering answer in. Called by an adapter, never by a plugin. */
export function configureReadDefaults(config: { isRendered?: (type: unknown) => boolean }): void {
  if (typeof config.isRendered === 'function') rendersByDefault = config.isRendered
}

/** A zstd frame starts with this 4-byte magic number (RFC 8878 §3.1.1). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** The first human-readable message found on disk, if any. */
export interface DiskBriefing {
  seq: number
  type: string
  role: string
  sourceKind: string
  surfaceOp: string | undefined
  textLength: number
  textHead: string
  carriesTurnStep: boolean
}

/** What a durable-log reading can conclude. Every field is evidence; none is a claim. */
export interface DiskReading {
  /** A file was found AND at least one frame decoded. */
  readable: boolean
  /** Where the file was looked for / found (empty when nothing could be derived). */
  path: string
  /** How the path was obtained, so a wrong path is diagnosable rather than mysterious. */
  pathSource: string
  bytes: number
  /** How many zstd frames the file holds — the number that makes "0 events" honest or false. */
  frameCount: number
  framesDecoded: number
  /** The decoded events, in log order. */
  events: any[]
  /** Every event type in log order. */
  eventTypes: string[]
  eventCount: number
  /** The first message-shaped event on disk (null when there is none). */
  briefing: DiskBriefing | null
  /** True when `briefing.type` is one the conversation projection renders. */
  renderedByConversation: boolean
  /** Human-readable notes; every failure is stated here instead of thrown. */
  notes: string[]
}

/** How the caller lets this layer ask the HOST for a path it may already expose. */
export type PathProbe = (sessionId: string) => { path?: string; source?: string; notes?: string[] } | undefined

/**
 * How a caller supplies a path when the host does not name one.
 *
 * THE SEAM THAT REPLACES A HOST IMPORT: an adapter registers its own derivation here, so this module
 * never learns a directory layout.
 */
export type PathDeriver = (input: { sessionId: string; cwd: string }) => { path: string; source: string; notes: string[] }

export interface DiskReadOptions {
  /**
   * Ask the host where the file is. This is the ONLY authority: when a backend can name the file it
   * wrote, a derivation must never override it.
   */
  pathProbe?: PathProbe
  /** Fallback when the host names no path. Supplied by an adapter, never imported from one. */
  derivePath?: PathDeriver
}

function asDiskObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decode EVERY frame. `zstdDecompressSync` on the whole file decodes only the first. */
function decodeAllFrames(
  bytes: Buffer,
  decompress: (slice: Buffer) => Buffer,
): { text: string; frames: number; decoded: number; notes: string[] } {
  const notes: string[] = []
  const slices: Buffer[] = []
  let start = -1
  let frames = 0
  for (let index = 0; index + 4 <= bytes.length; index += 1) {
    if (
      bytes[index] === ZSTD_MAGIC[0] &&
      bytes[index + 1] === ZSTD_MAGIC[1] &&
      bytes[index + 2] === ZSTD_MAGIC[2] &&
      bytes[index + 3] === ZSTD_MAGIC[3]
    ) {
      frames += 1
      if (start >= 0) slices.push(bytes.subarray(start, index))
      start = index
    }
  }
  if (start >= 0) slices.push(bytes.subarray(start))

  if (frames === 0) {
    // Not a framed file: maybe a single frame the scan missed, or plain JSONL.
    try {
      return { text: decompress(bytes).toString('utf8'), frames: 1, decoded: 1, notes }
    } catch {
      const text = bytes.toString('utf8')
      if (text.trimStart().startsWith('{')) {
        notes.push('文件不是 zstd 帧，按明文 JSONL 读取')
        return { text, frames: 0, decoded: 0, notes }
      }
      notes.push('文件既不是可解的 zstd，也不是明文 JSONL')
      return { text: '', frames: 0, decoded: 0, notes }
    }
  }

  let text = ''
  let decoded = 0
  let index = 0
  for (const slice of slices) {
    try {
      text += decompress(slice).toString('utf8')
      decoded += 1
    } catch (error) {
      // A torn tail frame is NORMAL for a log being appended to right now.
      notes.push(`第 ${index} 帧解压失败（可能是正在追加的尾帧）：${String((error as any)?.message ?? error)}`)
    }
    index += 1
  }
  return { text, frames, decoded, notes }
}

/** The first message-shaped event, reported with the facts that decide visibility. */
function briefingOf(events: any[]): {
  briefing: DiskBriefing | null
  renderedByConversation: boolean
  notes: string[]
} {
  const notes: string[] = []
  const found = events.find(
    (event) => event?.type === 'user/message' || event?.type === 'developer/message',
  )
  if (found === undefined) {
    notes.push('磁盘日志里没有任何 user/message 或 developer/message —— 这才是"方案没写进去"的形状。')
    return { briefing: null, renderedByConversation: false, notes }
  }
  const payload = found.data?.message ?? found.data
  const text = String(payload?.content?.[0]?.text ?? '')
  const briefing: DiskBriefing = {
    seq: Number(found.seq),
    type: String(found.type),
    role: String(payload?.role ?? ''),
    sourceKind: String(payload?.source?.kind ?? ''),
    surfaceOp: found.surfaceOp,
    textLength: text.length,
    textHead: text.slice(0, 120),
    carriesTurnStep: found.data?.turn !== undefined || found.data?.step !== undefined,
  }
  const renderedByConversation = rendersByDefault(briefing.type)
  if (!renderedByConversation) {
    notes.push(
      `磁盘上是 ${briefing.type}（seq=${briefing.seq}，${briefing.textLength} 字符），` +
        '但会话投影只渲染 user/message 与 assistant/message —— 这就是"看不见注入消息"的原因：写成功，不渲染。',
    )
  }
  return { briefing, renderedByConversation, notes }
}

/**
 * Read one session's durable log and report what is actually in it.
 *
 * `sessionId` plus `cwd` is enough when the host exposes no path getter AND a `derivePath` is
 * supplied by its adapter. Pass `pathProbe` when the host can name the file, because a named path
 * always outranks a derived one.
 *
 * Never throws.
 */
export function readDiskEvents(
  sessionId: string,
  cwd?: string,
  options: DiskReadOptions = {},
): DiskReading {
  const reading: DiskReading = {
    readable: false,
    path: '',
    pathSource: 'unavailable',
    bytes: 0,
    frameCount: 0,
    framesDecoded: 0,
    events: [],
    eventTypes: [],
    eventCount: 0,
    briefing: null,
    renderedByConversation: false,
    notes: [],
  }

  /* 1. where is the file? host authority first, derivation second, "unknown" third. */
  if (typeof options.pathProbe === 'function') {
    try {
      const probed = options.pathProbe(sessionId)
      if (asDiskObject(probed)) {
        if (Array.isArray(probed.notes)) reading.notes.push(...probed.notes.map(String))
        const path = typeof probed.path === 'string' ? probed.path.trim() : ''
        if (path.length > 0) {
          reading.path = path
          reading.pathSource = typeof probed.source === 'string' ? probed.source : 'host'
        }
      }
    } catch (error) {
      reading.notes.push(`pathProbe 抛错：${String((error as any)?.message ?? error)}`)
    }
  }
  if (reading.path.length === 0 && typeof options.derivePath === 'function' && typeof cwd === 'string' && cwd.trim().length > 0) {
    try {
      const derived = options.derivePath({ sessionId, cwd: cwd.trim() })
      reading.path = derived.path
      reading.pathSource = derived.source
      reading.notes.push(...derived.notes)
    } catch (error) {
      reading.notes.push(`derivePath 抛错：${String((error as any)?.message ?? error)}`)
    }
  }
  if (reading.path.length === 0) {
    reading.notes.push(
      '无法定位会话日志（宿主没有暴露路径，也没有提供可用的路径推导）。' +
        '这不影响写入结论：冷读校验已经确认事件存在；这里只是无法从磁盘再核对一次。',
    )
    return reading
  }

  /* 2. read the bytes. */
  let bytes: Buffer
  try {
    bytes = readFileSync(reading.path)
  } catch (error) {
    reading.notes.push(`读文件失败：${String((error as any)?.message ?? error)}`)
    return reading
  }
  reading.bytes = bytes.length

  /* 3. decode EVERY frame, then parse every line after the header. */
  const decoded = decodeAllFrames(bytes, zstdDecompressSync)
  reading.frameCount = decoded.frames
  reading.framesDecoded = decoded.decoded
  reading.notes.push(...decoded.notes)
  if (decoded.text.length === 0) return reading

  const lines = decoded.text.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) {
    reading.notes.push('文件解码成功但没有任何行')
    return reading
  }
  const events: any[] = []
  let skipped = 0
  // Line 0 is the session header, not an event: it carries `type: 'session'` and no `seq`.
  for (const line of lines.slice(1)) {
    try {
      events.push(JSON.parse(line))
    } catch {
      skipped += 1
    }
  }
  if (skipped > 0) reading.notes.push(`有 ${skipped} 行不是合法 JSON，已跳过`)
  reading.events = events
  reading.eventTypes = events.map((event) => String(event?.type))
  reading.eventCount = events.length
  reading.readable = true

  /* 4. what the transcript will show, and what the file actually holds. */
  const found = briefingOf(events)
  reading.briefing = found.briefing
  reading.renderedByConversation = found.renderedByConversation
  reading.notes.push(...found.notes)
  return reading
}

/** Just the ordered event types — the one-liner a receipt prints. */
export function readDiskEventTypes(sessionId: string, cwd?: string, options: DiskReadOptions = {}): string[] {
  return readDiskEvents(sessionId, cwd, options).eventTypes
}
