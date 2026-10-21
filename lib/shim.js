/**
 * Loopback OpenAI-compatible endpoint.
 *
 * The pi-ai provider points here; the shim applies the WorkBuddy wire quirks
 * (forced streaming, string `tool_choice`, the client's own identity) and
 * forwards to the real upstream. It binds 127.0.0.1 only and never serves
 * another interface.
 *
 * Inbound hardening: the loopback bind alone is not a trust boundary (any
 * local process or a DNS-rebinding page can reach 127.0.0.1), so every request
 * must carry a loopback Host header, browser-sent Origins must be loopback,
 * chat POSTs must be application/json, and the Authorization header must carry
 * the shim's per-process shared secret. The plugin's own client satisfies all
 * four by construction; a local attacker cannot read the secret out of the
 * plugin process's memory.
 *
 * The upstream only speaks streaming (`stream: true`; a non-streaming request
 * is refused with code 11101), so the shim always asks upstream for a stream
 * and *reassembles* one into plain JSON when the client asked for none.
 *
 * @module dsh-workbuddy-connect/shim
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { describeUpstreamFailure } from './upstream.js'

/** The shim's preferred fixed loopback port (env-overridable; ephemeral on collision). */
const SHIM_PORT = Number(process.env.DSH_WORKBUDDY_CONNECT_PORT ?? 39319)

/** Chat-completion bodies in a long session are large; 32 MiB mirrors Anthropic's guidance. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** HTTP status each upstream failure class surfaces as. */
export const KIND_STATUS = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
  const value = String(host ?? '').trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(0, end + 1)
  }
  const colon = value.lastIndexOf(':')
  return colon !== -1 && !value.slice(0, colon).includes(':') && /^\d+$/.test(value.slice(colon + 1)) ? value.slice(0, colon) : value
}

/**
 * The request's Host header must name the loopback interface.
 *
 * A DNS-rebinding page (attacker domain re-resolved to 127.0.0.1) sends its own
 * domain in Host, so this check drops those before any routing happens.
 */
function hostIsLoopback(host) {
  if (typeof host !== 'string' || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin (present header) must be loopback.
 *
 * Non-browser clients (the plugin's own fetch calls) send no Origin at all and
 * pass.
 */
function originIsLoopback(origin) {
  if (typeof origin !== 'string' || origin.trim() === '') return true
  return /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(origin)
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res, status, kind, message) {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/** Read a request body with a hard ceiling; over-limit bodies fail the request. */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      const error = new Error('request body too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Reassemble an SSE stream into the plain chat.completion JSON a client that
 * asked for no stream expects.
 *
 * The upstream only ever streams, so this is not a nicety: it is the only way
 * a non-streaming client can be served at all.
 */
async function collectCompletion(upstreamRes, signal) {
  const message = { role: 'assistant', content: '' }
  const out = {
    id: `chatcmpl-${randomBytes(12).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
  }
  const toolCalls = []
  let reader
  try {
    reader = upstreamRes.body.getReader()
  } catch {
    return out
  }
  const decoder = new TextDecoder()
  let buf = ''
  // Cancelling the reader resolves any in-flight read as done, so a stall
  // mid-stream is broken by the abort rather than blocking the pump.
  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      let chunk
      try {
        chunk = await reader.read()
      } catch {
        break
      }
      if (chunk.done) break
      buf += decoder.decode(chunk.value, { stream: true })
      let index
      while ((index = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, index + 2)
        buf = buf.slice(index + 2)
        let raw = ''
        for (const line of block.split('\n')) if (line.startsWith('data:')) raw = line.slice(5).trim()
        if (raw === '' || raw === '[DONE]') continue
        let data
        try {
          data = JSON.parse(raw)
        } catch {
          continue
        }
        if (typeof data?.model === 'string' && data.model !== '') out.model = data.model
        if (data?.usage !== undefined && data?.usage !== null) out.usage = data.usage
        for (const choice of Array.isArray(data?.choices) ? data.choices : []) {
          if (typeof choice?.delta?.content === 'string') message.content += choice.delta.content
          if (typeof choice?.delta?.reasoning_content === 'string') {
            message.reasoning_content = (message.reasoning_content ?? '') + choice.delta.reasoning_content
          }
          if (Array.isArray(choice?.delta?.tool_calls)) toolCalls.push(...choice.delta.tool_calls)
          if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') out.choices[0].finish_reason = choice.finish_reason
        }
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }
  if (toolCalls.length > 0) message.tool_calls = mergeToolCallDeltas(toolCalls)
  return out
}

/** Merge the per-delta tool-call fragments into whole calls. */
function mergeToolCallDeltas(deltas) {
  const merged = []
  for (const delta of deltas) {
    const index = Number.isInteger(delta?.index) ? delta.index : merged.length
    let slot = merged.find(entry => entry.index === index)
    if (slot === undefined) {
      slot = { id: delta?.id ?? `call_${index}`, type: 'function', index, function: { name: delta?.function?.name ?? '', arguments: '' } }
      merged.push(slot)
    }
    if (typeof delta?.function?.name === 'string' && delta.function.name !== '') slot.function.name = delta.function.name
    if (typeof delta?.function?.arguments === 'string') slot.function.arguments += delta.function.arguments
  }
  return merged
}

/** Pump an upstream SSE stream straight through to the client. */
async function relayStream(res, upstreamRes, signal) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  let reader
  try {
    reader = upstreamRes.body.getReader()
  } catch {
    res.end()
    return
  }
  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buf += decoder.decode(chunk.value, { stream: true })
      // Hand over everything up to the last complete event boundary so a split
      // block never gets rewritten wrongly.
      const cut = buf.lastIndexOf('\n\n')
      if (cut !== -1) {
        res.write(buf.slice(0, cut + 2))
        buf = buf.slice(cut + 2)
      }
    }
    if (buf !== '') res.write(buf)
  } catch (error) {
    options.logger?.warn?.('dsh-workbuddy-connect: upstream stream failed mid-flight', error)
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    if (res.writable && !res.writableEnded) res.end()
  }
}

/**
 * Start the loopback endpoint.
 *
 * @param {object} options
 * @param {object} options.store Credential store (resolves the real upstream token).
 * @param {object} options.client Upstream client (`chatStream`).
 * @param {object} options.catalog The live catalog (`current()`).
 * @param {object} [options.logger] Host logger.
 * @param {(body: string) => string} [options.prepareBody] Body preparation hook.
 * @param {(id: string) => string|undefined} [options.defaultEffortFor] Per-model default reasoning effort.
 * @param {() => void} [options.onSessionDead] Called when the upstream refuses the stored credential.
 * @param {() => void} [options.onSessionFresh] Called after a call the upstream accepted.
 * @param {string} [options.dumpBodyPath] Write the exact outbound body here (diagnostics; off by default).
 */
export function createWorkBuddyShim(options) {
  const { store, client, catalog } = options
  const logger = options.logger

  // Per-process shared secret. Lives only in memory; the adapter resolves it
  // as the OpenAI apiKey, which pi-ai sends as `Authorization: Bearer ...`.
  // The shim never forwards it upstream — the real credential comes from the
  // store. A local attacker who can hit the port still cannot forge this.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const a = Buffer.from(match[1])
    const b = Buffer.from(SHARED_SECRET)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  async function chatCompletions(req, res) {
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('application/json')) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      writeOpenAIError(res, error?.statusCode === 413 ? 413 : 400, 'invalid_request_error', String(error?.message ?? error))
      return
    }
    let credential
    try {
      credential = await store.resolve()
    } catch (error) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error?.message ?? error))
      return
    }
    // Resolve the model's own default reasoning level so the "Default" level
    // (which pi-ai spells `off`) goes on the wire as that declared value, and
    // so a model that refuses `off` is never asked for it.
    let defaultEffort
    let modelId
    try {
      const parsed = JSON.parse(raw)
      modelId = typeof parsed?.model === 'string' ? parsed.model : undefined
      if (modelId !== undefined) defaultEffort = options.defaultEffortFor?.(modelId)
    } catch {
      // Malformed body: the preparation hook reports it as-is.
    }
    const prepared = options.prepareBody
      ? options.prepareBody(raw, {
        ...defaultEffort === undefined ? {} : { defaultEffort },
        ...modelId === undefined ? {} : { modelId },
      })
      : raw

    // Opt-in transcript of the exact body that leaves this process, for
    // diagnosing a gateway refusal that depends on the request content. Off
    // unless the operator names a path, and the file is created 0600: a body
    // carries the whole conversation.
    if (options.dumpBodyPath !== undefined) {
      try {
        writeFileSync(options.dumpBodyPath, prepared, { mode: 0o600 })
      } catch {
        // A diagnostic write must never take down the request it describes.
      }
    }

    const controller = new AbortController()
    const onClientClose = () => controller.abort()
    res.on('close', onClientClose)
    try {
      const result = await client.chatStream(credential, prepared, controller.signal)
      if (!result.ok) {
        // The upstream's own `extError` names the offending field and its
        // value; without it a refusal reads as "model unavailable" and the fix
        // lives nowhere in the message.
        const detail = describeUpstreamFailure(result.message)
        // A dead session is the one failure the card can act on: the stored
        // credential was rotated away (the desktop app re-signs in behind the
        // plugin's back), so the card has to say so instead of keeping a
        // "signed in" badge over a token nobody can use.
        if (result.kind === 'session_dead') options.onSessionDead?.()
        writeOpenAIError(
          res,
          KIND_STATUS[result.kind] ?? 502,
          result.kind,
          `workbuddy upstream ${result.kind} (http ${result.status})${detail === '' ? '' : `; ${detail}`}: ${String(result.message).slice(0, 400)}`,
        )
        return
      }
      options.onSessionFresh?.()
      const wantsStream = (() => {
        try {
          return JSON.parse(raw)?.stream === true
        } catch {
          return false
        }
      })()
      if (wantsStream) {
        await relayStream(res, result.response, controller.signal)
        return
      }
      const content = await collectCompletion(result.response, controller.signal)
      writeJson(res, 200, content)
    } finally {
      res.removeListener('close', onClientClose)
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'
    if (!hostIsLoopback(req.headers.host)) {
      writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
      return
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
      return
    }
    if (!bearerOk(req)) {
      writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
      return
    }
    if (req.method === 'GET' && (url === '/healthz' || url === '/v1/models' || url === '/models')) {
      if (url !== '/healthz') {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'workbuddy',
          })),
        })
        return
      }
      writeJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
      chatCompletions(req, res).catch(error => {
        logger?.warn?.('dsh-workbuddy-connect: loopback request failed', error)
        try {
          if (!res.headersSent) writeOpenAIError(res, 500, 'internal', String(error))
          else res.end()
        } catch {
          // The response is already gone; nothing left to say.
        }
      })
      return
    }
    writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
  })
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  // The shim must never hold a finished CLI run open: an unref'd listener lets
  // the process exit while the server is up.
  server.unref()

  // A fixed loopback port keeps baseUrl() usable synchronously: the adapter's
  // model descriptors embed the shim origin at construction, and the headless
  // host starts its first turn before an awaited setup continuation resolves.
  // A collision falls back to an ephemeral port and the caller refreshes its
  // descriptors when `ready` lands. The promise never rejects: an unawaited
  // rejection would tear down the host process.
  const ready = new Promise((resolve) => {
    server.once('listening', () => resolve(true))
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        logger?.warn?.(`dsh-workbuddy-connect: port ${SHIM_PORT} is busy, falling back to an ephemeral loopback port`)
        server.once('error', (retryError) => {
          logger?.error?.('dsh-workbuddy-connect: loopback endpoint failed to start', retryError)
          resolve(false)
        })
        server.listen(0, '127.0.0.1')
        return
      }
      logger?.error?.('dsh-workbuddy-connect: loopback endpoint failed to start', error)
      resolve(false)
    })
  })
  server.listen(SHIM_PORT, '127.0.0.1')

  return {
    ready,
    baseUrl: () => `http://127.0.0.1:${server.address()?.port ?? SHIM_PORT}`,
    token: () => SHARED_SECRET,
    close: () => new Promise((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}

export { createHash }
