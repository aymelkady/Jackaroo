import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex, randomInt, randomHex } from '../shared/rng.js';

test('sha256Hex matches node:crypto on assorted inputs', () => {
  const inputs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000), 'salt:A♠,K♥,JOKER', 'مرحبا jackaroo 🎉'];
  for (const s of inputs) assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'), JSON.stringify(s.slice(0, 20)));
});

test('randomInt stays in range and covers it', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) { const v = randomInt(3, 9); assert.ok(v >= 3 && v < 9); seen.add(v); }
  assert.equal(seen.size, 6);
  assert.throws(() => randomInt(5, 5));
  assert.match(randomHex(16), /^[0-9a-f]{32}$/);
});
