import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import { createRequire } from 'node:module';
import './v5-api.mjs';

const require = createRequire(import.meta.url);
const {
  SESSION_RETENTION_MS,
  getSessionDir,
  pruneState,
  readState,
  writeState,
} = require('../plugin/hooks/lib/statusline-state.js');
const {
  ERROR_TTL_MS,
  SAVING_TTL_MS,
  TICK_MS,
  getStatusLabel,
  renderStatusline,
} = require('../plugin/statusline.js');

const HOOKS_DIR = join(process.cwd(), 'plugin', 'hooks');
const {
  getEntriesSinceLastCapture,
  groupEntriesIntoTurns,
} = require('../plugin/hooks/lib/transcript.js');

function hash16(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// Banners and frames carry ANSI color and OSC-8 links; assertions compare plain text.
function plain(s) {
  return typeof s === 'string' ? s.replace(/\x1b(\[[0-9;]*m|\]8;;[^\x07]*\x07)/g, '') : s;
}

function makeTempDir(t, prefix) {
  const root = join(tmpdir(), `claude-sm-${prefix}-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeRepo(t, name = 'Example Project') {
  const root = join(tmpdir(), `claude-sm-${Date.now()}-${Math.random()}`);
  const repo = join(root, name);
  const home = join(root, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  git(['remote', 'add', 'origin', 'git@github.com:acme/Example.Project.git']);
  writeFileSync(join(repo, 'README.md'), '# example\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { repo, git, home };
}

function readTags(cwd, home) {
  const modulePath = join(HOOKS_DIR, 'lib', 'container-tag.js');
  const script = `
    const tags = require(${JSON.stringify(modulePath)});
    console.log(JSON.stringify({
      tag: tags.getContainerTag(process.argv[1]),
      projectName: tags.getProjectName(process.argv[1]),
    }));
  `;
  const result = spawnSync('node', ['-e', script, cwd], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runHook(name, input, env = {}) {
  // Claude Code exports CLAUDE_PROJECT_DIR to hooks; a test sets it only when it means to.
  const { CLAUDE_PROJECT_DIR: _inherited, ...base } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(HOOKS_DIR, name)], {
      env: { ...base, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function startStubServer(t, handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const record = { method: req.method, url: req.url, headers: req.headers, body };
        requests.push(record);
        handler(record, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests });
    });
  });
}

// A second repository the session shell can cd into, with its own remote and so its own container.
function makeOtherRepo(t) {
  const other = makeRepo(t, 'Other Repo');
  other.git(['remote', 'set-url', 'origin', 'git@github.com:acme/Other.Repo.git']);
  return other.repo;
}

function makeAuthedHome(t, apiKey = 'sm_test_key_0123456789abcdef') {
  const home = makeTempDir(t, 'home');
  mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
  writeFileSync(
    join(home, '.supermemory-claude', 'credentials.json'),
    JSON.stringify({ apiKey }),
  );
  return home;
}

describe('container tags', () => {
  test('derives one canonical repo tag from the git remote', (t) => {
    const { repo, home } = makeRepo(t);
    const { tag, projectName } = readTags(repo, home);
    assert.equal(tag, `repo_example_project__${hash16('github.com/acme/example.project')}`);
    assert.equal(projectName, 'Example.Project');
  });

  test('uses the shared git common root for linked worktrees', (t) => {
    const { repo, git, home } = makeRepo(t, 'repo');
    git(['add', 'README.md']);
    git(['commit', '-m', 'initial']);
    const worktree = join(repo, '..', 'worktree');
    git(['worktree', 'add', '--detach', worktree, 'HEAD']);
    assert.equal(readTags(worktree, home).tag, readTags(repo, home).tag);
  });

  test('honors the project-config override', (t) => {
    const { repo, git, home } = makeRepo(t);
    const configDir = join(git(['rev-parse', '--show-toplevel']), '.claude', '.supermemory-claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ repoContainerTag: 'team_tag' }));
    assert.equal(readTags(repo, home).tag, 'team_tag');
  });
});

describe('recall-directive hook', () => {
  test('searches with the prompt and injects the top matches', async (t) => {
    const { repo, home } = makeRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(record.url.endsWith('/profile')
        ? { profile: { static: [], dynamic: [], buckets: {} } }
        : {
          results: [
              { id: 'mem_1', memory: 'Chose Drizzle over Prisma', similarity: 0.82 },
              { id: 'chunk_1', chunk: 'export const db = drizzle(client)', filepath: 'src/db.ts', similarity: 0.74 },
              { id: 'mem_2', memory: 'Errors must be loud and obvious', similarity: 0.71 },
              { id: 'mem_3', memory: 'Migration plan — Use expand-contract migrations', similarity: 0.7 },
              { id: 'mem_4', memory: 'irrelevant low-similarity hit', similarity: 0.2 },
          ],
          searchTime: 10,
        }));
    });

    const { code, stdout } = await runHook(
      'recall-directive.js',
      { session_id: 's1', cwd: repo, prompt: 'continue the database work from before' },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url },
    );
    assert.equal(code, 0);
    const output = JSON.parse(stdout);
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(context, /<supermemory-recall>/);
    assert.match(context, /- ◪ Chose Drizzle over Prisma/);
    assert.match(context, /- ◪ export const db = drizzle\(client\) \(src\/db\.ts\)/);
    assert.match(context, /- ◪ Errors must be loud and obvious/);
    assert.match(context, /- ◪ Migration plan — Use expand-contract migrations/);
    assert.doesNotMatch(context, /irrelevant low-similarity hit/);
    assert.match(context, /repo_example_project__/);
    assert.match(context, /defaults to this project's container/);
    assert.doesNotMatch(context, /omit containerTag to search the account/i);
    assert.match(plain(output.systemMessage), /^◪ supermemory · recalled \d+ memories \(\d+ tok\)$/);
    // The prompt hook only injects search hits, so it must not wait on /profile.
    assert.equal(stub.requests.length, 1);
    assert.ok(stub.requests.every((request) => !request.url.endsWith('/profile')));
    const searchRequest = stub.requests.find((request) => request.url.endsWith('/search'));
    assert.ok(searchRequest);
    assert.equal(
      JSON.parse(searchRequest.body).query,
      'continue the database work from before',
    );
    assert.equal(JSON.parse(searchRequest.body).searchMode, 'memories');

    const state = readState('s1', {
      dataDir: join(home, '.supermemory-claude', 'statusline'),
    });
    assert.equal(state.search.count, 1);
    assert.equal(state.search.results, 4);
    assert.equal(state.search.memories, 4);
  });

  function gitShim(home, delaySeconds) {
    // git on /mnt/c from WSL goes through git.exe and can take seconds under load.
    const bin = join(home, 'git-shim');
    mkdirSync(bin);
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const log = join(home, 'git-calls.log');
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\necho "$*" >> '${log}'\nsleep ${delaySeconds}\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    return { path: `${bin}:${process.env.PATH}`, log };
  }

  function writeTestKey(home) {
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
  }

  test('looks up the git root once per run', async (t) => {
    const { repo, home } = makeRepo(t);
    writeTestKey(home);
    const shim = gitShim(home, 0);
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ results: [], searchTime: 1 }));
    });
    await runHook(
      'recall-directive.js',
      { session_id: 's-git-count', cwd: repo, prompt: 'continue the database work from before' },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url, PATH: shim.path },
    );
    const calls = readFileSync(shim.log, 'utf8').trim().split('\n');
    // One root lookup (common dir, then top level) plus the remote name.
    assert.ok(calls.length <= 3, calls.join(' | '));
  });

  test('stays inside the 15 s async hook limit when git is slow and search hangs', async (t) => {
    const { repo, home } = makeRepo(t);
    writeTestKey(home);
    const shim = gitShim(home, 0.6);
    const stub = await startStubServer(t, () => {});
    const started = Date.now();
    const { code, stdout } = await runHook(
      'recall-directive.js',
      { session_id: 's-slow', cwd: repo, prompt: 'continue the database work from before' },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url, PATH: shim.path },
    );
    const elapsed = Date.now() - started;
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { continue: true, suppressOutput: true });
    // The hook runs async; Claude Code still kills it at 15000 ms and discards its output.
    assert.ok(elapsed < 14950, `took ${elapsed} ms`);
  });

  test('runs async so a slow search never delays the prompt', () => {
    // On 2026-10-20 the search API answered in 3.6-15 s, so a blocking hook made every prompt wait about 4.6 s for nothing.
    const hooks = JSON.parse(readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url), 'utf8')).hooks;
    const recall = hooks.UserPromptSubmit.flatMap((group) => group.hooks)
      .filter((hook) => hook.command.includes('recall-directive.js'));
    assert.equal(recall.length, 1);
    assert.equal(recall[0].async, true);
    assert.ok(recall[0].timeout >= 15, `timeout ${recall[0].timeout}`);
  });

  test('uses hybrid search when recallSearchMode is hybrid', async (t) => {
    const { repo, home } = makeRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    writeFileSync(
      join(home, '.supermemory-claude', 'settings.json'),
      JSON.stringify({ recallSearchMode: 'hybrid' }),
    );
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(record.url.endsWith('/profile')
        ? { profile: { static: [], dynamic: [], buckets: {} } }
        : { results: [{ id: 'chunk_1', chunk: 'catch block logs and returns', similarity: 0.8 }], searchTime: 5 }));
    });

    const { code, stdout } = await runHook(
      'recall-directive.js',
      { session_id: 's-hybrid', cwd: repo, prompt: 'what does the catch block do here' },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url },
    );
    assert.equal(code, 0);
    const searchRequest = stub.requests.find((request) => request.url.endsWith('/search'));
    const body = JSON.parse(searchRequest.body);
    assert.equal(body.searchMode, 'hybrid');
    assert.equal(body.threshold, 0.6);
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /catch block logs and returns/);
  });

  test('pauses recall after a 402 instead of asking on every prompt', async (t) => {
    const { repo, home } = makeRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const stub = await startStubServer(t, (record, res) => {
      res.statusCode = 402;
      res.end(JSON.stringify({ error: 'payment required' }));
    });
    const env = { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url };

    const first = await runHook(
      'recall-directive.js',
      { session_id: 's-limit-1', cwd: repo, prompt: 'continue the database work from before' },
      env,
    );
    assert.equal(first.code, 0);
    const requestsAfterFirst = stub.requests.length;
    assert.ok(requestsAfterFirst > 0);
    const cooldown = JSON.parse(
      readFileSync(join(home, '.supermemory-claude', 'recall-cooldown.json'), 'utf8'),
    );
    assert.equal(cooldown.status, 402);
    assert.ok(cooldown.until > Date.now());

    const second = await runHook(
      'recall-directive.js',
      { session_id: 's-limit-2', cwd: repo, prompt: 'continue the database work from before' },
      env,
    );
    assert.equal(second.code, 0);
    assert.equal(stub.requests.length, requestsAfterFirst);
  });

  test('skips trivial prompts and slash commands without an API call', async (t) => {
    const { repo, home } = makeRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const stub = await startStubServer(t, (record, res) => res.end('{}'));
    for (const prompt of ['hi', '/supermemory:status', '!ls', undefined]) {
      const { stdout } = await runHook(
        'recall-directive.js',
        { session_id: 's1', cwd: repo, prompt },
        { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url },
      );
      assert.equal(JSON.parse(stdout).hookSpecificOutput, undefined);
    }
    assert.equal(stub.requests.length, 0);
  });

  test('dedupes across the session: repeats go silent, mixes are labeled', async (t) => {
    const { repo, home } = makeRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    let hits = [
      { id: 'mem_1', memory: 'Chose Drizzle over Prisma', similarity: 0.82 },
      { id: 'mem_2', memory: 'Errors must be loud and obvious', similarity: 0.71 },
    ];
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(record.url.endsWith('/profile')
        ? { profile: { static: [], dynamic: [], buckets: {} } }
        : { results: hits, searchTime: 10 }));
    });
    const env = { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url };
    const input = { session_id: 's-dedup', cwd: repo, prompt: 'continue the database work' };

    const first = JSON.parse((await runHook('recall-directive.js', input, env)).stdout);
    assert.match(plain(first.systemMessage), /^◪ supermemory · recalled 2 memories \(\d+ tok\)$/);

    const second = JSON.parse((await runHook('recall-directive.js', input, env)).stdout);
    assert.equal(second.systemMessage, undefined);
    assert.equal(second.hookSpecificOutput, undefined);

    hits = [...hits, { id: 'mem_3', memory: 'New fact about migrations', similarity: 0.8 }];
    const third = JSON.parse((await runHook('recall-directive.js', input, env)).stdout);
    assert.match(plain(third.systemMessage), /^◪ supermemory · recalled 1 new \(\d+ tok\) · 2 already in context$/);
    assert.match(third.hookSpecificOutput.additionalContext, /New fact about migrations/);
    assert.doesNotMatch(third.hookSpecificOutput.additionalContext, /Chose Drizzle over Prisma/);

    const state = readState('s-dedup', {
      dataDir: join(home, '.supermemory-claude', 'statusline'),
    });
    assert.equal(state.search.count, 3);
    assert.equal(state.search.results, 1);
    assert.equal(state.search.memories, 3);
  });

  test('searches the session project container after the shell moves into another repo', async (t) => {
    const { repo, home } = makeRepo(t);
    const other = makeOtherRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ results: [], searchTime: 1 }));
    });

    const { code } = await runHook(
      'recall-directive.js',
      { session_id: 's-project', cwd: other, prompt: 'continue the database work from before' },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url, CLAUDE_PROJECT_DIR: repo },
    );
    assert.equal(code, 0);
    const projectTag = readTags(repo, home).tag;
    assert.notEqual(readTags(other, home).tag, projectTag);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].url, `/ns/${projectTag}/search`);
  });

  test('searches a follow-up together with the prompt before it', async (t) => {
    const { repo } = makeRepo(t);
    const home = makeAuthedHome(t);
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ results: [], searchTime: 1 }));
    });
    const env = { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url };
    const ask = (prompt) =>
      runHook('recall-directive.js', { session_id: 's-follow', cwd: repo, prompt }, env);

    await ask('continue the database migration work');
    await ask('/compact keep the plan');
    await ask('ok do all of it now');
    await ask('ok do all of it now');
    const beforeClear = stub.requests.length;
    await runHook('session-start.js', { session_id: 's-follow', cwd: repo, source: 'clear' }, env);
    stub.requests.splice(beforeClear); // session start's own profile lookup
    await ask('start the release notes');

    const queries = stub.requests
      .filter((request) => request.url.endsWith('/search'))
      .map((request) => JSON.parse(request.body).query);
    assert.deepEqual(queries, [
      'continue the database migration work',
      'ok do all of it now\ncontinue the database migration work',
      'ok do all of it now',
      'start the release notes',
    ]);
  });

  test('shows earlier recalls again after compaction or /clear', async (t) => {
    const { repo, home } = makeRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(record.url.endsWith('/profile')
        ? { profile: { static: [], dynamic: [], buckets: {} } }
        : { results: [{ id: 'mem_1', memory: 'Chose Drizzle over Prisma', similarity: 0.82 }], searchTime: 1 }));
    });
    const env = { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url };
    const recall = async () => JSON.parse((await runHook(
      'recall-directive.js',
      { session_id: 's-compact', cwd: repo, prompt: 'continue the database work' },
      env,
    )).stdout);

    assert.match((await recall()).hookSpecificOutput.additionalContext, /Chose Drizzle over Prisma/);
    assert.equal((await recall()).hookSpecificOutput, undefined);
    for (const source of ['resume', 'compact', 'clear']) {
      await runHook('session-start.js', { session_id: 's-compact', cwd: repo, source }, env);
      const output = await recall();
      if (source === 'resume') {
        // A resumed conversation still holds what it was shown.
        assert.equal(output.hookSpecificOutput, undefined);
      } else {
        assert.match(output.hookSpecificOutput.additionalContext, /Chose Drizzle over Prisma/, source);
      }
    }
  });

  test('a configured recallDirective restores advisory mode verbatim', async (t) => {
    const { repo, git, home } = makeRepo(t);
    const configDir = join(git(['rev-parse', '--show-toplevel']), '.claude', '.supermemory-claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ recallDirective: 'CUSTOM DIRECTIVE' }),
    );
    const { stdout } = await runHook(
      'recall-directive.js',
      { session_id: 's1', cwd: repo, prompt: 'a long substantive prompt here' },
      { HOME: home, USERPROFILE: home },
    );
    assert.equal(JSON.parse(stdout).hookSpecificOutput.additionalContext, 'CUSTOM DIRECTIVE');
  });
});

describe('stdin handling', () => {
  test('hooks finish even when stdin never emits end (issue #25)', async (t) => {
    const home = makeTempDir(t, 'stdin-home');
    const child = spawn('node', [join(HOOKS_DIR, 'recall-approve.js')], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(
      JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: {} }),
    );
    // stdin is deliberately left open — on Windows 'end' never fires.
    const stdout = await new Promise((resolve, reject) => {
      let out = '';
      const guard = setTimeout(() => {
        child.kill();
        reject(new Error('hook did not finish with stdin held open'));
      }, 5000);
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.on('close', () => {
        clearTimeout(guard);
        resolve(out);
      });
    });
    assert.equal(JSON.parse(stdout).continue, true);
  });
});

describe('recall-approve hook', () => {
  test('auto-approves read-only supermemory tools with a visible message', async (t) => {
    const home = makeTempDir(t, 'approve-home');
    for (const toolName of [
      'mcp__supermemory__search_memory',
      'mcp__plugin_supermemory_supermemory__search_memory',
      'mcp__claude_ai_supermemory__search_memory',
    ]) {
      const { stdout } = await runHook(
        'recall-approve.js',
        {
          session_id: 's1',
          tool_name: toolName,
          tool_input: { query: 'auth flow decisions' },
        },
        { HOME: home, USERPROFILE: home },
      );
      const output = JSON.parse(stdout);
      assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
      assert.equal(plain(output.systemMessage), '◪ supermemory · recalling: auth flow decisions');
    }
  });

  test('lets write tools and unrelated tools fall through to normal permissions', async (t) => {
    const home = makeTempDir(t, 'approve-home2');
    for (const toolName of ['mcp__supermemory__add_memory', 'Bash', 'mcp__other__search_memory']) {
      const { stdout } = await runHook(
        'recall-approve.js',
        { session_id: 's1', tool_name: toolName, tool_input: {} },
        { HOME: home, USERPROFILE: home },
      );
      const output = JSON.parse(stdout);
      assert.equal(output.hookSpecificOutput, undefined);
      assert.equal(output.continue, true);
    }
  });
});

describe('session-start hook', () => {
  test('injects profile memories and announces the count', async (t) => {
    const { repo, home } = makeRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(record.url.endsWith('/profile')
        ? {
          profile: {
            static: [{ id: 'mem_static', memory: 'Uses Bun' }],
            dynamic: [{ id: 'mem_dynamic', memory: 'Working on statusline' }],
            buckets: {},
          },
        }
        : { results: [], searchTime: 1 }));
    });

    const { code, stdout } = await runHook(
      'session-start.js',
      { session_id: 'sess-1', cwd: repo },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url },
    );
    assert.equal(code, 0);
    const output = JSON.parse(stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /Uses Bun/);
    assert.match(output.hookSpecificOutput.additionalContext, /Working on statusline/);
    assert.match(plain(output.systemMessage), /◪ supermemory · 2 memories loaded for Example\.Project/);
    const profileRequest = stub.requests.find((request) => request.url.endsWith('/profile'));
    assert.match(profileRequest.url, /^\/ns\/repo_example_project__[^/]+\/profile$/);
    assert.match(profileRequest.headers.authorization, /^Bearer sm_test/);

    const state = readState('sess-1', {
      dataDir: join(home, '.supermemory-claude', 'statusline'),
    });
    assert.equal(state.context.status, 'ready');
    assert.equal(state.context.memoryItemsLoaded, 2);
  });
});

describe('session-start project container', () => {
  test('loads the session project container when the shell is in another repo', async (t) => {
    const { repo, home } = makeRepo(t);
    const other = makeOtherRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ profile: { static: [], dynamic: [], buckets: {} } }));
    });

    const { code } = await runHook(
      'session-start.js',
      { session_id: 'sess-project', cwd: other, source: 'compact' },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url, CLAUDE_PROJECT_DIR: repo },
    );
    assert.equal(code, 0);
    assert.equal(stub.requests[0].url, `/ns/${readTags(repo, home).tag}/profile`);
  });
});

describe('transcript turn boundaries', () => {
  const prompt = { type: 'user', uuid: 'u1', message: { content: 'Opening prompt' } };
  const toolUse = {
    type: 'assistant', uuid: 'a1',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
  };
  const reply = {
    type: 'assistant', uuid: 'a2',
    message: { content: [{ type: 'text', text: 'Final reply' }] },
  };

  test('tool results and non-prompt user entries stay in the current turn', () => {
    const entries = [prompt, toolUse,
      { type: 'user', uuid: 't1', message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Tool output' }] },
      ] } },
      { type: 'user', uuid: 'm1', isMeta: true, message: { content: 'Internal metadata' } },
      { type: 'user', uuid: 'm2', message: { content: '<system-reminder>Internal reminder</system-reminder>' } },
      reply];
    const turns = groupEntriesIntoTurns(entries);
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].allEntries, entries);
    assert.deepEqual(getEntriesSinceLastCapture(entries, null), entries);
    assert.deepEqual(getEntriesSinceLastCapture(entries, 'a1'), entries.slice(2));
  });

  for (const content of ['Next prompt', [
    { type: 'tool_result', tool_use_id: 't1', content: 'Tool output' },
    { type: 'text', text: 'Next prompt' },
  ]]) {
    test(`a real user prompt starts a new turn (${typeof content}) without history backfill`, () => {
      const nextPrompt = { type: 'user', uuid: 'u2', message: { content } };
      const entries = [prompt, toolUse, reply, nextPrompt, { ...reply, uuid: 'a3' }];
      const turns = groupEntriesIntoTurns(entries);
      assert.equal(turns.length, 2);
      assert.deepEqual(turns[0].allEntries, entries.slice(0, 3));
      assert.deepEqual(getEntriesSinceLastCapture(entries, null), entries.slice(3));
    });
  }
});

describe('capture hook', () => {
  for (const settings of [{}, { includeTools: ['Read'] }, { signalExtraction: true }]) {
    test(`first save includes the prompt across multiple tool calls (${JSON.stringify(settings)})`, async (t) => {
      const { repo, home } = makeRepo(t);
      mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
      writeFileSync(join(home, '.supermemory-claude', 'credentials.json'),
        JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }));
      writeFileSync(join(home, '.supermemory-claude', 'settings.json'), JSON.stringify(settings));
      const transcript = join(makeTempDir(t, 'first-save'), 'session.jsonl');
      const entries = [
        { type: 'user', uuid: 'u1', timestamp: '2026-10-12T07:00:00Z',
          message: { content: 'Remember the release date from notes.md for the next deployment.' } },
        ...['t1', 't2'].flatMap((id) => [
          { type: 'assistant', uuid: `a-${id}`, message: { content: [
            { type: 'tool_use', id, name: 'Read', input: { file_path: 'notes.md' } },
          ] } },
          { type: 'user', uuid: `u-${id}`, message: { content: [
            { type: 'tool_result', tool_use_id: id, content: 'Release date: 20 October.' },
          ] } },
        ]),
      ];
      writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join('\n'));
      const stub = await startStubServer(t, (record, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'doc_first', status: 'queued' }));
      });
      const env = { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url };
      const finalReply = 'The notes say the release date is 20 October, with no other timing details.';
      const input = { session_id: 'first-save', cwd: repo, transcript_path: transcript,
        last_assistant_message: finalReply };
      assert.equal((await runHook('capture.js', input, env)).code, 0);
      assert.equal(stub.requests.length, 1);
      const { content } = JSON.parse(stub.requests[0].body);
      assert.match(content, /Remember the release date from notes.md/);
      assert.ok(content.includes(finalReply));
      assert.match(content, /<\|turn_start\|>2026-10-12T07:00:00Z/);
      assert.equal(content.includes('assistant:tool_result'), Boolean(settings.includeTools));

      entries.push({ type: 'assistant', uuid: 'a-final', message: {
        content: [{ type: 'text', text: finalReply }],
      } });
      writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join('\n'));
      await runHook('capture.js', input, env);
      assert.equal(stub.requests.length, 1);
    });
  }

  test('saves the transcript delta with scope metadata and entity context', async (t) => {
    const { repo, home } = makeRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const transcript = join(makeTempDir(t, 'transcript'), 'session.jsonl');
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-08-18T20:00:00Z',
          message: { content: 'Please fix the statusline symlink handling in the plugin' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [{ type: 'text', text: 'Fixed: the symlink now re-points each session.' }],
          },
        }),
      ].join('\n'),
    );
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'doc_123', status: 'queued' }));
    });

    const { code } = await runHook(
      'capture.js',
      { session_id: 'sess-2', cwd: repo, transcript_path: transcript },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url },
    );
    assert.equal(code, 0);
    assert.equal(stub.requests.length, 1);
    assert.match(stub.requests[0].url, /^\/ns\/repo_example_project__[^/]+\/document$/);
    const body = JSON.parse(stub.requests[0].body);
    assert.match(body.content, /statusline symlink/);
    assert.equal(body.metadata.sm_scope, 'personal');
    assert.equal(body.id, 'sess-2');
    assert.match(body.supportingContext, /EXTRACT/);
    assert.equal('containerTag' in body, false);
    assert.equal('customId' in body, false);
    assert.equal('entityContext' in body, false);

    const state = readState('sess-2', {
      dataDir: join(home, '.supermemory-claude', 'statusline'),
    });
    assert.equal(state.capture.status, 'saved');
  });

  test('saves into the session project container after the shell moves into another repo', async (t) => {
    const { repo, home } = makeRepo(t);
    const other = makeOtherRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const transcript = join(makeTempDir(t, 'project-dir'), 'session.jsonl');
    writeFileSync(transcript, [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-21T10:00:00Z',
        message: { content: 'Please check the migration notes in the other repository' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1',
        message: { content: [{ type: 'text', text: 'Checked: the notes match.' }] } }),
    ].join('\n'));
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'doc_project', status: 'queued' }));
    });

    const { code } = await runHook(
      'capture.js',
      { session_id: 'sess-project', cwd: other, transcript_path: transcript },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url, CLAUDE_PROJECT_DIR: repo },
    );
    assert.equal(code, 0);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].url, `/ns/${readTags(repo, home).tag}/document`);
  });

  test('saves a message typed while Claude works and skips task notifications', async (t) => {
    const { repo } = makeRepo(t);
    const home = makeAuthedHome(t);
    const transcript = join(makeTempDir(t, 'steer'), 'session.jsonl');
    const queued = (uuid, prompt, kind) => ({
      type: 'attachment', uuid, timestamp: '2026-10-21T10:00:05Z',
      attachment: { type: 'queued_command', prompt, origin: { kind } },
    });
    // Older Claude Code versions mark a typed message with humanTurn only.
    const legacy = { type: 'attachment', uuid: 'q3', timestamp: '2026-10-21T10:00:07Z',
      attachment: { type: 'queued_command', prompt: 'and update the readme', humanTurn: true } };
    writeFileSync(transcript, [
      { type: 'user', uuid: 'u1', timestamp: '2026-10-21T10:00:00Z',
        message: { content: 'Refactor the export module' } },
      { type: 'assistant', uuid: 'a1', message: { content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'export.js' } },
      ] } },
      queued('q1', 'also keep the old file names', 'human'),
      queued('q2', '<task-notification>build finished</task-notification>', 'task-notification'),
      legacy,
      { type: 'assistant', uuid: 'a2', message: { content: [
        { type: 'text', text: 'Done, the old file names stay.' },
      ] } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'doc_steer', status: 'queued' }));
    });

    const { code } = await runHook(
      'capture.js',
      { session_id: 'steer-save', cwd: repo, transcript_path: transcript },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url },
    );
    assert.equal(code, 0);
    assert.equal(stub.requests.length, 1);
    const { content } = JSON.parse(stub.requests[0].body);
    // A steer belongs to the running turn, so the first save still carries the turn's prompt.
    assert.ok(content.includes('<|start|>user<|message|>Refactor the export module<|end|>'));
    assert.ok(content.includes('<|start|>user<|message|>also keep the old file names<|end|>'));
    assert.ok(content.includes('<|start|>user<|message|>and update the readme<|end|>'));
    assert.ok(content.includes('Done, the old file names stay.'));
    assert.doesNotMatch(content, /task-notification|build finished/);
  });

  for (const settings of [{}, { signalExtraction: true }]) {
    test(`leaves side-agent notes out but keeps the reply that checks them (${JSON.stringify(settings)})`, async (t) => {
      const { repo } = makeRepo(t);
      const home = makeAuthedHome(t);
      writeFileSync(join(home, '.supermemory-claude', 'settings.json'), JSON.stringify(settings));
      const transcript = join(makeTempDir(t, 'note'), 'session.jsonl');
      const note = 'Here is a note offered by a side agent:\n\n> Heads up · the export bug is probably back.';
      writeFileSync(transcript, [
        { type: 'user', uuid: 'u1', timestamp: '2026-10-21T11:00:00Z', message: { content: note } },
        { type: 'attachment', uuid: 'q1', timestamp: '2026-10-21T11:00:03Z',
          attachment: { type: 'queued_command', prompt: `${note} Fix it too.`, origin: { kind: 'human' } } },
        { type: 'assistant', uuid: 'a1', message: { content: [
          { type: 'text', text: 'Checked: the export bug is fixed and stays fixed.' },
        ] } },
      ].map((entry) => JSON.stringify(entry)).join('\n'));
      const stub = await startStubServer(t, (record, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'doc_note', status: 'queued' }));
      });

      const { code } = await runHook(
        'capture.js',
        { session_id: 'note-skip', cwd: repo, transcript_path: transcript },
        { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url },
      );
      assert.equal(code, 0);
      assert.equal(stub.requests.length, 1);
      const { content } = JSON.parse(stub.requests[0].body);
      assert.ok(content.includes('Checked: the export bug is fixed and stays fixed.'));
      assert.doesNotMatch(content, /side agent|Heads up|probably back/);
    });
  }

  test('a failed save does not advance the cursor; the retry recaptures (issue #96)', async (t) => {
    const { repo, home } = makeRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const transcript = join(makeTempDir(t, 'transcript-retry'), 'session.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-18T20:00:00Z',
        message: { content: 'Remember: we chose Drizzle over Prisma for performance' },
      }),
    );
    let failing = true;
    const stub = await startStubServer(t, (record, res) => {
      res.statusCode = failing ? 500 : 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(failing ? { error: 'boom' } : { id: 'doc_9', status: 'queued' }));
    });
    const env = { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url };
    const input = { session_id: 'sess-retry', cwd: repo, transcript_path: transcript };

    await runHook('capture.js', input, env);
    const dataDir = join(home, '.supermemory-claude', 'statusline');
    assert.equal(readState('sess-retry', { dataDir }).capture.status, 'error');

    failing = false;
    await runHook('capture.js', input, env);
    assert.equal(stub.requests.length, 2);
    assert.match(JSON.parse(stub.requests[1].body).content, /Drizzle over Prisma/);
    assert.equal(readState('sess-retry', { dataDir }).capture.status, 'saved');

    // Cursor advanced after success: a third run finds nothing new.
    await runHook('capture.js', input, env);
    assert.equal(stub.requests.length, 2);
  });
});

describe('mcp proxy', () => {
  function runProxy(t, env, lines, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [join(HOOKS_DIR, 'mcp-proxy.js')], {
        env: { ...process.env, ...env },
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('error', reject);
      child.on('close', () =>
        resolve(stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))),
      );
      for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
      child.stdin.end();
    });
  }

  test('forwards requests with the stored key and tracks the MCP session', async (t) => {
    const home = makeAuthedHome(t);
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Mcp-Session-Id', 'mcp-sess-9');
      const { id } = JSON.parse(record.body);
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));
    });

    const messages = await runProxy(
      t,
      { HOME: home, USERPROFILE: home, SUPERMEMORY_MCP_URL: `${stub.url}/mcp` },
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ],
    );
    assert.deepEqual(messages.map((m) => m.id), [1, 2]);
    assert.match(stub.requests[0].headers.authorization, /^Bearer sm_test/);
    assert.equal(stub.requests[0].headers['mcp-session-id'], undefined);
    assert.equal(stub.requests[1].headers['mcp-session-id'], 'mcp-sess-9');
  });

  test('lists search_hybrid with the hosted tools', async (t) => {
    const home = makeAuthedHome(t);
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      const { id } = JSON.parse(record.body);
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'search_memory' }] } }));
    });

    const [message] = await runProxy(
      t,
      { HOME: home, USERPROFILE: home, SUPERMEMORY_MCP_URL: `${stub.url}/mcp` },
      [{ jsonrpc: '2.0', id: 3, method: 'tools/list' }],
    );
    assert.deepEqual(message.result.tools.map((tool) => tool.name), ['search_memory', 'search_hybrid']);
  });

  test('answers search_hybrid locally with a hybrid REST search', async (t) => {
    const home = makeAuthedHome(t);
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        results: [
          { id: 'c1', chunk: 'catch block logs and returns', filepath: 'ProcessRun.cs', similarity: 0.71 },
          { id: 'm1', memory: 'Decision recorded', similarity: 0.65 },
        ],
      }));
    });

    const [message] = await runProxy(
      t,
      {
        HOME: home,
        USERPROFILE: home,
        SUPERMEMORY_MCP_URL: `${stub.url}/mcp`,
        SUPERMEMORY_API_URL: stub.url,
      },
      [{
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'search_hybrid', arguments: { query: 'catch block', namespace: 'repo_test' } },
      }],
    );
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].url, '/ns/repo_test/search');
    const body = JSON.parse(stub.requests[0].body);
    assert.equal(body.searchMode, 'hybrid');
    assert.equal(body.threshold, 0.6);
    assert.equal(body.rerank, 'none');
    assert.equal(body.rewriteQuery, false);
    assert.equal(message.result.isError, false);
    assert.match(message.result.content[0].text, /\[chunk 71%\] catch block logs and returns \(ProcessRun\.cs\)/);
    assert.match(message.result.content[0].text, /\[memory 65%\] Decision recorded/);
  });

  test('search_hybrid stops calling after a 402', async (t) => {
    const home = makeAuthedHome(t);
    const stub = await startStubServer(t, (record, res) => {
      res.statusCode = 402;
      res.end('{}');
    });
    const env = {
      HOME: home,
      USERPROFILE: home,
      SUPERMEMORY_MCP_URL: `${stub.url}/mcp`,
      SUPERMEMORY_API_URL: stub.url,
    };
    const call = (id) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'search_hybrid', arguments: { query: 'anything', namespace: 'repo_test' } },
    });

    const [first] = await runProxy(t, env, [call(5)]);
    const [second] = await runProxy(t, env, [call(6)]);
    assert.equal(first.result.isError, true);
    assert.equal(second.result.isError, true);
    assert.match(second.result.content[0].text, /paused after a usage limit/);
    assert.equal(stub.requests.length, 1);
  });

  test('unwraps SSE responses into stdout lines', async (t) => {
    const home = makeAuthedHome(t);
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      const { id } = JSON.parse(record.body);
      res.end(`event: message\ndata: {"jsonrpc":"2.0","id":${id},"result":{"via":"sse"}}\n\n`);
    });

    const messages = await runProxy(
      t,
      { HOME: home, USERPROFILE: home, SUPERMEMORY_MCP_URL: `${stub.url}/mcp` },
      [{ jsonrpc: '2.0', id: 7, method: 'tools/list' }],
    );
    assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 7, result: { via: 'sse' } }]);
  });

  test('answers with a clear JSON-RPC error when unauthenticated', async (t) => {
    const home = makeTempDir(t, 'no-auth-home');
    const messages = await runProxy(
      t,
      {
        HOME: home,
        USERPROFILE: home,
        SUPERMEMORY_MCP_URL: 'http://127.0.0.1:1/mcp',
        SUPERMEMORY_CC_API_KEY: '',
      },
      [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }],
    );
    assert.equal(messages[0].error.code, -32001);
    assert.match(messages[0].error.message, /not authenticated/);
  });

  test('defaults every live namespace-capable tool to the repository namespace', async (t) => {
    const { repo, home } = makeRepo(t);
    const expected = readTags(repo, home).tag;
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      const { id } = JSON.parse(record.body);
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));
    });
    const namespaceToolNames = [
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
    ];

    await runProxy(
      t,
      {
        HOME: home,
        USERPROFILE: home,
        SUPERMEMORY_CC_API_KEY: 'sm_test_key_0123456789abcdef',
        SUPERMEMORY_MCP_URL: `${stub.url}/mcp`,
      },
      namespaceToolNames.map((name, index) => ({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'tools/call',
        params: {
          name,
          ...(name === 'listDocuments' ? {} : { arguments: name === 'search_memory' ? { query: 'auth' } : {} }),
        },
      })),
      { cwd: repo },
    );

    const forwarded = stub.requests.map((r) => JSON.parse(r.body));
    assert.equal(forwarded.length, namespaceToolNames.length);
    for (const [index, name] of namespaceToolNames.entries()) {
      assert.equal(forwarded[index].params.arguments.namespace, expected, `${name} should default to the repo namespace`);
      assert.equal('containerTag' in forwarded[index].params.arguments, false, `${name} should not receive a competing containerTag`);
    }
  });

  test('preserves explicit scope in object and encoded-string arguments', async (t) => {
    const { repo, home } = makeRepo(t);
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      const { id } = JSON.parse(record.body);
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));
    });

    await runProxy(
      t,
      {
        HOME: home,
        USERPROFILE: home,
        SUPERMEMORY_CC_API_KEY: 'sm_test_key_0123456789abcdef',
        SUPERMEMORY_MCP_URL: `${stub.url}/mcp`,
      },
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'search_memory',
            arguments: { query: 'auth', namespace: 'explicit_namespace' },
          },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'add_memory',
            arguments: '{"content":"keep scope","namespace":"encoded_namespace"}',
          },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'listDocuments', arguments: { containerTag: 'explicit_tag' } },
        },
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'listMemories',
            arguments: '{"containerTag":"encoded_tag"}',
          },
        },
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'fetch-graph-data',
            arguments: { namespace: 'chosen_namespace', containerTag: 'chosen_tag' },
          },
        },
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'whoAmI', arguments: { namespace: 'account_scope' } },
        },
        { jsonrpc: '2.0', id: 7, method: 'tools/list' },
      ],
      { cwd: repo },
    );

    const forwarded = stub.requests.map((r) => JSON.parse(r.body));
    assert.deepEqual(forwarded[0].params.arguments, { query: 'auth', namespace: 'explicit_namespace' });
    assert.equal(forwarded[1].params.arguments, '{"content":"keep scope","namespace":"encoded_namespace"}');
    assert.deepEqual(forwarded[2].params.arguments, { containerTag: 'explicit_tag' });
    assert.equal(forwarded[3].params.arguments, '{"containerTag":"encoded_tag"}');
    assert.deepEqual(forwarded[4].params.arguments, { namespace: 'chosen_namespace', containerTag: 'chosen_tag' });
    assert.deepEqual(forwarded[5].params.arguments, { namespace: 'account_scope' });
    assert.equal(forwarded[6].method, 'tools/list');
    assert.equal(forwarded[6].params, undefined);
  });
});

describe('statusline state', () => {
  test('isolates sessions and writes private atomic event files', (t) => {
    const dataDir = makeTempDir(t, 'status-state');
    assert.equal(
      writeState('../../session-a', 'context', { status: 'ready', memoryItemsLoaded: 4 }, { dataDir, now: 1000 }),
      true,
    );
    writeState('session-a', 'search', { results: 2, query: 'must not be stored' }, { dataDir, now: 1100 });
    writeState('session-b', 'context', { status: 'ready', memoryItemsLoaded: 9 }, { dataDir, now: 1200 });

    const first = readState('../../session-a', { dataDir });
    const second = readState('session-b', { dataDir });
    assert.equal(first.context.memoryItemsLoaded, 4);
    assert.equal(first.search, null);
    assert.equal(second.context.memoryItemsLoaded, 9);
    assert.equal('query' in readState('session-a', { dataDir }).search, false);

    const traversalDir = getSessionDir('../../session-a', dataDir);
    assert.match(basename(traversalDir), /^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(traversalDir).mode & 0o777, 0o700);
      assert.equal(statSync(join(traversalDir, 'context.json')).mode & 0o777, 0o600);
    }
    assert.equal(readdirSync(traversalDir).some((name) => name.endsWith('.tmp')), false);
  });

  test('ignores corrupt state without breaking the renderer', (t) => {
    const dataDir = makeTempDir(t, 'status-corrupt');
    const sessionDir = getSessionDir('session-a', dataDir);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'context.json'), '{broken');
    assert.deepEqual(readState('session-a', { dataDir }), {
      context: null,
      capture: null,
      search: null,
    });
    assert.equal(renderStatusline(readState('session-a', { dataDir })), '');
  });

  test('prunes only stale hashed session directories', (t) => {
    const dataDir = makeTempDir(t, 'status-prune');
    writeState('stale-session', 'context', { status: 'ready', memoryItemsLoaded: 1 }, { dataDir });
    const sessionDir = getSessionDir('stale-session', dataDir);
    utimesSync(join(sessionDir, 'context.json'), new Date(0), new Date(0));
    utimesSync(sessionDir, new Date(0), new Date(0));
    const unrelated = join(sessionDir, '..', 'do-not-delete');
    mkdirSync(unrelated);
    const activeSessionDir = getSessionDir('active-session', dataDir);
    mkdirSync(activeSessionDir);
    writeFileSync(join(activeSessionDir, '.context.tmp'), 'in progress');

    pruneState({ dataDir, now: SESSION_RETENTION_MS + 1 });
    assert.equal(existsSync(sessionDir), false);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(activeSessionDir), true);
  });
});

describe('statusline rendering', () => {
  const now = 100_000;
  const context = {
    version: 1,
    event: 'context',
    status: 'ready',
    memoryItemsLoaded: 3,
    updatedAt: now,
  };

  test('rests on a live session tally that grows with activity', () => {
    assert.equal(getStatusLabel({ context }, now), '3 loaded');
    assert.equal(
      getStatusLabel(
        { context, capture: { status: 'saved', count: 7, updatedAt: now + 10 } },
        now + 20,
      ),
      '3 loaded · 7 captured',
    );
    assert.equal(
      getStatusLabel(
        {
          context,
          capture: { status: 'saved', count: 7, updatedAt: now + 10 },
          search: { results: 4, count: 2, updatedAt: now + 12 },
        },
        now + 20,
      ),
      '3 loaded · 7 captured · 2 recalls',
    );
    assert.equal(
      getStatusLabel(
        { context, search: { results: 4, count: 1, updatedAt: now + 12 } },
        now + 20,
      ),
      '3 loaded · 1 recall',
    );
    // With injected memories tracked, the tally counts memories, not events.
    assert.equal(
      getStatusLabel(
        {
          context,
          search: { results: 4, count: 2, memories: 9, updatedAt: now + 12 },
        },
        now + 20,
      ),
      '3 loaded · 9 recalled',
    );
    assert.equal(
      renderStatusline({ context }, { now, color: false }),
      '◪ supermemory · 3 loaded',
    );
    // Animation is presentation-only: the plain path is time-invariant.
    assert.equal(
      renderStatusline({ context }, { now: now + 7 * TICK_MS, color: false }),
      '◪ supermemory · 3 loaded',
    );
  });

  test('transient states briefly take over the tally', () => {
    assert.equal(
      getStatusLabel(
        { context, capture: { status: 'saving', count: 7, updatedAt: now + 15 } },
        now + 20,
      ),
      'saving session',
    );
    assert.equal(
      getStatusLabel(
        { context, capture: { status: 'saving', count: 7, updatedAt: now + 15 } },
        now + 15 + SAVING_TTL_MS,
      ),
      '3 loaded · 7 captured',
    );
    assert.equal(
      getStatusLabel(
        { context, capture: { status: 'error', count: 7, updatedAt: now + 15 } },
        now + 20,
      ),
      'session sync failed',
    );
    assert.equal(
      getStatusLabel(
        { context, capture: { status: 'error', count: 7, updatedAt: now + 15 } },
        now + 15 + ERROR_TTL_MS,
      ),
      '3 loaded · 7 captured',
    );
  });

  test('animates: no frame repeats within any 10s window', () => {
    const states = {
      saving: { context, capture: { status: 'saving', count: 2, updatedAt: now } },
      tally: {
        context,
        capture: { status: 'saved', count: 7, updatedAt: now + 10 },
        search: { results: 4, count: 2, updatedAt: now + 12 },
      },
      ready: { context: { ...context, memoryItemsLoaded: 0 } },
    };
    for (const [name, state] of Object.entries(states)) {
      const frames = Array.from({ length: 10 }, (_, i) =>
        renderStatusline(state, { now: now + 20 + i * TICK_MS }),
      );
      assert.equal(new Set(frames).size, frames.length, `${name} frames repeat`);
    }
  });

  test('rotates real content panes: tally, save age, recall age', () => {
    const state = {
      context,
      capture: { status: 'saved', count: 7, updatedAt: now + 10 },
      search: { results: 4, count: 2, updatedAt: now + 12 },
    };
    const frames = Array.from({ length: 12 }, (_, i) =>
      plain(renderStatusline(state, { now: now + 60_000 + i * TICK_MS })),
    );
    assert.ok(frames.some((f) => f.includes('7 captured')), 'tally pane missing');
    assert.ok(frames.some((f) => /saved \d+[smh] ago/.test(f)), 'save age pane missing');
    assert.ok(frames.some((f) => /recalled \d+[smh] ago/.test(f)), 'recall age pane missing');
  });

  test('suppresses counts from before the current session context', () => {
    assert.equal(
      getStatusLabel(
        {
          context,
          capture: { status: 'saved', count: 9, updatedAt: now - 1 },
          search: { results: 1, count: 3, updatedAt: now - 1 },
        },
        now + 10,
      ),
      '3 loaded',
    );
    assert.equal(getStatusLabel({ context: { ...context, status: 'error' } }, now), null);
    assert.equal(
      getStatusLabel({ context: { ...context, memoryItemsLoaded: 0 } }, now),
      'ready',
    );
  });
});
