import { shaderSourceForDescriptor } from '@forgeax/engine-types';
import { RhiError } from './errors';
import { PIPELINE_LIBRARY_LIMITS, type PipelineLibraryLimits } from './pipeline-library';

export function pipelineLibraryLimits(input: PipelineLibraryLimits = {}) {
  const limits = { ...PIPELINE_LIBRARY_LIMITS, ...input };
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error('Pipeline library action limits must be positive finite integers');
  return limits;
}

export function pipelineLibraryLimit(
  operation: 'export' | 'input',
  limit: keyof typeof PIPELINE_LIBRARY_LIMITS,
  requested: number,
  maximum: number,
): void {
  if (requested <= maximum) return;
  throw new RhiError({
    code: 'limit-exceeded',
    expected: 'the complete pipeline library to fit this action policy',
    hint: `Increase this ${operation} action's ${limit} limit or provide a smaller complete input.`,
    detail: { kind: 'pipeline-library-limit', operation, limit, requested, maximum },
  });
}

/** Conservative JSON/clone estimate before materializing source or cloning.
 * Six bytes per UTF-16 unit covers escaping and UTF-8, including split pairs.
 * The estimate includes eight complete representations for Worker/CLI transport;
 * it is a logical allocation bound, not a process-memory limit. */
export function checkPipelineLibraryAllocation(
  value: unknown,
  operation: 'export' | 'input',
  policy?: PipelineLibraryLimits,
): void {
  const limits = pipelineLibraryLimits(policy);
  let output = 0;
  const add = (bytes: number) => {
    output += bytes;
    pipelineLibraryLimit(operation, 'outputBytes', output, limits.outputBytes);
    pipelineLibraryLimit(operation, 'temporaryBytes', output * 8, limits.temporaryBytes);
  };
  const visit = (node: unknown, depth: number): void => {
    if (depth > 24) throw new Error('Pipeline descriptor nesting exceeds 24');
    if (typeof node === 'string') {
      add(2 + node.length * 6);
      return;
    }
    if (node === null || typeof node !== 'object') {
      add(32);
      return;
    }
    add(2);
    if (Array.isArray(node)) {
      pipelineLibraryLimit(operation, 'entries', node.length, limits.entries);
      for (let i = 0; i < node.length; i++) {
        const item = Object.getOwnPropertyDescriptor(node, String(i));
        if (item === undefined || !('value' in item))
          throw new Error('Pipeline array requires data slots');
        add(1);
        visit(item.value, depth + 1);
      }
      return;
    }
    const source = shaderSourceForDescriptor(node);
    for (const key of Object.keys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (
        descriptor !== undefined &&
        !('value' in descriptor) &&
        !(key === 'code' && source !== undefined)
      )
        throw new Error('Pipeline manifest requires plain data or an admitted source reference');
      add(key.length * 6 + 4);
      if (key === 'code' && source !== undefined) add(source.length * 6 + 2);
      else visit((node as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(value, 0);
}
