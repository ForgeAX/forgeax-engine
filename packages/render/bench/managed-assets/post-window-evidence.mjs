import { appendFile, mkdir, open, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

/** Diagnostic-only disk owner, created after the final measured completion. */
export async function createPostWindowEvidence(prefix) {
  await mkdir(dirname(prefix), { recursive: true });
  const writes = [], errors = [];
  let events = Promise.resolve();
  const enqueue = promise => {
    const guarded = promise.catch(error => { errors.push(error); });
    writes.push(guarded);
    return guarded;
  };
  const event = value => {
    const line = JSON.stringify({ at: new Date().toISOString(), hostMs: performance.now(), ...value }) + '\n';
    events = events.then(() => appendFile(prefix + '.events.ndjson', line));
    enqueue(events);
  };
  const save = (suffix, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const receipt = { path: prefix + '.' + suffix, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    enqueue(writeFile(receipt.path, bytes));
    return receipt;
  };
  const saveRows = (suffix, rows) => enqueue((async () => {
    const file = await open(prefix + '.' + suffix, 'w');
    let batch = '';
    try {
      for (const row of rows) {
        const line = JSON.stringify(row) + '\n';
        if (batch.length + line.length > 65536) { await file.writeFile(batch); batch = ''; }
        batch += line;
      }
      if (batch) await file.writeFile(batch);
    } finally { await file.close(); }
  })());
  return {
    event, save, saveRows,
    async flush() {
      await Promise.all(writes);
      if (errors.length) throw new AggregateError(errors, 'Post-window evidence writes failed');
    },
  };
}
