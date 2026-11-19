import type { MaterialCookError } from '@forgeax/engine-shader-compiler';
import type { MaterialError } from '@forgeax/engine-types';
import { toRollupLog } from '../wrap.js';

export {
  engineMaterialParamSchema,
  filterImportsByDefines,
  resolveImportModuleId,
} from '@forgeax/engine-shader-compiler';

export function throwAuthoredMaterialError(error: MaterialCookError | MaterialError): never {
  if (error instanceof Error) {
    const log = toRollupLog(error);
    throw Object.assign(new Error(error.message), log);
  }
  throw Object.assign(new Error(error.message), {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
    meta: {
      expected: error.expected,
      hint: error.hint,
      detail: error.detail,
    },
  });
}
