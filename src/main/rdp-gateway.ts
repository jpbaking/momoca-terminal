import { randomBytes } from 'node:crypto'
import { connect as tcpConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type PeerCertificate, type TLSSocket } from 'node:tls'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { RdpTicket, SavedSession } from '@shared/types'
import type { ExternalCredentials } from './external-tools'

/*
 * The local end of an in-tab RDP session.
 *
 * IronRDP runs in the renderer as WebAssembly and cannot open a TCP socket, so
 * it speaks RDCleanPath over a WebSocket: its first message asks for a server
 * and carries the X.224 connection request; the gateway connects, relays that
 * request, does the TLS handshake with the server itself, and answers with the
 * server's X.224 reply and certificate chain. From then on the gateway only
 * relays bytes: the client's plaintext goes into the TLS stream and back.
 *
 * The WebSocket listens on 127.0.0.1 only, and a connection gets nowhere
 * without a ticket: a single-use random token that main issues for one saved
 * host and port. The client's own `destination` is ignored, so the renderer
 * cannot use the gateway to reach anywhere else.
 */

const RDCLEANPATH_VERSION = 3390
const GENERAL_ERROR = 1
const NEGOTIATION_ERROR = 2

const TICKET_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 15_000
const MAX_REQUEST_BYTES = 64 * 1024
/** TPKT caps a PDU at 65535 bytes; a reply bigger than this is not X.224. */
const MAX_TPKT_BYTES = 65_535

/** Winsock error codes, which RDCleanPath uses to say why a connect failed. */
const WSA_CODES: Record<string, number> = {
  ECONNREFUSED: 10061,
  ETIMEDOUT: 10060,
  EHOSTUNREACH: 10065,
  ENETUNREACH: 10051,
  ECONNRESET: 10054,
  EHOSTDOWN: 10064,
  ENOTFOUND: 11001,
  EAI_AGAIN: 11002
}
const WSA_GENERIC = 10060

interface Ticket {
  host: string
  port: number
  expires: number
}

const tickets = new Map<string, Ticket>()

// --- DER: just enough for the RDCleanPath PDU ---------------------------------

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

function derInteger(value: number): Buffer {
  const bytes: number[] = []
  for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff)
  if (!bytes.length || bytes[0] & 0x80) bytes.unshift(0)
  return tlv(0x02, Buffer.from(bytes))
}

/** EXPLICIT context-specific tag [n] around an inner encoding. */
const field = (n: number, inner: Buffer): Buffer => tlv(0xa0 | n, inner)
const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items))
const octets = (value: Buffer): Buffer => tlv(0x04, value)
const utf8 = (value: string): Buffer => tlv(0x0c, Buffer.from(value, 'utf8'))

interface Tlv {
  tag: number
  content: Buffer
  /** Offset just past this element. */
  end: number
}

/** One element at `offset`, or null when `buffer` does not hold all of it yet. */
function readTlv(buffer: Buffer, offset: number): Tlv | null {
  if (buffer.length < offset + 2) return null
  const tag = buffer[offset]
  let length = buffer[offset + 1]
  let start = offset + 2
  if (length & 0x80) {
    const count = length & 0x7f
    if (count === 0 || count > 4) throw new Error('unsupported DER length')
    if (buffer.length < start + count) return null
    length = 0
    for (let i = 0; i < count; i++) length = length * 256 + buffer[start + i]
    start += count
  }
  if (buffer.length < start + length) return null
  return { tag, content: buffer.subarray(start, start + length), end: start + length }
}

function readInteger(content: Buffer): number {
  let value = 0
  for (const byte of content) value = value * 256 + byte
  return value
}

interface CleanPathRequest {
  version: number
  proxyAuth?: string
  x224?: Buffer
}

function parseRequest(pdu: Buffer): CleanPathRequest {
  const outer = readTlv(pdu, 0)
  if (!outer || outer.tag !== 0x30) throw new Error('not an RDCleanPath PDU')
  const request: CleanPathRequest = { version: 0 }
  for (let offset = 0; offset < outer.content.length; ) {
    const item = readTlv(outer.content, offset)
    if (!item) throw new Error('truncated RDCleanPath PDU')
    offset = item.end
    const inner = readTlv(item.content, 0)
    if (!inner) throw new Error('truncated RDCleanPath field')
    switch (item.tag) {
      case 0xa0:
        request.version = readInteger(inner.content)
        break
      case 0xa3:
        request.proxyAuth = inner.content.toString('utf8')
        break
      case 0xa6:
        request.x224 = Buffer.from(inner.content)
        break
      // destination [2] is ignored on purpose: the ticket decides the target.
    }
  }
  return request
}

function errorPdu(error: { wsa?: number; tlsAlert?: number; code?: number }, x224?: Buffer): Buffer {
  const detail = [field(0, derInteger(error.code ?? GENERAL_ERROR))]
  if (error.wsa !== undefined) detail.push(field(2, derInteger(error.wsa)))
  if (error.tlsAlert !== undefined) detail.push(field(3, derInteger(error.tlsAlert)))
  const items = [field(0, derInteger(RDCLEANPATH_VERSION)), field(1, sequence(...detail))]
  if (x224) items.push(field(6, octets(x224)))
  return sequence(...items)
}

function responsePdu(serverAddr: string, x224: Buffer, chain: Buffer[]): Buffer {
  return sequence(
    field(0, derInteger(RDCLEANPATH_VERSION)),
    field(6, octets(x224)),
    field(7, sequence(...chain.map(octets))),
    field(9, utf8(serverAddr))
  )
}

// --- connecting to the server -------------------------------------------------

function connectTcp(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }))
    }, CONNECT_TIMEOUT_MS)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Read one TPKT-framed PDU (the server's X.224 connection confirm). */
function readTpkt(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const done = (err: Error | null, pdu?: Buffer) => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (err) reject(err)
      else resolve(pdu!)
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return
      if (buffer[0] !== 3) return done(new Error('the server did not answer with TPKT'))
      const length = buffer.readUInt16BE(2)
      if (length < 4 || length > MAX_TPKT_BYTES) return done(new Error('bad TPKT length'))
      if (buffer.length >= length) done(null, buffer.subarray(0, length))
    }
    const onError = (err: Error) => done(err)
    const onClose = () => done(Object.assign(new Error('connection closed'), { code: 'ECONNRESET' }))
    const timer = setTimeout(
      () => done(Object.assign(new Error('no X.224 reply'), { code: 'ETIMEDOUT' })),
      CONNECT_TIMEOUT_MS
    )
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/**
 * True when the X.224 confirm agrees to TLS or CredSSP. A reply without
 * negotiation data, or with RDP_NEG_FAILURE, leaves only legacy RDP security,
 * which IronRDP does not speak.
 */
function negotiatedTls(confirm: Buffer): boolean {
  // TPKT (4) + X.224 CC (7) + RDP_NEG_RSP (8); selectedProtocol 0 is legacy RDP.
  return (
    confirm.length >= 19 &&
    confirm[5] === 0xd0 &&
    confirm[11] === 0x02 &&
    confirm.readUInt32LE(15) !== 0
  )
}

function startTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({
      socket,
      // RDP servers present self-signed certificates; the FreeRDP handoff
      // uses /cert:ignore for the same reason. IronRDP gets the chain anyway.
      rejectUnauthorized: false,
      // Older Windows servers stop at TLS 1.0.
      minVersion: 'TLSv1',
      servername: isIP(host) ? undefined : host
    })
    secure.once('secureConnect', () => {
      secure.off('error', reject)
      resolve(secure)
    })
    secure.once('error', reject)
  })
}

/** The server's certificate chain, leaf first, as DER. */
function certChain(secure: TLSSocket): Buffer[] {
  const chain: Buffer[] = []
  let cert: PeerCertificate | undefined = secure.getPeerCertificate(true)
  const seen = new Set<string>()
  while (cert?.raw && !seen.has(cert.fingerprint256)) {
    seen.add(cert.fingerprint256)
    chain.push(cert.raw)
    cert = (cert as PeerCertificate & { issuerCertificate?: PeerCertificate }).issuerCertificate
  }
  return chain
}

// --- the WebSocket side -------------------------------------------------------

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

function takeTicket(token: string | undefined): Ticket | null {
  const now = Date.now()
  for (const [key, ticket] of tickets) if (ticket.expires < now) tickets.delete(key)
  if (!token) return null
  const ticket = tickets.get(token)
  tickets.delete(token)
  return ticket ?? null
}

function serve(ws: WebSocket): void {
  let pending = Buffer.alloc(0)
  let server: Socket | null = null
  let secure: TLSSocket | null = null
  let relaying = false

  const close = () => {
    clearTimeout(requestTimer)
    secure?.destroy()
    server?.destroy()
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close()
  }
  const fail = (pdu: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(pdu, () => close())
    else close()
  }
  const requestTimer = setTimeout(() => fail(errorPdu({ wsa: WSA_GENERIC })), REQUEST_TIMEOUT_MS)

  ws.on('close', close)
  ws.on('error', close)

  const begin = async (request: CleanPathRequest) => {
    const ticket = takeTicket(request.proxyAuth)
    if (request.version !== RDCLEANPATH_VERSION || !ticket || !request.x224) {
      return fail(errorPdu({ code: GENERAL_ERROR }))
    }
    try {
      server = await connectTcp(ticket.host, ticket.port)
    } catch (err) {
      return fail(errorPdu({ wsa: WSA_CODES[(err as NodeJS.ErrnoException).code ?? ''] ?? WSA_GENERIC }))
    }
    if (ws.readyState !== ws.OPEN) return close()

    let confirm: Buffer
    try {
      server.write(request.x224)
      confirm = await readTpkt(server)
    } catch (err) {
      return fail(errorPdu({ wsa: WSA_CODES[(err as NodeJS.ErrnoException).code ?? ''] ?? WSA_GENERIC }))
    }
    if (!negotiatedTls(confirm)) return fail(errorPdu({ code: NEGOTIATION_ERROR }, confirm))

    try {
      secure = await startTls(server, ticket.host)
    } catch {
      // 40: handshake failure, the closest standard alert to "TLS did not work".
      return fail(errorPdu({ tlsAlert: 40 }))
    }
    if (ws.readyState !== ws.OPEN) return close()

    const address = server.remoteAddress ?? ticket.host
    ws.send(responsePdu(address, confirm, certChain(secure)))
    secure.on('data', (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk)
    })
    secure.on('close', close)
    secure.on('error', close)
    relaying = true
    if (pending.length) secure.write(pending)
    pending = Buffer.alloc(0)
  }

  let requested = false
  ws.on('message', (data) => {
    const chunk = toBuffer(data)
    if (relaying) {
      secure?.write(chunk)
      return
    }
    pending = Buffer.concat([pending, chunk])
    if (requested) return // bytes sent before the TLS handshake finished
    if (pending.length > MAX_REQUEST_BYTES) return fail(errorPdu({ code: GENERAL_ERROR }))
    let request: CleanPathRequest
    try {
      const whole = readTlv(pending, 0)
      if (!whole) return
      request = parseRequest(pending.subarray(0, whole.end))
      pending = pending.subarray(whole.end)
    } catch {
      return fail(errorPdu({ code: GENERAL_ERROR }))
    }
    requested = true
    clearTimeout(requestTimer)
    void begin(request)
  })
}

let listening: Promise<number> | null = null

/** Start the loopback WebSocket the first time it is needed; resolves to its port. */
function gatewayPort(): Promise<number> {
  listening ??= new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 16 * 1024 * 1024 })
    wss.once('listening', () => {
      const address = wss.address()
      resolve(address && typeof address === 'object' ? address.port : 0)
    })
    wss.once('error', (err) => {
      listening = null
      reject(err)
    })
    wss.on('connection', serve)
  })
  return listening
}

/**
 * Everything an IronRDP tab needs to connect one session, the password
 * included. This is the one place a stored secret reaches the renderer:
 * IronRDP runs CredSSP there and cannot connect without it. The session is
 * the store's copy (see `rdp:open`), so the password only goes with its own
 * host, and the ticket only opens the way to that host.
 */
export async function openRdpSession(
  session: SavedSession,
  credentials: ExternalCredentials
): Promise<RdpTicket> {
  const host = session.host?.trim()
  if (!host) throw new Error('This RDP session has no host')
  const port = session.port ?? 3389

  const label = session.username ? `${session.username}@${host}` : host
  const stored = session.id ? await credentials.lookupSecret(session.id) : null
  const password = stored ?? (await credentials.askPassword(label, `RDP password for ${label}:`))
  if (password === null) throw new Error('RDP connection cancelled — no password given')

  // DOMAIN\user goes to CredSSP as a separate domain; user@domain works as is.
  const [domain, username] = /^([^\\]+)\\(.+)$/.exec(session.username ?? '')?.slice(1) ?? [
    '',
    session.username ?? ''
  ]

  const proxyPort = await gatewayPort()
  const authToken = randomBytes(32).toString('base64url')
  tickets.set(authToken, { host, port, expires: Date.now() + TICKET_TTL_MS })

  return {
    proxyAddress: `ws://127.0.0.1:${proxyPort}`,
    authToken,
    destination: isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`,
    username,
    domain,
    password,
    options: session.rdp ?? {}
  }
}
