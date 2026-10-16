import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function retainNativeEvidence(output, name, row) {
  if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error('invalid native evidence name');
  if (row.wavBase64 !== undefined) {
    if (!Number.isSafeInteger(row.wavOffset) || row.wavOffset < 0 ||
        typeof row.wavBase64 !== 'string' || row.wavBase64.length > 4 * Math.ceil(1024 * 1024 / 3))
      throw new Error('native PCM retention requires a bounded ordered chunk');
    const bytes = Buffer.from(row.wavBase64, 'base64');
    if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('native PCM retention chunk size');
    const file = await open(resolve(output, `${name}.wav`), row.wavOffset === 0 ? 'wx' : 'r+');
    try {
      if ((await file.stat()).size !== row.wavOffset) throw new Error('native PCM retention offset mismatch');
      let written = 0;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, row.wavOffset + written);
        if (!result.bytesWritten) throw new Error('native PCM retention write made no progress');
        written += result.bytesWritten;
      }
    } finally { await file.close(); }
    return;
  }
  if (row.wav) { await writeFile(resolve(output, `${name}.wav`), new Uint8Array(row.wav)); delete row.wav; }
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(row, null, 2));
}
