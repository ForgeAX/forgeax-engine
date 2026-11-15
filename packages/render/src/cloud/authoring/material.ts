import { AssetGuid } from '@forgeax/engine-pack/guid';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { CloudMaterialSource, CloudParameter, CloudParameterValue } from '../contracts';
import {
  type CloudAuthoringError,
  type CloudAuthoringLocation,
  cloudAuthoringError,
} from '../errors';

export const CLOUD_PARAMETER_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const reservedParameters = new Set([
  'positionMeters',
  'cameraRelativeMeters',
  'windOffsetMeters',
  'heightFraction',
  'sampleDxMeters',
  'sampleDyMeters',
  '__proto__',
  'constructor',
]);

export function cloudRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cloudFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function cloudGuid(value: unknown): value is string {
  return typeof value === 'string' && AssetGuid.parse(value).ok;
}

function vectorInRange(value: unknown, length: number, lower: number, upper: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((v) => cloudFinite(v) && v >= lower && v <= upper)
  );
}

export function cloudParameterValueMatches(parameter: CloudParameter, value: unknown): boolean {
  switch (parameter.kind) {
    case 'scalar':
      return (
        cloudFinite(value) &&
        (parameter.range === undefined ||
          (value >= parameter.range[0] && value <= parameter.range[1]))
      );
    case 'vector':
      return vectorInRange(value, parameter.default.length, -Infinity, Infinity);
    case 'static':
      return typeof value === 'boolean';
    case 'texture':
      return cloudGuid(value);
  }
}

function validScalarDefinition(value: Record<string, unknown>): boolean {
  if (typeof value.unit !== 'string' || !['m', 'm/s', 'm^-1', 'unitless'].includes(value.unit))
    return false;
  if (
    value.range !== undefined &&
    (!Array.isArray(value.range) ||
      value.range.length !== 2 ||
      !cloudFinite(value.range[0]) ||
      !cloudFinite(value.range[1]) ||
      value.range[0] > value.range[1])
  )
    return false;
  if (
    value.unit === 'm^-1' &&
    (!cloudFinite(value.default) ||
      value.default < 0 ||
      (Array.isArray(value.range) && Number(value.range[0]) < 0))
  )
    return false;
  return true;
}

function validParameterMetadata(value: Record<string, unknown>): boolean {
  for (const key of ['label', 'group']) {
    const entry = value[key];
    if (entry !== undefined && (typeof entry !== 'string' || !entry.trim() || entry.length > 128)) {
      return false;
    }
  }
  return true;
}

function parameterDefinition(value: unknown): value is CloudParameter {
  if (!cloudRecord(value)) return false;
  if (!validParameterMetadata(value)) return false;
  switch (value.kind) {
    case 'scalar':
      if (!validScalarDefinition(value)) return false;
      break;
    case 'vector':
      if (
        !vectorInRange(value.default, 3, -Infinity, Infinity) &&
        !vectorInRange(value.default, 4, -Infinity, Infinity)
      )
        return false;
      break;
    case 'static':
      break;
    case 'texture':
      if (
        (value.dimension !== '2d' && value.dimension !== '3d') ||
        (value.colorSpace !== 'linear' && value.colorSpace !== 'srgb') ||
        !cloudFinite(value.mipLevels) ||
        !Number.isSafeInteger(value.mipLevels) ||
        value.mipLevels < 1
      )
        return false;
      break;
    default:
      return false;
  }
  return cloudParameterValueMatches(value as CloudParameter, value.default);
}

function invalidUniformSample(sample: unknown): [string, string] | undefined {
  if (!cloudRecord(sample)) return ['model.sample', 'expected a medium sample'];
  if (!cloudFinite(sample.extinctionPerMeter) || sample.extinctionPerMeter < 0) {
    return [
      'model.sample.extinctionPerMeter',
      'expected nonnegative finite extinction in inverse meters',
    ];
  }
  if (!vectorInRange(sample.albedo, 3, 0, 1))
    return ['model.sample.albedo', 'expected linear RGB in [0, 1]'];
  if (!vectorInRange(sample.emissivePerMeter, 3, 0, Infinity)) {
    return ['model.sample.emissivePerMeter', 'expected finite nonnegative RGB in inverse meters'];
  }
  if (!cloudFinite(sample.materialAO) || sample.materialAO < 0 || sample.materialAO > 1) {
    return ['model.sample.materialAO', 'expected ambient occlusion in [0, 1]'];
  }
  return undefined;
}

export function validateCloudMaterial(
  value: unknown,
  location: CloudAuthoringLocation,
): Result<CloudMaterialSource, CloudAuthoringError> {
  const fail = (field: string, reason: string) =>
    err(cloudAuthoringError('cloud-material-invalid', location, field, reason));
  if (!cloudRecord(value) || value.version !== 1)
    return fail('version', 'expected cloud material version 1');
  const model = value.model;
  if (!cloudRecord(model)) return fail('model', 'expected a uniform or program model');
  if (model.kind === 'uniform') {
    const invalid = invalidUniformSample(model.sample);
    if (invalid !== undefined) return fail(...invalid);
  } else if (model.kind === 'program') {
    if (typeof model.source !== 'string' || !/^[a-zA-Z0-9_-]+\.wgsl$/.test(model.source)) {
      return fail('model.source', 'expected a sibling WGSL filename');
    }
  } else {
    return fail('model.kind', 'expected a uniform or program model');
  }
  if (!cloudRecord(value.parameters)) return fail('parameters', 'expected a parameter record');
  let staticCount = 0;
  for (const [name, parameter] of Object.entries(value.parameters)) {
    if (
      !CLOUD_PARAMETER_NAME.test(name) ||
      reservedParameters.has(name) ||
      !parameterDefinition(parameter)
    ) {
      return fail(
        `parameters.${name}`,
        'invalid public parameter name, default, range, unit, or texture declaration',
      );
    }
    if (parameter.kind === 'static') staticCount++;
  }
  if (staticCount > 4) return fail('parameters', 'at most four static switches are allowed');
  if (model.kind === 'uniform' && Object.keys(value.parameters).length !== 0) {
    return fail('parameters', 'a uniform model authors its medium sample directly');
  }
  return ok(structuredClone(value) as unknown as CloudMaterialSource);
}

export function resolveCloudParameters(
  parameters: Readonly<Record<string, CloudParameter>>,
  overrides: unknown,
  location: CloudAuthoringLocation,
): Result<Readonly<Record<string, CloudParameterValue>>, CloudAuthoringError> {
  const fail = (field: string, reason: string) =>
    err(cloudAuthoringError('cloud-material-invalid', location, field, reason));
  if (!cloudRecord(overrides)) return fail('overrides', 'expected a public parameter record');
  for (const [name, value] of Object.entries(overrides)) {
    const parameter = Object.hasOwn(parameters, name) ? parameters[name] : undefined;
    if (
      !parameter ||
      !cloudParameterValueMatches(parameter, value) ||
      (parameter.kind === 'scalar' && parameter.unit === 'm^-1' && Number(value) < 0)
    ) {
      return fail(`overrides.${name}`, 'invalid public parameter value or undeclared parameter');
    }
  }
  return ok(
    Object.fromEntries(
      Object.entries(parameters).map(([name, parameter]) => [
        name,
        structuredClone(
          (Object.hasOwn(overrides, name)
            ? overrides[name]
            : parameter.default) as CloudParameterValue,
        ),
      ]),
    ),
  );
}
