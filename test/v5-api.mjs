import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AGENT_SUPPORTING_CONTEXT, addDocument, getProfile } = require('../plugin/hooks/lib/api.js');

function startServer(t, handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const request = { method: req.method, url: req.url, headers: req.headers, body };
        requests.push(request);
        handler(request, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.closeAllConnections());
      t.after(() => server.close());
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests });
    });
  });
}

function respond(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}

test('getProfile isolates namespace, separates search, and normalizes profile facts', async (t) => {
  const server = await startServer(t, (request, res) => {
    if (request.url.endsWith('/profile')) {
      respond(res, 200, {
        profile: {
          static: [{ id: 'mem_static', memory: 'Keeps updates concise' }],
          dynamic: [],
          buckets: {},
        },
      });
      return;
    }
    respond(res, 200, {
      results: [{ id: 'mem_result', memory: 'Uses PostgreSQL', system: { status: 'done' } }],
      searchTime: 12,
    });
  });

  const result = await getProfile(server.url, 'test-key', 'team/alpha space', 'database choice');

  assert.deepEqual(server.requests.map(({ method, url }) => [method, url]).sort(), [
    ['POST', '/ns/team%2Falpha%20space/profile'],
    ['POST', '/ns/team%2Falpha%20space/search'],
  ].sort());
  const profileRequest = server.requests.find(({ url }) => url.endsWith('/profile'));
  const searchRequest = server.requests.find(({ url }) => url.endsWith('/search'));
  assert.deepEqual(JSON.parse(profileRequest.body), {});
  assert.equal(profileRequest.headers.authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(searchRequest.body), {
    query: 'database choice',
    searchMode: 'memories',
    threshold: 0.6,
    limit: 10,
    rerank: 'none',
    rewriteQuery: false,
    include: { documents: false, related: false, forgotten: false },
  });
  assert.deepEqual(result.profile, { static: ['Keeps updates concise'], dynamic: [], buckets: {} });
  assert.deepEqual(result.searchResults.results, [
    { id: 'mem_result', memory: 'Uses PostgreSQL', system: { status: 'done' } },
  ]);
});

test('getProfile skips search when query is empty and accepts empty profile arrays', async (t) => {
  const server = await startServer(t, (_request, res) =>
    respond(res, 200, { profile: { static: [], dynamic: [], buckets: {} } }),
  );

  const result = await getProfile(server.url, 'test-key', 'repo_one', '  ');

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, '/ns/repo_one/profile');
  assert.deepEqual(result.profile, { static: [], dynamic: [], buckets: {} });
});

test('getProfile rejects malformed profiles and malformed search results', async (t) => {
  const invalidProfiles = [
    {},
    { profile: { static: null, dynamic: [] } },
    { profile: { static: [{ id: 'mem_1' }], dynamic: [] } },
  ];
  for (const payload of invalidProfiles) {
    const server = await startServer(t, (_request, res) => respond(res, 200, payload));
    await assert.rejects(getProfile(server.url, 'test-key', 'repo_one', ''), /profile/i);
  }

  const server = await startServer(t, (request, res) => {
    if (request.url.endsWith('/profile')) {
      respond(res, 200, { profile: { static: [], dynamic: [], buckets: {} } });
    } else {
      respond(res, 200, { results: [{ id: 'mem_1' }] });
    }
  });
  await assert.rejects(getProfile(server.url, 'test-key', 'repo_one', 'query'), /search/i);
});

test('addDocument sends only v5 fields and accepts queued document acknowledgement', async (t) => {
  const server = await startServer(t, (_request, res) =>
    respond(res, 200, { id: 'session/012', status: 'queued' }),
  );
  const metadata = { sm_scope: 'personal', type: 'session_turn' };

  const result = await addDocument(
    server.url,
    'test-key',
    'Transcript delta',
    'repo/alpha',
    metadata,
    { id: 'session/012', supportingContext: AGENT_SUPPORTING_CONTEXT },
  );

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, 'POST');
  assert.equal(server.requests[0].url, '/ns/repo%2Falpha/document');
  assert.equal(server.requests[0].headers['x-sm-source'], 'claude-code');
  assert.deepEqual(JSON.parse(server.requests[0].body), {
    content: 'Transcript delta',
    metadata: { sm_scope: 'personal', type: 'session_turn', sm_source: 'claude-code' },
    id: 'session/012',
    supportingContext: AGENT_SUPPORTING_CONTEXT,
  });
  assert.deepEqual(result, { id: 'session/012', status: 'queued' });
  assert.equal(AGENT_SUPPORTING_CONTEXT.includes('Transient repo state'), true);
});

test('addDocument rejects failed or malformed acknowledgements', async (t) => {
  for (const payload of [
    { id: 'doc_1', status: 'failed' },
    { id: 'doc_1', status: 'unknown-new-state' },
    { id: '', status: 'queued' },
    { status: 'queued' },
  ]) {
    const server = await startServer(t, (_request, res) => respond(res, 200, payload));
    await assert.rejects(addDocument(server.url, 'test-key', 'content', 'repo_one', {}), /document|status/i);
  }
});

test('HTTP 429 is surfaced with status and is sent once', async (t) => {
  const server = await startServer(t, (_request, res) => respond(res, 429, { error: 'rate limited' }));

  await assert.rejects(
    addDocument(server.url, 'test-key', 'content', 'repo_one', {}),
    (error) => error.status === 429 && /429/.test(error.message),
  );
  assert.equal(server.requests.length, 1);
});

test('profile and document requests honor the shared timeout option', async (t) => {
  const server = await startServer(t, () => {});

  await assert.rejects(
    getProfile(server.url, 'test-key', 'repo_one', '', { timeoutMs: 25 }),
    (error) => error.name === 'TimeoutError' || error.name === 'AbortError',
  );
  await assert.rejects(
    addDocument(server.url, 'test-key', 'content', 'repo_one', {}, { timeoutMs: 25 }),
    (error) => error.name === 'TimeoutError' || error.name === 'AbortError',
  );
});

test('invalid namespace cannot send a profile or document request', async (t) => {
  const server = await startServer(t, (request, res) => respond(res, 200,
    request.url.endsWith('/profile')
      ? { profile: { static: [], dynamic: [] } }
      : { id: 'fixture-document', status: 'queued' }));
  for (const namespace of [undefined, null, '', ' \t ', 123, {}]) {
    await assert.rejects(getProfile(server.url, 'test-key', namespace, ''), /namespace/i);
    await assert.rejects(addDocument(server.url, 'test-key', 'content', namespace, {}), /namespace/i);
  }
  assert.equal(server.requests.length, 0);
});

test('document migration preserves caller metadata values', async (t) => {
  const server = await startServer(t, (_request, res) => respond(res, 200, { id: 'fixture-id', status: 'queued' }));
  const metadata = { sm_source: 'fixture-explicit-source', sm_scope: 'personal' };
  await addDocument(server.url, 'test-key', 'content', 'repo_one', metadata, { id: 'fixture-id' });
  assert.deepEqual(JSON.parse(server.requests[0].body).metadata, metadata);
});
