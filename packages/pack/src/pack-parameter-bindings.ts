import { err, ok, type Result } from '@forgeax/engine-types';
import type {
  AnyScriptablePackDefinition,
  PackAuthoringError,
  PackBuildContextWithoutParameters,
  PackOutputMap,
  PackParameterDefinition,
  PackParameterValue,
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

/** Shared by offline and runtime producers; user build functions stay unchanged. */
export async function executePackBuild(
  definition: AnyScriptablePackDefinition,
  context: PackBuildContextWithoutParameters & {
    readonly values?: Readonly<Record<string, PackParameterValue>>;
  },
): Promise<Result<PackOutputMap, unknown>> {
  const parameters = 'parameters' in definition ? definition.parameters : [];
  if (!parameters.some((parameter) => typeof parameter.apply === 'object')) {
    return definition.build(context as never);
  }
  const values = context.values ?? {};
  const generated = await definition.build({
    ...context,
    values: packGenerationValues(parameters, values),
  } as never);
  if (!generated?.ok) return generated;
  return applyPackParameterBindings(parameters, generated.value, values);
}
