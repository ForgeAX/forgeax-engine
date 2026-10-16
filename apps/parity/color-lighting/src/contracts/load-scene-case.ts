import { readFile } from 'node:fs/promises';
import type { SceneCase, ValidationError, ValidationResult } from './types';
import { validateSceneCase } from './validate-scene-case';

export { validateSceneCase } from './validate-scene-case';

function invalid(error: ValidationError): ValidationResult<SceneCase> {
  return { ok: false, error };
}

export async function loadSceneCase(path: string): Promise<ValidationResult<SceneCase>> {
  try {
    const raw = await readFile(path, 'utf8');
    return validateSceneCase(JSON.parse(raw) as unknown);
  } catch (error) {
    return invalid({
      code: 'file-read-failed',
      expected: 'a readable JSON SceneCase file',
      hint: 'check the case path and rerun the named case',
      detail: { path: [path], message: error instanceof Error ? error.message : String(error) },
    });
  }
}
