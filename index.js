import Fastify from 'fastify'

const TARGET = process.env.PROVIDER_BASE_URL || 'https://api.openai.com/v1/chat/completions'
const API_KEY = process.env.API_KEY || ''

const fastify = Fastify({ logger: false })

function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use'
    case 'stop': return 'end_turn'
    case 'length': return 'max_tokens'
    default: return 'end_turn'
  }
}

fastify.post('/v1/messages', async (request, reply) => {
  try {
    const payload = request.body

    const normalizeContent = (content) => {
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content.map(item => item.text || item.content).join(' ')
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
            function: {
              type: 'function',
              id: toolCall.id,
              function: { name: toolCall.name, parameters: toolCall.input },
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
              content: toolResult.text || toolResult.content,
              tool_call_id: toolResult.tool_use_id,
            })
          })
        }
      })
    }

    const tools = (payload.tools || [])
      .filter(tool => !['BatchTool'].includes(tool.name))
      .map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }))

    const openaiPayload = {
      model: process.env.MODEL || 'gpt-4o-mini',
      messages,
      max_tokens: payload.max_tokens,
      temperature: payload.temperature !== undefined ? payload.temperature : 1,
      stream: payload.stream === true,
    }
    if (tools.length > 0) openaiPayload.tools = tools

    const openaiResponse = await fetch(TARGET, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(openaiPayload),
    })

    if (!openaiResponse.ok) {
      const errorDetails = await openaiResponse.text()
      reply.code(openaiResponse.status)
      return { error: errorDetails }
    }

    if (!openaiPayload.stream) {
      const data = await openaiResponse.json()
      if (data.error) throw new Error(data.error.message)

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
          ...toolCalls.map(toolCall => ({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments),
          })),
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
    const toolCallAccumulators = {}
    let usage = null
    let textBlockStarted = false
    const decoder = new TextDecoder('utf-8')
    const reader = openaiResponse.body.getReader()
    let done = false

    while (!done) {
      const { value, done: doneReading } = await reader.read()
      done = doneReading
      if (value) {
        const chunk = decoder.decode(value)
        const lines = chunk.split('\n')
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === '' || !trimmed.startsWith('data:')) continue
          const dataStr = trimmed.replace(/^data:\s*/, '')
          if (dataStr === '[DONE]') {
            if (encounteredToolCall) {
              for (const idx in toolCallAccumulators) {
                sendSSE(reply, 'content_block_stop', { type: 'content_block_stop', index: parseInt(idx, 10) })
              }
            } else if (textBlockStarted) {
              sendSSE(reply, 'content_block_stop', { type: 'content_block_stop', index: 0 })
            }
            sendSSE(reply, 'message_delta', {
              type: 'message_delta',
              delta: { stop_reason: encounteredToolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
              usage: usage ? { output_tokens: usage.completion_tokens } : { output_tokens: accumulatedContent.split(' ').length },
            })
            sendSSE(reply, 'message_stop', { type: 'message_stop' })
            reply.raw.end()
            return
          }
          const parsed = JSON.parse(dataStr)
          if (parsed.error) throw new Error(parsed.error.message)
          sendSuccessMessage()
          if (parsed.usage) usage = parsed.usage
          const delta = parsed.choices[0].delta
          if (delta && delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              encounteredToolCall = true
              const idx = toolCall.index
              if (toolCallAccumulators[idx] === undefined) {
                toolCallAccumulators[idx] = ''
                sendSSE(reply, 'content_block_start', {
                  type: 'content_block_start',
                  index: idx,
                  content_block: { type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: {} },
                })
              }
              const newArgs = toolCall.function.arguments || ''
              const oldArgs = toolCallAccumulators[idx]
              if (newArgs.length > oldArgs.length) {
                const deltaText = newArgs.substring(oldArgs.length)
                sendSSE(reply, 'content_block_delta', {
                  type: 'content_block_delta',
                  index: idx,
                  delta: { type: 'input_json_delta', partial_json: deltaText },
                })
                toolCallAccumulators[idx] = newArgs
              }
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
    reply.raw.end()
  } catch (err) {
    console.error(err)
    reply.code(500)
    return { error: err.message }
  }
})

const start = async () => {
  try {
    await fastify.listen({ port: 8080 })
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

start()