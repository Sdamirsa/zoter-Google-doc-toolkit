/**
 * Anthropic Messages API client (v0.4).
 *
 * Uses Claude Sonnet 4.6 with the server-side `web_search` tool to discover
 * citations. Sonnet is ~40% cheaper than Opus for input/output tokens and
 * is fast enough for this task (citation finding is not reasoning-bound).
 * If you want to go back to Opus for higher-quality synthesis, change
 * CLAUDE_MODEL below and bump the PRICE_* constants accordingly
 * ($5/$25 for Opus, $3/$15 for Sonnet, $1/$5 for Haiku).
 *
 * The web_search tool runs on Anthropic's side — no client-side tool loop
 * needed; the response contains reasoning text, server_tool_use blocks,
 * tool result blocks, and finally the answer text, all in one API response.
 *
 * Dynamic filtering:
 *   The `web_search_20260209` tool version adds "dynamic filtering" — Claude
 *   writes small programs that post-process search results BEFORE they reach
 *   its context window, keeping only what's relevant. Anthropic markets this
 *   as "particularly effective for Literature review and citation verification"
 *   — our exact task. The new tool version AUTO-INJECTS the code_execution
 *   tool internally when it needs it; we must NOT also add code_execution to
 *   the tools array or Anthropic returns:
 *     "Auto-injecting tools would conflict with existing tool names:
 *      ['code_execution']. Each tool name must be unique."
 *
 * Tool version — update if Anthropic releases a newer one:
 *   https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/web-search-tool
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const WEB_SEARCH_TYPE = 'web_search_20260209';
const MAX_TOKENS = 16384;

// claude-sonnet-4-6 pricing (per https://platform.claude.com/docs/en/docs/about-claude/pricing)
// Values in USD per 1M tokens. Update if Anthropic changes rates or the model.
// Sonnet is ~40% cheaper than Opus for this task and is "the best combination
// of speed and intelligence" per the models overview docs.
const PRICE_INPUT_PER_MTOK = 3;
const PRICE_OUTPUT_PER_MTOK = 15;
const PRICE_CACHE_READ_PER_MTOK = 0.30;      // 10% of input for sonnet
const PRICE_CACHE_CREATE_PER_MTOK = 3.75;    // 125% of input
// web_search: $10 per 1000 requests = $0.01 per request (same across models)
const PRICE_WEB_SEARCH_PER_REQUEST = 0.01;

/**
 * Call Claude with the web_search tool enabled.
 * Returns { ok: true, text, json } on success, or { ok: false, error, raw } on failure.
 *
 * Robust JSON extraction: the response typically contains reasoning text
 * BEFORE the web_search tool calls and the final answer AFTER. We don't
 * just concatenate and parse — we scan every text block for a JSON array
 * and return the LAST one that parses. This handles the common case where
 * Claude narrates its thinking, calls the search, then produces the JSON.
 */
function Llm_callClaudeWithSearch(systemPrompt, userMessage, settings) {
  if (!settings.anthropicApiKey) {
    return { ok: false, error: 'No Anthropic API key set. Open Settings.' };
  }
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    // web_search_20260209 auto-injects code_execution internally for dynamic
    // filtering — do NOT also pass code_execution here, or the API rejects
    // the request with a tool-name conflict.
    tools: [{ type: WEB_SEARCH_TYPE, name: 'web_search', max_uses: 5 }]
  };
  let res;
  try {
    res = UrlFetchApp.fetch(ANTHROPIC_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': settings.anthropicApiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, error: 'Network error: ' + (e.message || e) };
  }
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) {
    return { ok: false, error: 'Anthropic API ' + code + ': ' + text.slice(0, 500) };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    return { ok: false, error: 'Anthropic returned non-JSON envelope', raw: text.slice(0, 500) };
  }

  // Collect every text block in the assistant response. With server tools
  // these are interleaved with server_tool_use and web_search_tool_result
  // blocks — we skip those. The LAST text block is usually the final answer.
  const textBlocks = [];
  if (Array.isArray(parsed.content)) {
    for (const block of parsed.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textBlocks.push(block.text);
      }
    }
  }
  if (!textBlocks.length) {
    return {
      ok: false,
      error: 'Claude returned no text block (stop_reason=' + (parsed.stop_reason || 'unknown') + ')',
      raw: text.slice(0, 500)
    };
  }

  // Truncation check — if max_tokens was hit, warn clearly.
  const truncated = parsed.stop_reason === 'max_tokens';

  // Try to extract a JSON array from the LAST text block first, then fall
  // back to earlier blocks. This is the common case: Claude narrates,
  // searches, then emits JSON as its final text.
  let jsonArray = null;
  for (let i = textBlocks.length - 1; i >= 0; i--) {
    const extracted = Llm_extractJsonArray(textBlocks[i]);
    if (extracted) { jsonArray = extracted; break; }
  }
  // Last resort: try across the concatenation (handles models that split
  // the array across two text blocks — rare but possible).
  if (!jsonArray) {
    const joined = textBlocks.join('\n');
    jsonArray = Llm_extractJsonArray(joined);
  }

  const concatText = textBlocks.join('\n\n---\n\n');
  const usage = parsed.usage || null;
  const cost = Llm_computeCost(usage);
  if (!jsonArray) {
    return {
      ok: true,
      text: concatText,
      json: null,
      usage: usage,
      cost: cost,
      parseError: truncated
        ? 'Response was truncated at max_tokens (' + MAX_TOKENS + ' tokens). Claude did not finish its JSON answer.'
        : 'Could not locate a JSON array in Claude\'s response.'
    };
  }
  return { ok: true, text: concatText, json: jsonArray, truncated: truncated, usage: usage, cost: cost };
}

/**
 * Compute the USD cost of one Anthropic API call from the `usage` field
 * of the response. Uses the PRICE_* constants above (currently set for
 * claude-sonnet-4-6); update them if the model or prices change.
 */
function Llm_computeCost(usage) {
  if (!usage) return 0;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  return (inTok       * PRICE_INPUT_PER_MTOK        / 1e6)
       + (outTok      * PRICE_OUTPUT_PER_MTOK       / 1e6)
       + (cacheRead   * PRICE_CACHE_READ_PER_MTOK   / 1e6)
       + (cacheCreate * PRICE_CACHE_CREATE_PER_MTOK / 1e6)
       + (searches    * PRICE_WEB_SEARCH_PER_REQUEST);
}

/**
 * Extract a JSON array from arbitrary text. Handles:
 *   1. ```json ... ``` fenced blocks (most common)
 *   2. ``` ... ``` unlabeled fenced blocks
 *   3. A bare [...] anywhere in the text (takes the LAST balanced one)
 * Returns the parsed array, or null if nothing parses.
 */
function Llm_extractJsonArray(s) {
  if (!s || typeof s !== 'string') return null;
  // 1. Look for fenced code blocks.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  let fenced = [];
  while ((m = fenceRe.exec(s)) !== null) fenced.push(m[1].trim());
  for (let i = fenced.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(fenced[i]);
      if (Array.isArray(v)) return v;
    } catch (e) {}
  }
  // 2. Find the last balanced [...] in the text (greedy from the right).
  for (let end = s.lastIndexOf(']'); end >= 0; end = s.lastIndexOf(']', end - 1)) {
    let depth = 0;
    for (let start = end; start >= 0; start--) {
      const ch = s.charAt(start);
      if (ch === ']') depth++;
      else if (ch === '[') {
        depth--;
        if (depth === 0) {
          const candidate = s.substring(start, end + 1);
          try {
            const v = JSON.parse(candidate);
            if (Array.isArray(v)) return v;
          } catch (e) {}
          break;
        }
      }
    }
  }
  return null;
}

/** Quick connectivity test for the Settings panel. Returns {ok, message}. */
function Llm_testConnection(settings) {
  if (!settings.anthropicApiKey) return { ok: false, message: 'No API key set.' };
  try {
    const res = UrlFetchApp.fetch(ANTHROPIC_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': settings.anthropicApiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      payload: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Say "ok".' }]
      }),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return { ok: true, message: 'Connected.' };
    return { ok: false, message: 'HTTP ' + code + ': ' + res.getContentText().slice(0, 200) };
  } catch (e) {
    return { ok: false, message: 'Error: ' + (e.message || e) };
  }
}
