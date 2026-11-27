import { AssetGuid } from './guid.js';
import type {
  PackParameterDefinition,
  PackParameterList,
  PackParameterValue,
  ScriptablePackDefinition,
} from './pack-authoring.js';

const definitionFields = [
  'schemaVersion',
  'packageId',
  'name',
  'plugins',
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

export interface ScriptablePackPackageBinding {
  readonly name: string;
  readonly root: string;
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

export function projectPackParameters(parameters: readonly PackParameterDefinition[]) {
  return parameters.map((parameter) => ({
    name: parameter.name,
    type: parameter.type,
    default: jsonParameterValue(parameter.default),
    ...(parameter.minimum === undefined ? {} : { minimum: parameter.minimum }),
    ...(parameter.maximum === undefined ? {} : { maximum: parameter.maximum }),
    ...(parameter.values === undefined ? {} : { values: parameter.values }),
    ...(parameter.kind === undefined ? {} : { kind: parameter.kind }),
    ...(parameter.apply === undefined ? {} : { apply: parameter.apply }),
  }));
}

function jsonParameterValue(value: PackParameterValue): unknown {
  return value instanceof Uint8Array
    ? AssetGuid.format(value)
    : Array.isArray(value)
      ? [...value]
      : value;
}
