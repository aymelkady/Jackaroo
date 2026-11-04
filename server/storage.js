// Tiny JSON-file persistence: one file per game, written atomically.
import fs from 'node:fs';
import path from 'node:path';

export class Storage {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  file(code) {
    if (!/^[A-Z0-9]{3,12}$/.test(code)) throw new Error('bad code');
    return path.join(this.dir, `${code}.json`);
  }
  exists(code) {
    try { return fs.existsSync(this.file(code)); } catch { return false; }
  }
  load(code) {
    try {
      return JSON.parse(fs.readFileSync(this.file(code), 'utf8'));
    } catch {
      return null;
    }
  }
  save(code, record) {
    const f = this.file(code);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, f);
  }
}
