// Regression test for the failure mode that actually bit: notify advanced its
// state before confirming delivery, so events detected while the webhook was
// misconfigured were marked seen and could never alert again.
//
// Run with: node --test scripts/notify.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs');

const EVENT = (guid, category) => ({
  guid, metro: 'bay-area', category, typeName: category,
  name: `Test ${category}`, venue: 'TEST STORE',
  address: '1 MAIN ST, SUNNYVALE, CA 94087, US',
  start: '2026-10-10T11:00:00', date: '2026-10-10',
  admission: '25', format: 'Standard', attributes: [],
  website: '', registrationSite: '', email: '', phone: '',
});

async function fixture(seen) {
  const dir = await mkdtemp(path.join(tmpdir(), 'notify-test-'));
  const dataPath = path.join(dir, 'data.json');
  const seenPath = path.join(dir, 'seen.json');
  await writeFile(dataPath, JSON.stringify({
    from: '2026-09-30', to: '2026-11-29',
    events: [EVENT('guid-a', 'cup'), EVENT('guid-b', 'prerelease')],
  }));
  await writeFile(seenPath, JSON.stringify(seen));
  return { dir, dataPath, seenPath };
}

function run({ dataPath, seenPath, webhook }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        NOTIFY_DATA: dataPath,
        NOTIFY_STATE: seenPath,
        DISCORD_WEBHOOK: webhook ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

test('an unsent alert does not advance state', async (t) => {
  const { dir, dataPath, seenPath } = await fixture({});
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { code, out } = await run({ dataPath, seenPath, webhook: '' });

  assert.equal(code, 1, 'should exit non-zero so the misconfiguration is visible');
  assert.match(out, /state NOT advanced/);
  const after = JSON.parse(await readFile(seenPath, 'utf8'));
  assert.deepEqual(after, {}, 'state must be untouched when nothing was delivered');
});

test('state advances only after Discord accepts the post', async (t) => {
  const { dir, dataPath, seenPath } = await fixture({});
  const received = [];
  const server = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { received.push(JSON.parse(b)); res.writeHead(204).end(); });
  });
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); return rm(dir, { recursive: true, force: true }); });

  const { code } = await run({
    dataPath, seenPath, webhook: `http://localhost:${server.address().port}/hook`,
  });

  assert.equal(code, 0);
  assert.equal(received.length, 1, 'both events batch into one message');
  assert.equal(received[0].embeds[0].fields.length, 2);
  const after = JSON.parse(await readFile(seenPath, 'utf8'));
  assert.deepEqual(Object.keys(after).sort(), ['guid-a', 'guid-b']);
});

test('a rejected post leaves state untouched for the next run', async (t) => {
  const { dir, dataPath, seenPath } = await fixture({});
  const server = createServer((_, res) => res.writeHead(400).end('bad webhook'));
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); return rm(dir, { recursive: true, force: true }); });

  const { code } = await run({
    dataPath, seenPath, webhook: `http://localhost:${server.address().port}/hook`,
  });

  assert.equal(code, 1);
  const after = JSON.parse(await readFile(seenPath, 'utf8'));
  assert.deepEqual(after, {}, 'a 400 from Discord must not mark events seen');
});

test('the first run seeds silently instead of firing a backlog', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notify-test-'));
  const dataPath = path.join(dir, 'data.json');
  const seenPath = path.join(dir, 'missing.json'); // no state file yet
  await writeFile(dataPath, JSON.stringify({
    from: '2026-09-30', to: '2026-11-29',
    events: [EVENT('guid-a', 'cup'), EVENT('guid-b', 'prerelease')],
  }));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { code, out } = await run({ dataPath, seenPath, webhook: 'http://127.0.0.1:1/hook' });

  assert.equal(code, 0, 'seeding must not attempt delivery');
  assert.match(out, /Seeded notification state with 2/);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(seenPath, 'utf8'))).sort(), ['guid-a', 'guid-b']);
});
