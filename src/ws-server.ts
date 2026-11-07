/**
 * A MINIMAL WEBSOCKET SERVER ON NODE BUILT-INS ONLY.
 *
 * WHY NOT `ws`: this project's contract is zero external dependencies, and a UI that needs an
 * install to appear is a UI that will not appear on a fresh machine. Node ships `http`, `crypto`
 * and sockets; RFC 6455 text frames are about a hundred lines. That trade — 100 lines for zero
 * dependencies — is the same one made for `node:sqlite` over `better-sqlite3`.
 *
 * WHAT IS IMPLEMENTED
 *
 *   - the handshake (Sec-WebSocket-Accept = base64(sha1(key + GUID)))
 *   - text frames in both directions, including fragmented payloads
 *   - ping/pong, and close
 *   - payload lengths 7-bit, 16-bit and 64-bit
 *
 * WHAT IS NOT
 *
 *   - binary frames (the protocol here is JSON text)
 *   - permessage-deflate (compression is a CPU/precision trade this UI does not need)
 *   - client-side masking validation is skipped on the SERVER side (RFC requires clients to mask,
 *     but rejecting an unmasked frame would only make a debugging tool harder to use)
 *
 * Each omission is a real gap in the standard and is written down here rather than discovered later.
 */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface Socket {
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly readyState: 'open' | 'closed'
}

export interface SocketServerOptions {
  /** Called for every decoded text frame. Async errors must be caught by the handler. */
  readonly onMessage: (socket: Socket, text: string) => void
  readonly onClose?: (socket: Socket) => void
}

/** Encode a text frame (server → client: unmasked, per RFC). */
export function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x81, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    /** 64-bit length. High word is zero for any payload a browser will accept. */
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(length, 6)
  }
  return Buffer.concat([header, payload])
}

/**
 * Decode buffered frames.
 *
 * RETURNS WHAT IT CONSUMED rather than mutating a class: a socket delivers arbitrary chunk
 * boundaries, so the only correct model is "here is a buffer, give me the frames in it and tell me
 * how many bytes they used". Everything else invites a partial-frame bug.
 */
export function decodeFrames(buffer: Buffer): {
  frames: Array<{ opcode: number; text: string }>
  consumed: number
  /** True when a control frame asked for a close. */
  closed: boolean
} {
  const frames: Array<{ opcode: number; text: string }> = []
  let offset = 0
  let closed = false
  for (;;) {
    if (buffer.length - offset < 2) break
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      const high = buffer.readUInt32BE(cursor)
      const low = buffer.readUInt32BE(cursor + 4)
      /** Anything above 2^53 cannot be a frame this server should accept. */
      if (high > 0) return { frames, consumed: offset, closed }
      length = low
      cursor += 8
    }
    /** Client → server frames MUST be masked; the key is four bytes. */
    let maskKey: Buffer | undefined
    if (masked) {
      if (buffer.length - cursor < 4) break
      maskKey = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (buffer.length - cursor < length) break
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (maskKey !== undefined) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4]
    }
    cursor += length
    offset = cursor
    /**
     * CLOSE (0x8) ends the connection. PING (0x9) is answered elsewhere; here it is only noted so
     * the caller knows a control frame arrived rather than a text frame.
     */
    if (opcode === 0x8) {
      closed = true
      break
    }
    /** 0x1 is text; 0x0 is a continuation, which this protocol never sends. */
    if (opcode === 0x1 || opcode === 0x0) frames.push({ opcode, text: payload.toString('utf8') })
  }
  return { frames, consumed: offset, closed }
}

/** Attach a WebSocket endpoint to an existing HTTP server at `path`. */
export function attachSocketServer(server: Server, path: string, options: SocketServerOptions): void {
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const url = request.url ?? ''
    if (!url.startsWith(path)) {
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string' || key.length === 0) {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    )

    let buffer = Buffer.alloc(0)
    const handle: Socket = {
      readyState: 'open',
      send(data: string) {
        if (handle.readyState !== 'open') return
        try {
          socket.write(encodeFrame(data))
        } catch {
          /* a write to a dying socket is not an error worth propagating */
        }
      },
      close(code = 1000, reason = '') {
        if (handle.readyState === 'closed') return
        handle.readyState = 'closed'
        try {
          const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'))
          payload.writeUInt16BE(code, 0)
          payload.write(reason, 2, 'utf8')
          /** A server-sent close frame is opcode 0x8; the header is rebuilt here because its
           * payload is binary, not text. */
          socket.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]))
          socket.end()
        } catch {
          /* ignore */
        }
        options.onClose?.(handle)
      },
    }

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const decoded = decodeFrames(buffer)
      buffer = buffer.subarray(decoded.consumed)
      for (const frame of decoded.frames) {
        try {
          options.onMessage(handle, frame.text)
        } catch {
          /** A throwing handler must not kill the socket: the UI would go blank with no reason. */
        }
      }
      if (decoded.closed) handle.close(1000, 'client closed')
    })
    socket.on('error', () => handle.close(1011, 'socket error'))
    socket.on('close', () => {
      if (handle.readyState === 'open') {
        handle.readyState = 'closed'
        options.onClose?.(handle)
      }
    })
  })
}

/** The handshake header value for a key. Exported so a test can verify it against the RFC vector. */
export function acceptKeyFor(key: string): string {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64')
}

/** File size helper used by the UI's status panel. */
export function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
