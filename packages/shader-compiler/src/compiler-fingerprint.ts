import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getCompilerFingerprint } from '@forgeax/engine-naga';
import { err, initFailed, ok } from './errors.js';

/** Build-time identity of the public compiler, its native adapter and verified payload. */
export async function getShaderCompilerFingerprint() {
  const native = await getCompilerFingerprint();
  if (!native.ok) return native;
  try {
    const hash = createHash('sha256').update('shader-compiler/1\0').update(native.value);
    for (const url of [import.meta.url, import.meta.resolve('@forgeax/engine-naga')])
      hash.update('\0').update(await readFile(fileURLToPath(url)));
    return ok(`sha256:${hash.digest('hex')}`);
  } catch (cause) {
    return err(
      initFailed({
        message: 'Shader compiler identity is unavailable',
        reason: cause instanceof Error ? cause.message : String(cause),
        hint: 'repair the installed compiler before reusing compiled products',
      }),
    );
  }
}
