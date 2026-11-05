import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStorage, RedisStorage, storageFromEnv } from '../server/storage.js';

// Minimal stand-in for the Upstash REST API: POST ["CMD", ...args] -> {result}
const kv = new Map();
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.headers.authorization !== 'Bearer secret') { res.writeHead(401); return res.end('{"error":"Unauthorized"}'); }
    const [cmd, key, val] = JSON.parse(body);
    let result = null;
    if (cmd === 'SET') { kv.set(key, val); result = 'OK'; }
    else if (cmd === 'GET') result = kv.get(key) ?? null;
    else if (cmd === 'EXISTS') result = kv.has(key) ? 1 : 0;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result }));
  });
});
await new Promise((r) => mock.listen(0, r));
const url = `http://127.0.0.1:${mock.address().port}`;
after(() => mock.close());

test('FileStorage round-trips and rejects bad codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jk-'));
  const st = new FileStorage(dir);
  assert.equal(await st.exists('ABCDE'), false);
  await st.save('ABCDE', { state: { code: 'ABCDE' }, tokens: { t: 'p' } });
  assert.equal(await st.exists('ABCDE'), true);
  assert.deepEqual(await st.load('ABCDE'), { state: { code: 'ABCDE' }, tokens: { t: 'p' } });
  await assert.rejects(() => st.save('../x', {}));
});

test('RedisStorage talks to the Upstash REST shape', async () => {
  const st = new RedisStorage(url, 'secret');
  assert.equal(await st.exists('QQQQQ'), false);
  await st.save('QQQQQ', { state: { code: 'QQQQQ', phase: 'lobby' }, tokens: {} });
  assert.equal(await st.exists('QQQQQ'), true);
  assert.equal((await st.load('QQQQQ')).state.phase, 'lobby');
  assert.equal(await st.load('NOPE1'), null);
  const bad = new RedisStorage(url, 'wrong');
  await assert.rejects(() => bad.load('QQQQQ'), /401/);
});

test('storageFromEnv picks Redis only when both variables are set', () => {
  assert.ok(storageFromEnv({ UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: 'x' }, '/tmp/x') instanceof RedisStorage);
  assert.ok(storageFromEnv({ UPSTASH_REDIS_REST_URL: url }, os.tmpdir()) instanceof FileStorage);
});
