// Persistence. Two backends, same async interface: load(code) -> record|null, save(code, record), exists(code).
//
//  FileStorage   one JSON file per game, written atomically. Default. Fine on a laptop or a host with a disk.
//  RedisStorage  Upstash Redis over its REST API (no client library needed). Use it on free hosts whose disk is
//                wiped on every restart (Render free, Koyeb, Railway...). Set UPSTASH_REDIS_REST_URL and
//                UPSTASH_REDIS_REST_TOKEN and games survive deploys and spin-downs.
import fs from 'node:fs';
import path from 'node:path';

const CODE_RE = /^[A-Z0-9]{3,12}$/;

export class FileStorage {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  file(code) {
    if (!CODE_RE.test(code)) throw new Error('bad code');
    return path.join(this.dir, `${code}.json`);
  }
  async exists(code) {
    try { return fs.existsSync(this.file(code)); } catch { return false; }
  }
  async load(code) {
    try { return JSON.parse(fs.readFileSync(this.file(code), 'utf8')); } catch { return null; }
  }
  async save(code, record) {
    const f = this.file(code);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, f);
  }
  describe() { return `files in ${this.dir}`; }
}

export class RedisStorage {
  constructor(url, token, { prefix = 'jackaroo:', ttlDays = 30 } = {}) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.prefix = prefix;
    this.ttl = ttlDays * 86400;
  }
  key(code) {
    if (!CODE_RE.test(code)) throw new Error('bad code');
    return this.prefix + code;
  }
  async cmd(...args) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`redis ${res.status}: ${await res.text()}`);
    const j = await res.json();
    if (j.error) throw new Error(`redis: ${j.error}`);
    return j.result;
  }
  async exists(code) { return (await this.cmd('EXISTS', this.key(code))) === 1; }
  async load(code) {
    const v = await this.cmd('GET', this.key(code));
    return v ? JSON.parse(v) : null;
  }
  async save(code, record) {
    await this.cmd('SET', this.key(code), JSON.stringify(record), 'EX', this.ttl);
  }
  describe() { return `Upstash Redis at ${this.url}`; }
}

export function storageFromEnv(env = process.env, defaultDir) {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return new RedisStorage(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }
  return new FileStorage(env.DATA_DIR || defaultDir);
}
