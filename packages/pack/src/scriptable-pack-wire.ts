import type { PackParameterList, ScriptablePackDefinition } from './pack-authoring.js';

const definitionFields = [
  'schemaVersion',
  'packageId',
  'name',
  'parameters',
  'sceneComponents',
  'runtime',
  'build',
] as const satisfies readonly (keyof ScriptablePackDefinition<PackParameterList>)[];
const declaredFields = new Set<string>(definitionFields);

/** Admission and worker projection use the same authored vocabulary. */
export function isScriptablePackField(name: string): boolean {
  return declaredFields.has(name);
}

export interface StructuredFailure {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly hint?: unknown;
  readonly detail?: unknown;
  readonly message?: unknown;
}

/** Preserve structured diagnostics across either direction of the worker port. */
export function projectFailure(value: object): StructuredFailure {
  const failure = value as Record<string, unknown>;
  return {
    name: failure.name,
    code: failure.code,
    expected: failure.expected,
    actual: failure.actual,
    hint: failure.hint,
    detail: failure.detail,
    message: failure.message,
  };
}
