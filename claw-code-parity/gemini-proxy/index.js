/**
 * Gemini Proxy — Anthropic Messages API → Google AI Studio
 *
 * The Rust Brain (rusty-claude-cli) only speaks Anthropic Messages API.
 * This proxy sits in between and translates:
 *   Brain → POST /v1/messages (Anthropic fmt) → [this proxy] → Google AI Studio → [this proxy] → Brain
 *
 * SSE event order the Rust SseParser expects:
 *   message_start → ping → content_block_start → content_block_delta(s) → content_block_stop
 *   → message_delta → message_stop
 *
 * Frames must be separated by \n\n (two newlines).
 *
 * Usage:
 *   $env:GOOGLE_AI_API_KEY = "AIzaSy..."
 *   node gemini-proxy/index.js
 *
 * Then in another terminal:
 *   $env:ANTHROPIC_API_KEY = "any-dummy-value"
 *   $env:ANTHROPIC_BASE_URL = "http://localhost:3001"
 *   cargo run --package rusty-claude-cli
 */

import http from 'http';

// ─── Config ──────────────────────────────────────────────────────────────────

const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GEMINI_MODEL      = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';
const PORT              = parseInt(process.env.PROXY_PORT || '3001', 10);
const GOOGLE_BASE       = 'https://generativelanguage.googleapis.com/v1beta/openai';

function log(msg) { process.stderr.write(`[gemini-proxy] ${msg}\n`); }

// ─── System prompt trimmer (keeps us in free tier) ─────────────────────────

// The Rust Brain sends a ~22K token system prompt. Free tier allows ~32K/min.
// We trim aggresively so system + tools + messages comfortably fit.
const MAX_SYSTEM_CHARS = 1500;   // ~375 tokens — minimal but effective

function trimSystemPrompt(text) {
  if (!text || text.length <= MAX_SYSTEM_CHARS) return text;
  return text.slice(0, MAX_SYSTEM_CHARS) + '\n\n[Use the available browser tools to complete the task.]';
}

// Only pass browser tools to Gemini — drops ~44 unneeded Rust Brain tools (~4K tokens)
const BROWSER_TOOL_PREFIX = 'browser_';

function filterBrowserTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  const browserTools = tools.filter(t => t.name && t.name.startsWith(BROWSER_TOOL_PREFIX));
  // Fall back to all tools if none match (safety net)
  return browserTools.length > 0 ? browserTools : tools;
}

// ─── Request conversion: Anthropic → OpenAI ──────────────────────────────────

function extractSystem(system) {
  if (!system) return null;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map(b => (b.type === 'text' ? b.text : '')).join('\n').trim();
  }
  return null;
}

function convertMessages(msgs, systemText) {
  const out = [];
  if (systemText) out.push({ role: 'system', content: systemText });

  for (const msg of msgs) {
    const { role, content } = msg;

    // Simple string content
    if (typeof content === 'string') { out.push({ role, content }); continue; }
    if (!Array.isArray(content))    { out.push({ role, content: String(content) }); continue; }

    const textBlocks      = content.filter(b => b.type === 'text');
    const toolUseBlocks   = content.filter(b => b.type === 'tool_use');
    const toolResultBlocks = content.filter(b => b.type === 'tool_result');

    if (toolResultBlocks.length > 0) {
      // Each tool result → separate "tool" role message
      for (const block of toolResultBlocks) {
        const txt = Array.isArray(block.content)
          ? block.content.map(b => b.text || '').join('\n')
          : (block.content || '');
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: txt });
      }
    } else if (toolUseBlocks.length > 0) {
      // Assistant calling tools
      const tool_calls = toolUseBlocks.map(b => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const text = textBlocks.map(b => b.text).join('\n') || null;
      out.push({ role: 'assistant', content: text, tool_calls });
    } else {
      out.push({ role, content: textBlocks.map(b => b.text).join('\n') });
    }
  }
  return out;
}

function convertTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function convertToolChoice(choice) {
  if (!choice)                    return undefined;
  if (choice.type === 'auto')     return 'auto';
  if (choice.type === 'any')      return 'required';
  if (choice.type === 'none')     return 'none';
  if (choice.type === 'tool')     return { type: 'function', function: { name: choice.name } };
  return 'auto';
}

// ─── Response conversion: OpenAI → Anthropic ─────────────────────────────────

function convertNonStreamResponse(openai, requestedModel) {
  const choice = openai.choices?.[0];
  const msg    = choice?.message || {};
  const content = [];

  if (msg.content) content.push({ type: 'text', text: msg.content });

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }

  return {
    id:            openai.id || ('msg_' + Date.now()),
    type:          'message',
    role:          'assistant',
    content,
    model:         requestedModel,
    stop_reason:   choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens:  openai.usage?.prompt_tokens     || 0,
      output_tokens: openai.usage?.completion_tokens || 0,
    },
  };
}

// ─── SSE helpers ─────────────────────────────────────────────────────────────

// The Rust SseParser splits on \n\n — each event must end with exactly \n\n
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Streaming handler ────────────────────────────────────────────────────────

async function handleStream(res, anthropicReq, openaiReq) {
  const msgId          = 'msg_' + Date.now();
  const requestedModel = anthropicReq.model || GEMINI_MODEL;

  // ── Call Google FIRST — check for errors before committing to 200/SSE ─────
  const googleResp = await fetch(`${GOOGLE_BASE}/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GOOGLE_AI_API_KEY}` },
    body:    JSON.stringify({ ...openaiReq, stream: true }),
  });

  if (!googleResp.ok) {
    const err = await googleResp.text();
    log(`Google error ${googleResp.status}: ${err}`);
    // Return a proper HTTP error so Rust handles it as a network error (not SSE parse error)
    res.writeHead(googleResp.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Google ${googleResp.status}: ${err}` } }));
    return;
  }

  // ── Google is OK — now commit to SSE streaming ────────────────────────────
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'x-request-id':  msgId,
  });

  // Initial Anthropic framing
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id:            msgId,
      type:          'message',
      role:          'assistant',
      content:       [],
      model:         requestedModel,
      stop_reason:   null,
      stop_sequence: null,
      usage:         { input_tokens: 0, output_tokens: 0 },
    },
  });
  sse(res, 'ping', { type: 'ping' });

  // ── Stream state ───────────────────────────────────────────────────────────
  let textBlockOpen = false;
  let nextBlockIdx  = 0;
  // Map: openai tool_calls[index] → { id, name, blockIdx }
  const toolBlocks  = new Map();
  let stopReason    = 'end_turn';
  let outputTokens  = 0;
  let lineBuf       = '';
  const decoder     = new TextDecoder();

  for await (const rawChunk of googleResp.body) {
    lineBuf += decoder.decode(rawChunk, { stream: true });

    // Split on newlines, keep incomplete last line in buffer
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; }

      const choice       = parsed.choices?.[0];
      const delta        = choice?.delta;
      const finishReason = choice?.finish_reason;

      if (parsed.usage) outputTokens = parsed.usage.completion_tokens || 0;
      if (!delta && !finishReason) continue;

      // ── Text delta ──────────────────────────────────────────────────────
      if (delta?.content) {
        if (!textBlockOpen) {
          sse(res, 'content_block_start', {
            type: 'content_block_start', index: nextBlockIdx,
            content_block: { type: 'text', text: '' },
          });
          textBlockOpen = true;
          nextBlockIdx++;
        }
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,                          // text block is always index 0
          delta: { type: 'text_delta', text: delta.content },
        });
      }

      // ── Tool call deltas ────────────────────────────────────────────────
      if (delta?.tool_calls) {
        // Close open text block before tool blocks
        if (textBlockOpen) {
          sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
          textBlockOpen = false;
        }

        for (const tc of delta.tool_calls) {
          const tcIdx = tc.index ?? 0;

          if (!toolBlocks.has(tcIdx)) {
            const blockIdx = nextBlockIdx++;
            toolBlocks.set(tcIdx, { id: tc.id, name: tc.function?.name || '', blockIdx });
            sse(res, 'content_block_start', {
              type: 'content_block_start', index: blockIdx,
              content_block: {
                type: 'tool_use',
                id:   tc.id,
                name: tc.function?.name || '',
                input: {},
              },
            });
          }

          const block = toolBlocks.get(tcIdx);
          if (tc.function?.name && !block.name) block.name = tc.function.name;

          if (tc.function?.arguments) {
            sse(res, 'content_block_delta', {
              type: 'content_block_delta', index: block.blockIdx,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            });
          }
        }
      }

      if (finishReason) {
        stopReason = finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';
      }
    }
  }

  // ── Close all open blocks ──────────────────────────────────────────────────
  if (textBlockOpen) {
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  }
  for (const [, block] of toolBlocks) {
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: block.blockIdx });
  }

  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: 0, output_tokens: outputTokens },  // input_tokens required (no serde default)
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// ─── Main request handler ─────────────────────────────────────────────────────

async function handleRequest(req, res) {
  // Collect request body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  let anthropicReq;
  try { anthropicReq = JSON.parse(body); }
  catch { res.writeHead(400); res.end('Bad Request'); return; }

  log(`${anthropicReq.stream ? 'stream' : 'non-stream'} | model=${anthropicReq.model} | msgs=${anthropicReq.messages?.length} | tools=${anthropicReq.tools?.length ?? 0}`);

  // ── Build OpenAI-format request ─────────────────────────────────────────
  const systemText    = trimSystemPrompt(extractSystem(anthropicReq.system));
  const messages      = convertMessages(anthropicReq.messages || [], systemText);
  const tools         = convertTools(filterBrowserTools(anthropicReq.tools));
  const tool_choice   = convertToolChoice(anthropicReq.tool_choice);

  const openaiReq = {
    model:      GEMINI_MODEL,
    messages,
    max_tokens: anthropicReq.max_tokens || 4096,
    ...(anthropicReq.temperature != null ? { temperature: anthropicReq.temperature } : {}),
    ...(tools       ? { tools }       : {}),
    ...(tool_choice ? { tool_choice } : {}),
  };

  if (anthropicReq.stream) {
    await handleStream(res, anthropicReq, openaiReq);
  } else {
    const googleResp = await fetch(`${GOOGLE_BASE}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GOOGLE_AI_API_KEY}` },
      body:    JSON.stringify(openaiReq),
    });
    const json = await googleResp.json();
    if (!googleResp.ok) {
      res.writeHead(googleResp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: json }));
      return;
    }
    const anthropicResp = convertNonStreamResponse(json, anthropicReq.model);
    res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': anthropicResp.id });
    res.end(JSON.stringify(anthropicResp));
  }
}

// ─── Start server ─────────────────────────────────────────────────────────────

if (!GOOGLE_AI_API_KEY) {
  console.error('[gemini-proxy] ERROR: GOOGLE_AI_API_KEY env var is required');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/messages') {
    try {
      await handleRequest(req, res);
    } catch (err) {
      log(`Unhandled error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'server_error', message: err.message } }));
      }
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  log(`Proxy running on http://localhost:${PORT}`);
  log(`Forwarding to: ${GOOGLE_BASE} using model: ${GEMINI_MODEL}`);
  log(`Set ANTHROPIC_BASE_URL=http://localhost:${PORT} in the Rust Brain's terminal`);
});
