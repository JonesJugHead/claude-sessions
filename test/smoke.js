'use strict';

// Smoke test on a throwaway home folder: never touches your real Claude Code data.
// Usage: node test/smoke.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-test-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.CLAUDE_SESSIONS_CONFIG = path.join(fakeHome, '.claude-sessions', 'config.json');
delete process.env.CLAUDE_CONFIG_DIR;

let failed = 0;
function check(cond, msg) {
  console.log((cond ? 'ok   - ' : 'FAIL - ') + msg);
  if (!cond) failed++;
}

function writeJsonl(file, objs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

const ID1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const ID2 = '22222222-aaaa-4bbb-8ccc-000000000002';
const GHOST = '33333333-aaaa-4bbb-8ccc-000000000003';
const work = path.join(fakeHome, 'work');
fs.mkdirSync(work);

writeJsonl(path.join(fakeHome, '.claude', 'projects', 'proj-a', ID1 + '.jsonl'), [
  { type: 'user', cwd: work, message: { role: 'user', content: 'Refactor the parser please' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Sure, here is the plan with a banana.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'ai-title', aiTitle: 'Parser refactor', sessionId: ID1 },
]);
writeJsonl(path.join(fakeHome, '.claude-work', 'projects', 'proj-b', ID2 + '.jsonl'), [
  { type: 'user', cwd: work, message: { role: 'user', content: 'Hello from the work profile' } },
]);
writeJsonl(path.join(fakeHome, '.claude', 'projects', 'home', GHOST + '.jsonl'), [
  { type: 'user', cwd: fakeHome, message: { role: 'user', content: '<command-name>/usage</command-name>' } },
]);

const config = require('../lib/config');
const setup = require('../lib/setup');
const app = require('../claude-sessions');

(async () => {
  // detection + defaults
  const dirs = config.detectConfigDirs();
  check(dirs.length === 2, 'detects ~/.claude and ~/.claude-work');
  check(config.suggestLabel(path.join(fakeHome, '.claude-work')) === 'Work', 'suggests the "Work" label');
  const d = setup.defaults(null);
  check(d.profiles.length === 2 && d.terminal.includes('{script}'), 'defaults: 2 profiles and a terminal command');

  // non-interactive setup saves the defaults
  const isTTY = process.stdin.isTTY;
  process.stdin.isTTY = false;
  const cfg = await setup.run(null);
  process.stdin.isTTY = isTTY;
  check(fs.existsSync(config.CONFIG_PATH), 'config file written');
  check(config.load() !== null, 'config file reloads');
  const def = cfg.profiles.find((p) => p.label === 'Default');
  const wrk = cfg.profiles.find((p) => p.label === 'Work');
  check(def && def.setConfigDirEnv === false, 'default folder does not set CLAUDE_CONFIG_DIR');
  check(wrk && wrk.setConfigDirEnv === true, 'other folder sets CLAUDE_CONFIG_DIR');

  app.useConfig({ ...cfg, openBrowser: false });

  // scan / purge / title
  const n = app.purgeUsageSessions();
  check(n === 1, 'purges the /usage transcript');
  const s1 = app.scanProfile({ ...def, key: 'p0' });
  check(s1.length === 1 && s1[0].title === 'Parser refactor', 'uses the ai-title');

  // search
  const hits = app.searchAll('banana');
  check(hits.p0 && hits.p0[ID1] && hits.p0[ID1].count === 1, 'full-text search finds the assistant message');

  // rename
  app.renameSession(ID1, 'p0', 'My title');
  check(app.scanProfile({ ...def, key: 'p0' })[0].title === 'My title', 'rename writes a custom-title');

  // conversation
  const file = app.findSessionFile({ ...def, key: 'p0' }, ID1).file;
  const conv = app.parseConversation(file);
  check(conv.msgs.length === 2 && conv.msgs[1].tools[0] === 'Bash - npm test', 'conversation parsing');

  // invalid ids are rejected (path traversal / injection)
  let threw = false;
  try { app.findSessionFile({ ...def, key: 'p0' }, '../../etc/passwd'); } catch { threw = true; }
  check(threw, 'rejects invalid session ids');

  // move + delete
  app.moveSession(ID1, 'p0', 'p1');
  check(app.scanProfile({ ...wrk, key: 'p1' }).length === 2, 'move to the other profile');
  app.deleteSession(ID2, 'p1');
  check(app.scanProfile({ ...wrk, key: 'p1' }).length === 1, 'delete');

  // local-only requests
  const req = (headers, method = 'GET') => ({ method, headers });
  const host = 'localhost:' + cfg.port;
  check(app.isLocalRequest(req({ host })), 'accepts a local GET');
  check(!app.isLocalRequest(req({ host: 'evil.example:' + cfg.port })), 'rejects a foreign Host (DNS rebinding)');
  check(!app.isLocalRequest(req({ host, origin: 'https://evil.example', 'content-type': 'application/json' }, 'POST')), 'rejects a cross-site POST');
  check(!app.isLocalRequest(req({ host, 'content-type': 'text/plain' }, 'POST')), 'rejects a non-JSON POST');

  // HTTP round trip
  await new Promise((r) => app.server.listen(cfg.port, '127.0.0.1', r));
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: cfg.port, path: '/api/sessions', headers: { host } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  check(body.profiles.length === 2 && body.sessions.p1.length === 1, 'GET /api/sessions');
  app.server.close();

  fs.rmSync(fakeHome, { recursive: true, force: true });
  console.log(failed ? '\n' + failed + ' failure(s)' : '\nall good');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
