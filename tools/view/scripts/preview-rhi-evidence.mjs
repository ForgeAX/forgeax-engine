import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Preserve the failed preview's existing native recorder evidence before its owner retires. */
export async function savePreviewRhiEvidence({ target, observation, captureRoot, evidence }) {
  const result = {
    status: 'unavailable',
    target,
    observation,
    seed: 'omitted',
    evidence: 'commands-and-bindings',
  };
  if (!target) result.reason = 'no-failed-preview-capture';
  else if (!observation) result.reason = 'native-window-unavailable';
  else if (observation.targetId !== target.targetId || observation.worldIdentity !== target.worldId) {
    result.reason = 'native-window-owner-mismatch';
  } else if (observation.status !== 'uploaded' || observation.artifact?.kind !== 'rhi-tape') {
    result.reason = 'native-window-not-uploaded';
  } else {
    try {
      const source = await realpath(observation.artifact.path);
      const root = await realpath(join(captureRoot, '.forgeax-debug'));
      const path = relative(root, source);
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
        throw new Error('Native preview artifact is outside the native capture output');
      }
      const bytes = await readFile(source);
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (digest !== observation.artifact.digest || bytes.byteLength !== observation.artifact.bytes) {
        throw new Error('Native preview artifact bytes differ from its ArtifactRef');
      }
      const savedPath = join(evidence, 'failure-preview.rhitape');
      await writeFile(savedPath, bytes);
      result.status = 'saved';
      result.artifact = { ...observation.artifact, path: savedPath };
    } catch (error) {
      result.reason = 'native-artifact-preservation-failed';
      result.error = { name: error.name, message: error.message, ...(error.code ? { code: error.code } : {}) };
    }
  }
  await writeFile(join(evidence, 'failure-preview-rhi.json'), JSON.stringify(result, null, 2));
  return result;
}
