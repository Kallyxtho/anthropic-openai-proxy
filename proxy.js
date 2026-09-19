import Fastify from 'fastify'

// === PROVIDER CONFIGURAZIONE DA ENV ===
const TARGET = process.env.PROVIDER_BASE_URL || 'https://api.openai.com/v1'
const API_KEY = process.env.API_KEY || ''
const MODEL = process.env.MODEL || 'gpt-4o-mini'

// === PROVIDER PRECEDENTE (opencode zen) — commentato, per rollback togli i commenti qui sotto e commenta le righe sopra
// const TARGET = 'https://opencode.ai/zen/v1/chat/completions'
// const API_KEY = 'sk-cxPlhmZL4T0QKDJWZSGqYfji1YlNrspiEggOvzrSdwGPL3SFc2387coqm2RwPh4N'
// const MODEL = 'x-preview-f-free'

const fastify = Fastify({ logger: false })
const PORT = process.env.PORT || 8080

function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use'
    case 'stop': return 'end_turn'
    case 'length': return 'max_tokens'
    default: return 'end_turn'
  }
}

fastify.addHook('onRequest', async (req) => {
  req._t0 = Date.now()
})

const healthHandler = async () => ({ status: 'ok' })
fastify.get('/api/hello', healthHandler)

fastify.addHook('onResponse', async (req, reply) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${reply.statusCode} (${Date.now() - (req._t0 || 0)}ms)`)
})

fastify.post('/v1/messages', async (request, reply) => {
  try {
    const payload = request.body
    console.log(`[messages] stream=${payload.stream} msgs=${payload.messages?.length} tools=${payload.tools?.length} max_tokens=${payload.max_tokens} model=${payload.model}`)

    // risposta LOCALE per la generazione titolo (richieste piccole senza tool):
    // evita che occupino la corsia del provider bloccando il lavoro vero
    if (!(payload.tools || []).length && (payload.messages?.length || 0) <= 3 && (payload.max_tokens || 0) <= 2500 && payload.stream !== true) {
      const lastUser = [...(payload.messages || [])].reverse().find(m => m.role === 'user')
      const raw = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '')
      const title = raw.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Conversazione'
      return {
        content: [{ type: 'text', text: title }],
        id: 'msg_local_title_' + Date.now(),
        model: 'local-title-gen',
        role: 'assistant',
        stop_reason: 'end_turn',
        stop_sequence: null,
        type: 'message',
        usage: { input_tokens: 1, output_tokens: 5 },
      }
    }
    if (payload.messages?.length > 20) {
      const hist = {}
      payload.messages.forEach(m => { hist[m.role] = (hist[m.role] || 0) + 1 })
      const samples = payload.messages.slice(0, 6).map(m => {
        const prev = typeof m.content === 'string' ? m.content.slice(0, 80) : JSON.stringify(m.content)?.slice(0, 120)
        return `${m.role}: ${prev}`
      })
      console.log(`[diag] ruoli=${JSON.stringify(hist)}`)
      console.log(`[diag] primi messaggi:\n  ${samples.join('\n  ')}`)
    }

    const flattenContent = (c) => {
      if (typeof c === 'string') return c
      if (Array.isArray(c)) {
        return c.map(b => {
          if (b == null) return ''
          if (typeof b === 'string') return b
          if (typeof b.text === 'string') return b.text
          if (typeof b.content === 'string') return b.content
          return ''
        }).filter(Boolean).join('\n')
      }
      return c == null ? '' : String(c)
    }

    const normalizeContent = (content) => {
      if (typeof content === 'string') return content || null
      if (Array.isArray(content)) {
        const text = content
          .filter(item => item && item.type === 'text')
          .map(item => item.text)
          .filter(Boolean)
          .join('\n')
        return text || null
      }
      return null
    }

    const messages = []
    if (payload.system && Array.isArray(payload.system)) {
      payload.system.forEach(sysMsg => {
        const normalized = normalizeContent(sysMsg.text || sysMsg.content)
        if (normalized) {
          messages.push({ role: 'system', content: normalized })
        }
      })
    }
    if (payload.messages && Array.isArray(payload.messages)) {
      payload.messages.forEach(msg => {
        const toolCalls = (Array.isArray(msg.content) ? msg.content : [])
          .filter(item => item.type === 'tool_use')
          .map(toolCall => ({
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.input ?? {}),
            },
          }))
        const newMsg = { role: msg.role }
        const normalized = normalizeContent(msg.content)
        if (normalized) newMsg.content = normalized
        if (toolCalls.length > 0) newMsg.tool_calls = toolCalls
        if (newMsg.content || newMsg.tool_calls) messages.push(newMsg)

        if (Array.isArray(msg.content)) {
          const toolResults = msg.content.filter(item => item.type === 'tool_result')
          toolResults.forEach(toolResult => {
            messages.push({
              role: 'tool',
              content: flattenContent(toolResult.content ?? toolResult.text),
              tool_call_id: toolResult.tool_use_id,
            })
          })
        }
      })
    }

    const tools = (payload.tools || [])
      .filter(tool => tool && tool.name && !['BatchTool'].includes(tool.name) && tool.input_schema)
      .map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.input_schema || { type: 'object', properties: {} },
        },
      }))

    const openaiPayload = {
      model: payload.model || MODEL,
      messages,
      max_tokens: payload.max_tokens,
      temperature: payload.temperature !== undefined ? payload.temperature : 1,
      stream: payload.stream === true,
    }
    if (tools.length > 0) openaiPayload.tools = tools

    let openaiResponse = null
    const RETRYABLE = new Set([429, 500, 502, 503, 504])
    const UPSTREAM_TIMEOUT_MS = 60000
    const MAX_ATTEMPTS = 3
    let lastErrorText = ''
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const ctrl = new AbortController()
      const hdrTimer = setTimeout(() => ctrl.abort(new Error('headers timeout')), UPSTREAM_TIMEOUT_MS)
      try {
        openaiResponse = await fetch(TARGET, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          body: JSON.stringify(openaiPayload),
          signal: ctrl.signal,
        })
        clearTimeout(hdrTimer)
        console.log(`[main call] attempt ${attempt + 1} -> headers ${openaiResponse.status}`)
      } catch (fetchErr) {
        clearTimeout(hdrTimer)
        lastErrorText = fetchErr.message
        console.log(`[fetch error] attempt ${attempt + 1}: ${fetchErr.message}`)
        try {
          const fs = await import('node:fs')
          const dumpDir = process.env.DUMP_DIR || './dumps'
          await fs.promises.mkdir(dumpDir, { recursive: true })
          fs.writeFileSync(`${dumpDir}/stalled-request-${Date.now()}.json`, JSON.stringify(openaiPayload))
          console.log('[dump] richiesta salvata per analisi stallo')
        } catch (_) {}
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
      }
      if (!openaiResponse) continue
      if (openaiResponse.ok || !RETRYABLE.has(openaiResponse.status)) {
        if (!openaiResponse.ok) console.log(`[upstream ${openaiResponse.status}] non-retryable`)
        break
      }
      lastErrorText = await openaiResponse.text().catch(() => '')
      console.log(`[upstream ${openaiResponse.status}] attempt ${attempt + 1}: ${String(lastErrorText).slice(0, 300)}`)
      if (attempt < MAX_ATTEMPTS - 1) await new Promise(r => setTimeout(r, 1000))
    }

    if (!openaiResponse || !openaiResponse.ok) {
      try {
        const fs = await import('node:fs')
        const dumpDir = process.env.DUMP_DIR || './dumps'
      const dumpFile = `${dumpDir}/failed-request-${Date.now()}.json`
        fs.writeFileSync(dumpFile, JSON.stringify({ model: MODEL, ...openaiPayload }, null, 1))
        console.log(`[dump] richiesta fallita salvata in ${dumpFile}`)
      } catch (_) {}
      reply.code(openaiResponse ? openaiResponse.status : 502)
      return {
        type: 'error',
        error: { type: 'overloaded_error', message: `Provider error after ${MAX_ATTEMPTS} attempts: ${String(lastErrorText).slice(0, 2000)}` },
      }
    }

    if (!openaiPayload.stream) {
      const data = await Promise.race([
        openaiResponse.json(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('provider body timeout')), 240000)),
      ])
      if (data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error)))

      const choice = data.choices[0]
      const openaiMessage = choice.message
      const stopReason = mapStopReason(choice.finish_reason)
      const toolCalls = openaiMessage.tool_calls || []

      const messageId = data.id
        ? data.id.replace('chatcmpl', 'msg')
        : 'msg_' + Math.random().toString(36).substr(2, 24)

      const anthropicResponse = {
        content: [
          { text: openaiMessage.content || '', type: 'text' },
          ...toolCalls.map(toolCall => {
            let input = {}
            try {
              input = JSON.parse(toolCall.function.arguments || '{}')
            } catch (_) {
              try {
                input = JSON.parse(String(toolCall.function.arguments || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1').trim())
              } catch (_2) {
                input = { _raw: String(toolCall.function.arguments || '') }
              }
            }
            return {
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.function.name,
              input,
            }
          }),
        ],
        id: messageId,
        model: openaiPayload.model,
        role: openaiMessage.role,
        stop_reason: stopReason,
        stop_sequence: null,
        type: 'message',
        usage: {
          input_tokens: data.usage?.prompt_tokens || messages.reduce((acc, msg) => acc + (msg.content?.split(' ').length || 0), 0),
          output_tokens: data.usage?.completion_tokens || (openaiMessage.content?.split(' ').length || 0),
        },
      }
      return anthropicResponse
    }

    // Streaming
    let isSucceeded = false
    const sendSSE = (reply, event, data) => {
      const sseMessage = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`
      reply.raw.write(sseMessage)
      if (typeof reply.raw.flush === 'function') reply.raw.flush()
    }

    const sendSuccessMessage = () => {
      if (isSucceeded) return
      isSucceeded = true
      try { reply.hijack() } catch (_) {}
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const messageId = 'msg_' + Math.random().toString(36).substr(2, 24)
      sendSSE(reply, 'message_start', {
        type: 'message_start',
        message: {
          id: messageId, type: 'message', role: 'assistant',
          model: openaiPayload.model, content: [], stop_reason: null,
          stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
      sendSSE(reply, 'ping', { type: 'ping' })
    }

    let accumulatedContent = ''
    let encounteredToolCall = false
    const toolCallsBuffer = {}
    let nextBlockIndex = 1
    let usage = null
    let textBlockStarted = false
    const decoder = new TextDecoder('utf-8')
    const reader = openaiResponse.body.getReader()
    let done = false
    let lineBuffer = ''
    let streamClosed = false
    // watchdog di INATTIVITA': solo se il provider tace a lungo si abbandona
    const IDLE_MS = 90000
    let idleFired = false
    let idleTimer = setTimeout(() => { idleFired = true; try { reader.cancel() } catch (_) {} }, IDLE_MS)
    const bumpIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { idleFired = true; try { reader.cancel() } catch (_) {} }, IDLE_MS)
    }

    const finishStream = () => {
      if (streamClosed) return
      streamClosed = true
      if (textBlockStarted) {
        sendSSE(reply, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      }
      let blockIndex = nextBlockIndex
      for (const key of Object.keys(toolCallsBuffer).sort((a, b) => a - b)) {
        const tc = toolCallsBuffer[key]
        let input = {}
        try {
          input = JSON.parse(tc.args || '{}')
        } catch (_) {
          console.log(`[tool args] JSON invalido per ${tc.name}, ripulito: ${String(tc.args).slice(0, 200)}`)
          try {
            const fixed = tc.args
              .replace(/[\u0000-\u001f]+/g, ' ')
              .replace(/,\s*([}\]])/g, '$1')
              .trim()
            input = JSON.parse(fixed)
          } catch (_2) {
            input = { _raw: String(tc.args || '') }
          }
        }
        const serialized = JSON.stringify(input)
        if (!tc.started) {
          tc.started = true
          tc.blockIdx = blockIndex++
          sendSSE(reply, 'content_block_start', {
            type: 'content_block_start',
            index: tc.blockIdx,
            content_block: { type: 'tool_use', id: tc.id || `call_${Date.now()}_${key}`, name: tc.name || 'unknown', input: {} },
          })
        }
        if (!serialized.startsWith(tc.sent)) {
          console.log(`[tool stream] finale divergente su ${tc.name}, chiudo il blocco così com'è`)
        } else {
          const rest = serialized.slice(tc.sent.length)
          if (rest) {
            sendSSE(reply, 'content_block_delta', {
              type: 'content_block_delta',
              index: tc.blockIdx,
              delta: { type: 'input_json_delta', partial_json: rest },
            })
            tc.sent += rest
          }
        }
        sendSSE(reply, 'content_block_stop', { type: 'content_block_stop', index: tc.blockIdx })
      }
      if (!textBlockStarted && !encounteredToolCall) {
        sendSSE(reply, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
        sendSSE(reply, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '' },
        })
        sendSSE(reply, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      }
      sendSSE(reply, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: encounteredToolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: usage ? { output_tokens: usage.completion_tokens || 0 } : { output_tokens: accumulatedContent.split(' ').length },
      })
      sendSSE(reply, 'message_stop', { type: 'message_stop' })
      console.log(`[stream done] ${Date.now() - (reply.request?._t0 || Date.now())}ms, testo=${accumulatedContent.length}ch, tool=${Object.keys(toolCallsBuffer).length}`)
      reply.raw.end()
    }

    const failStream = (message) => {
      if (streamClosed) return
      streamClosed = true
      console.log('[stream FAIL]', String(message).slice(0, 300))
      try {
        sendSSE(reply, 'error', {
          type: 'error',
          error: { type: 'api_error', message: String(message).slice(0, 2000) },
        })
      } catch (_) {}
      reply.raw.end()
    }

    while (!done) {
      const { value, done: doneReading } = await reader.read()
      if (idleFired) break
      done = doneReading
      if (value) bumpIdle()
      if (value) {
        lineBuffer += decoder.decode(value, { stream: true })
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop()
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === '' || !trimmed.startsWith('data:')) continue
          const dataStr = trimmed.replace(/^data:\s*/, '')
          if (dataStr === '[DONE]') {
            finishStream()
            return
          }
          let parsed
          try {
            parsed = JSON.parse(dataStr)
          } catch (_) {
            continue
          }
          if (parsed.error) {
            failStream(parsed.error.message || JSON.stringify(parsed.error))
            return
          }
          if (!parsed.choices || !parsed.choices[0]) continue
          sendSuccessMessage()
          if (parsed.usage) usage = parsed.usage
          const delta = parsed.choices[0].delta
          if (delta && delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              encounteredToolCall = true
              const idx = toolCall.index
              let tc = toolCallsBuffer[idx]
              if (!tc) {
                tc = toolCallsBuffer[idx] = {
                  id: toolCall.id || `call_${Date.now()}_${idx}`,
                  name: toolCall.function?.name || 'unknown',
                  args: '', sent: '', started: false, broken: false,
                  blockIdx: nextBlockIndex++,
                }
              }
              if (toolCall.id) tc.id = toolCall.id
              if (toolCall.function?.name) tc.name = toolCall.function.name
              const frag = toolCall.function?.arguments || ''
              if (!frag) continue
              if (!tc.started) {
                tc.started = true
                sendSSE(reply, 'content_block_start', {
                  type: 'content_block_start',
                  index: tc.blockIdx,
                  content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
                })
              }
              // gestisce sia frammenti append che snapshot cumulativi
              let target
              if (tc.args && frag.startsWith(tc.args)) target = frag
              else if (tc.args && tc.args.startsWith(frag)) { tc.args = tc.args; continue }
              else target = tc.args + frag
              if (!target.startsWith(tc.sent)) {
                console.log(`[tool stream] incoerenza argomenti su ${tc.name}, passo a buffered`)
                tc.broken = true
                tc.args = target
                continue
              }
              const rest = target.slice(tc.sent.length)
              if (rest) {
                sendSSE(reply, 'content_block_delta', {
                  type: 'content_block_delta',
                  index: tc.blockIdx,
                  delta: { type: 'input_json_delta', partial_json: rest },
                })
                tc.sent += rest
              }
              tc.args = target
            }
          } else if (delta && delta.content) {
            if (!textBlockStarted) {
              textBlockStarted = true
              sendSSE(reply, 'content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              })
            }
            accumulatedContent += delta.content
            sendSSE(reply, 'content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: delta.content },
            })
          }
        }
      }
    }
    clearTimeout(idleTimer)
    if (idleFired) {
      failStream('provider inattivo per oltre 90s, connessione abbandonata')
      return
    }
    finishStream()
  } catch (err) {
    if (isSucceeded) {
      failStream(err.message)
    } else {
      console.error(err)
      reply.code(500)
      return { type: 'error', error: { type: 'api_error', message: err.message } }
    }
  }
})

process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err && err.stack || err)
})
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && (err.stack || err))
})

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '::' })
    console.log(`proxy in ascolto su porta ${PORT}`)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

start()