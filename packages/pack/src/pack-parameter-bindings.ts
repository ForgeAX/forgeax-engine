import { err, ok, type Result } from '@forgeax/engine-types';
import type {
  AnyScriptablePackDefinition,
  PackAuthoringError,
  PackBuildContextWithoutParameters,
  PackOutputMap,
  PackParameterDefinition,
  PackParameterValue,
  ScriptablePackRuntimeOutputs,
} from './pack-authoring.js';

/** Only opted-in live parameters are withheld. Legacy contexts retain their exact shape. */
export function packGenerationValues(
  parameters: readonly PackParameterDefinition[],
  values: Readonly<Record<string, PackParameterValue>>,
): Readonly<Record<string, PackParameterValue>> {
  if (!parameters.some((parameter) => typeof parameter.apply === 'object')) return values;
  return Object.fromEntries(
    parameters
      .filter((parameter) => typeof parameter.apply !== 'object')
      .map((parameter) => {
        const value = values[parameter.name];
        if (value === undefined) throw new TypeError(`Missing generation value ${parameter.name}`);
        return [parameter.name, value];
      }),
  );
}

function bindingError(parameter: PackParameterDefinition, reason: string): PackAuthoringError {
  return {
    code: 'pack-parameter-invalid',
    expected: 'one live parameter supplying an unassigned field in a generated asset',
    hint: 'keep the containing objects in build output and remove the independent leaf assignment',
    detail: { parameter: parameter.name, binding: parameter.apply, reason },
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !ArrayBuffer.isView(value);
}

/** Copy touched paths only. Large untouched payloads retain their identity. */
export function applyPackParameterBindings(
  parameters: readonly PackParameterDefinition[],
  outputs: PackOutputMap,
  values: Readonly<Record<string, PackParameterValue>>,
): Result<PackOutputMap, PackAuthoringError> {
  let result = outputs;
  for (const parameter of parameters) {
    const binding = parameter.apply;
    if (binding === undefined || binding === 'build') continue;
    const path = [binding.asset, ...binding.path];
    let cursor: unknown = result;
    const parents: Array<[Record<string, unknown>, string]> = [];
    for (const [index, part] of path.entries()) {
      if (!object(cursor) || ['__proto__', 'prototype', 'constructor'].includes(part)) {
        return err(
          bindingError(
            parameter,
            `missing or unsupported container at ${path.slice(0, index).join('.')}`,
          ),
        );
      }
      parents.push([cursor, part]);
      const present = Object.hasOwn(cursor, part);
      if (index === path.length - 1) {
        if (present)
          return err(bindingError(parameter, 'the target field already has an author value'));
      } else if (!present) {
        return err(bindingError(parameter, `missing target ${path.slice(0, index + 1).join('.')}`));
      }
      cursor = cursor[part];
    }
    if (!Object.hasOwn(values, parameter.name))
      return err(bindingError(parameter, 'missing effective parameter value'));
    let updated: unknown = structuredClone(values[parameter.name]);
    for (const [parent, part] of parents.reverse()) {
      const copy = Array.isArray(parent) ? [...parent] : { ...parent };
      (copy as Record<string, unknown>)[part] = updated;
      updated = copy;
    }
    result = updated as PackOutputMap;
  }
  return ok(result);
}

export function validatePhaseOutputs(
  generated: PackOutputMap,
  declared: ScriptablePackRuntimeOutputs,
  phase: 'build' | 'runtime',
): Result<PackOutputMap, PackAuthoringError> {
  if (!object(generated) || Array.isArray(generated)) {
    return err({
      code: 'pack-parameter-invalid',
      expected: 'an asset output record',
      hint: 'return the generated assets in the successful Result value',
      detail: { phase },
    });
  }
  const mismatch =
    Object.keys(generated).find((key) => Object.hasOwn(declared, key) === (phase === 'build')) ??
    (phase === 'runtime'
      ? Object.keys(declared).find(
          (key) => !Object.hasOwn(generated, key) || generated[key]?.kind !== declared[key],
        )
      : undefined);
  if (mismatch === undefined) return ok(generated);
  return err({
    code: 'pack-parameter-invalid',
    expected:
      phase === 'build'
        ? 'build output keys distinct from runtime output declarations'
        : 'the exact declared runtime output keys and asset kinds',
    hint: 'keep each output key in its declared generation phase',
    detail: { sourceKey: mismatch, phase },
  });
}

/** Shared by offline and runtime producers; user build functions stay unchanged. */
export async function executePackBuild(
  definition: AnyScriptablePackDefinition,
  context: PackBuildContextWithoutParameters & {
    readonly values?: Readonly<Record<string, PackParameterValue>>;
  },
  phase: 'build' | 'runtime' = 'build',
): Promise<Result<PackOutputMap, unknown>> {
  const parameters = 'parameters' in definition ? definition.parameters : [];
  const declared = definition.runtime?.outputs;
  const hasBindings = parameters.some((parameter) => typeof parameter.apply === 'object');
  if (!hasBindings && declared === undefined) return definition.build(context as never);

  const values = context.values ?? {};
  const generated = await definition.build(
    (hasBindings
      ? { ...context, values: packGenerationValues(parameters, values) }
      : context) as never,
  );
  if (!generated?.ok) return generated;
  if (declared !== undefined) {
    const checked = validatePhaseOutputs(generated.value, declared, phase);
    if (!checked.ok) return checked;
  }
  if (!hasBindings) return generated;
  const bindings =
    declared === undefined
      ? parameters
      : parameters.filter(
          (parameter) =>
            typeof parameter.apply === 'object' &&
            Object.hasOwn(declared, parameter.apply.asset) === (phase === 'runtime'),
        );
  return applyPackParameterBindings(bindings, generated.value, values);
}
