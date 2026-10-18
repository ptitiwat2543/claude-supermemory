#!/usr/bin/env node
const readline = require('node:readline');
const { searchNamespace } = require('./lib/api');
const { getContainerTag } = require('./lib/container-tag');
const {
  isLimitStatus,
  recallCoolingDown,
  startRecallCooldown,
} = require('./lib/recall-cooldown');
const { getApiKey, getBaseUrl } = require('./lib/settings');

const MCP_URL =
  process.env.SUPERMEMORY_MCP_URL || 'https://mcp.supermemory.ai/mcp';
const REQUEST_TIMEOUT_MS = 30000;

const NAMESPACE_SCOPED_TOOLS = new Set([
  'search_memory',
  'get_profile',
  'list_documents',
  'listDocuments',
  'get_document',
  'getDocument',
  'list_memories',
  'listMemories',
  'set-active-tag',
  'memory-graph',
  'fetch-graph-data',
  'add_memory',
  'forget_memory',
  'save-memory',
  'prepare-file-upload',
]);

const LEGACY_CONTAINER_TAG_TOOLS = new Set([
  'search_memory',
  'add_memory',
  'listDocuments',
  'listMemories',
  'memory-graph',
  'fetch-graph-data',
  'save-memory',
]);

// The hosted search_memory tool returns formed memories only. This local tool
// searches memories and source chunks together, so an agent can reach document
// and code detail when it asks, without a search on every prompt.
const HYBRID_SEARCH_TOOL = {
  name: 'search_hybrid',
  description:
    'Search memories and source document chunks together in one space. Use when search_memory misses detail that lives in documents or code. Defaults to this repository space.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language search query' },
      namespace: { type: 'string', description: 'Space to search; defaults to this repository' },
    },
    required: ['query'],
  },
};
const HYBRID_RESULT_CHARS = 600;

let sessionId = null;

// Default scoped MCP calls to this repository; keep an explicit caller scope.
function injectRepoScope(message, repoNamespace) {
  if (!repoNamespace || message.method !== 'tools/call') return;
  const params = message.params;
  if (!params || typeof params !== 'object') return;
  const scopeField = NAMESPACE_SCOPED_TOOLS.has(params.name)
    ? 'namespace'
    : LEGACY_CONTAINER_TAG_TOOLS.has(params.name)
      ? 'containerTag'
      : null;
  if (!scopeField) return;

  let args = params.arguments;
  let encoded = false;
  if (args == null) {
    params.arguments = { [scopeField]: repoNamespace };
    return;
  }
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
      encoded = true;
    } catch {
      return;
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  if (['namespace', 'containerTag'].some((field) =>
    typeof args[field] === 'string' && args[field].trim()
  )) return;

  args[scopeField] = repoNamespace;
  params.arguments = encoded ? JSON.stringify(args) : args;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// Add the local tool to the hosted tool list; other responses pass through.
function withLocalTools(data, message) {
  if (message.method !== 'tools/list') return data;
  try {
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed?.result?.tools)) return data;
    parsed.result.tools.push(HYBRID_SEARCH_TOOL);
    return JSON.stringify(parsed);
  } catch {
    return data;
  }
}

function emitSseData(text, message) {
  for (const event of text.split('\n\n')) {
    for (const line of event.split('\n')) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data) process.stdout.write(`${withLocalTools(data, message)}\n`);
      }
    }
  }
}

function sendToolText(id, text, isError = false) {
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });
}

function formatHybridResults(results) {
  if (results.length === 0) return 'No matching memories or document chunks.';
  return results
    .map((r) => {
      const text = (r.memory || r.chunk || '').replace(/\s+/g, ' ').slice(0, HYBRID_RESULT_CHARS);
      const kind = typeof r.chunk === 'string' ? 'chunk' : 'memory';
      const score = Number.isFinite(r.similarity) ? ` ${Math.round(r.similarity * 100)}%` : '';
      const source = typeof r.filepath === 'string' && r.filepath ? ` (${r.filepath})` : '';
      return `- [${kind}${score}] ${text}${source}`;
    })
    .join('\n');
}

async function callHybridSearch(message, apiKey, cwd, repoNamespace) {
  const args = message.params?.arguments || {};
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const namespace =
    typeof args.namespace === 'string' && args.namespace.trim() ? args.namespace.trim() : repoNamespace;
  if (!query || !namespace) {
    sendToolText(message.id, 'search_hybrid needs a query and a space.', true);
    return;
  }
  if (recallCoolingDown()) {
    sendToolText(message.id, 'Supermemory search is paused after a usage limit. Try again later.', true);
    return;
  }
  try {
    const { results } = await searchNamespace(getBaseUrl(cwd), apiKey, namespace, query, {
      searchMode: 'hybrid',
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    sendToolText(message.id, formatHybridResults(results));
  } catch (err) {
    if (isLimitStatus(err?.status)) startRecallCooldown(err.status);
    sendToolText(message.id, `search_hybrid failed: ${err.message}`, true);
  }
}

async function forward(message, apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const newSessionId = response.headers.get('mcp-session-id');
  if (newSessionId) sessionId = newSessionId;

  if (response.status === 202) return;
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    sendError(
      message.id,
      -32000,
      `Supermemory MCP ${response.status}: ${text.slice(0, 200) || 'request failed'}`,
    );
    return;
  }

  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  if (!body.trim()) return;

  if (contentType.includes('text/event-stream')) {
    emitSseData(body, message);
  } else {
    process.stdout.write(`${withLocalTools(body.trim(), message)}\n`);
  }
}

async function main() {
  const cwd = process.cwd();
  let apiKey = null;
  let keyError = null;
  let repoContainerTag = null;
  try {
    apiKey = getApiKey(cwd);
  } catch (err) {
    keyError = err;
  }
  try {
    repoContainerTag = getContainerTag(cwd);
  } catch {
    repoContainerTag = null;
  }

  let queue = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    queue = queue.then(async () => {
      if (keyError) {
        sendError(
          message.id,
          -32001,
          'Supermemory is not authenticated. Start a Claude Code session with the supermemory plugin to log in, or set SUPERMEMORY_CC_API_KEY.',
        );
        return;
      }
      try {
        if (message.method === 'tools/call' && message.params?.name === HYBRID_SEARCH_TOOL.name) {
          await callHybridSearch(message, apiKey, cwd, repoContainerTag);
          return;
        }
        injectRepoScope(message, repoContainerTag);
        await forward(message, apiKey);
      } catch (err) {
        sendError(message.id, -32000, `Supermemory MCP proxy error: ${err.message}`);
      }
    });
  });

  rl.on('close', () => {
    queue.then(() => process.exit(0));
  });
}

main();
