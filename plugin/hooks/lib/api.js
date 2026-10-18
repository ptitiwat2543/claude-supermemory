const AGENT_SUPPORTING_CONTEXT = `Shared coding-agent memory for one software repository.

RULES:
- Try to remember things that a human would remember — a teammate recalls decisions and lessons, not what state the working tree was in
- Preserve durable context that helps a coding agent continue the work
- Condense assistant responses into decisions, outcomes, and reusable knowledge
- Keep user preferences and project facts concise and independently understandable

EXTRACT:
- User preferences, accepted decisions, durable workflows, actions, and learnings
- Architecture: "uses monorepo with turborepo", "API in /apps/api"
- Conventions: "components in PascalCase", "hooks prefixed with use"
- Patterns: "all API routes use withAuth wrapper", "errors thrown as ApiError"
- Setup: "requires .env with DATABASE_URL", "run pnpm db:migrate first"
- Decisions: "chose Drizzle over Prisma for performance", "using RSC for data fetching"

SKIP:
- Transient repo state git already tracks: uncommitted file lists, current branch position, in-flight commit/push status
- Generic assistant suggestions the user did not accept
- Transient command output and low-value implementation chatter
- Granular details that do not help future work`;

// Hooks sit between the user and Claude — a slow or dead network must never
// hold the session hostage. Requests default to 3s; prompt recall allows 4s.
// Callers treat failure as "no memory this time", not a blocker.
const REQUEST_TIMEOUT_MS = 3000;
const DOCUMENT_STATUSES = new Set([
  'unknown',
  'queued',
  'extracting',
  'chunking',
  'embedding',
  'indexing',
  'done',
  'failed',
]);

async function post(baseUrl, apiKey, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-sm-source': 'claude-code',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(
      new Error(`Supermemory API ${response.status}: ${text.slice(0, 200)}`),
      { status: response.status },
    );
  }
  return response.json();
}

function normalizeFacts(facts, label) {
  if (!Array.isArray(facts)) throw new Error(`Supermemory profile ${label} must be an array`);
  return facts.map((fact) => {
    if (!fact || typeof fact !== 'object' || typeof fact.id !== 'string' || typeof fact.memory !== 'string') {
      throw new Error(`Supermemory profile ${label} contains a malformed memory`);
    }
    return fact.memory;
  });
}

function normalizeProfile(payload) {
  if (!payload || !payload.profile || typeof payload.profile !== 'object') {
    throw new Error('Supermemory profile response is malformed');
  }
  return {
    ...payload.profile,
    static: normalizeFacts(payload.profile.static, 'static'),
    dynamic: normalizeFacts(payload.profile.dynamic, 'dynamic'),
  };
}

function normalizeSearch(payload) {
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error('Supermemory search response is malformed');
  }
  const results = payload.results.map((result) => {
    if (
      !result ||
      typeof result !== 'object' ||
      typeof result.id !== 'string' ||
      !(typeof result.memory === 'string' || typeof result.chunk === 'string')
    ) {
      throw new Error('Supermemory search response contains a malformed result');
    }
    return result;
  });
  return { ...payload, results };
}

function namespacePath(namespace) {
  if (typeof namespace !== 'string' || !namespace.trim()) {
    throw new TypeError('Supermemory namespace must be a non-empty string');
  }
  return `/ns/${encodeURIComponent(namespace)}`;
}

function postSearch(baseUrl, apiKey, namespace, query, options = {}) {
  return post(
    baseUrl,
    apiKey,
    `${namespacePath(namespace)}/search`,
    {
      query,
      searchMode: options.searchMode === 'hybrid' ? 'hybrid' : 'memories',
      threshold: 0.6,
      limit: 10,
      rerank: 'none',
      rewriteQuery: false,
      include: { documents: false, related: false, forgotten: false },
    },
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
}

async function searchNamespace(baseUrl, apiKey, namespace, query, options = {}) {
  return normalizeSearch(await postSearch(baseUrl, apiKey, namespace, query, options));
}

async function getProfile(baseUrl, apiKey, namespace, query, options = {}) {
  const namespaceRoot = namespacePath(namespace);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const profilePromise = post(
    baseUrl,
    apiKey,
    `${namespaceRoot}/profile`,
    {},
    timeoutMs,
  );
  const searchPromise = typeof query === 'string' && query.trim()
    ? postSearch(baseUrl, apiKey, namespace, query, { ...options, timeoutMs })
    : null;

  const [profilePayload, searchPayload] = await Promise.all([
    profilePromise,
    searchPromise || Promise.resolve(null),
  ]);
  const result = { profile: normalizeProfile(profilePayload) };
  if (searchPayload) result.searchResults = normalizeSearch(searchPayload);
  return result;
}

async function addDocument(baseUrl, apiKey, content, namespace, metadata, options = {}) {
  const namespaceRoot = namespacePath(namespace);
  const body = {
    content,
    metadata: { sm_source: 'claude-code', ...metadata },
  };
  if (options.id !== undefined) body.id = options.id;
  if (options.supportingContext !== undefined) body.supportingContext = options.supportingContext;

  const result = await post(
    baseUrl,
    apiKey,
    `${namespaceRoot}/document`,
    body,
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  if (
    !result ||
    typeof result.id !== 'string' ||
    !result.id ||
    !DOCUMENT_STATUSES.has(result.status)
  ) {
    throw new Error('Supermemory document acknowledgement is malformed');
  }
  if (result.status === 'failed') {
    throw new Error(`Supermemory document ${result.id} was accepted with failed status`);
  }
  return result;
}

module.exports = { AGENT_SUPPORTING_CONTEXT, addDocument, getProfile, searchNamespace };
