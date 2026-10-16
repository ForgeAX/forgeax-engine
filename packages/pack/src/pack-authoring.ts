import type { Asset, AssetGuid, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import {
  AssetGuid as AssetGuidCodec,
  isValidAssetGuidString,
  isValidPackSourceKey,
  PackageId,
} from './guid.js';
import {
  lowerPluginConfig,
  type PluginAssetSource,
  validatePluginAssetSource,
} from './plugin-asset.js';
import type { ScriptablePackSceneComponentInput } from './scriptable-pack.js';
import { isScriptablePackField } from './scriptable-pack-wire.js';

/** Values deliberately stay finite and serialisable at the authoring boundary. */
export type PackParameterScalar = boolean | number | string;
export type PackParameterValue = PackParameterScalar | readonly number[] | AssetGuid;

export type PackParameterType =
  | 'bool'
  | 'u32'
  | 'i32'
  | 'f32'
  | 'f64'
  | 'string'
  | 'enum'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'color'
  | 'asset-guid';

export const PACK_PARAMETER_TYPES = [
  'bool',
  'u32',
  'i32',
  'f32',
  'f64',
  'string',
  'enum',
  'vec2',
  'vec3',
  'vec4',
  'color',
  'asset-guid',
] as const satisfies readonly PackParameterType[];

export interface PackParameterDefinition<
  TName extends string = string,
  TType extends PackParameterType = PackParameterType,
  TDefault extends PackParameterValue = PackParameterValue,
> {
  readonly name: TName;
  readonly type: TType;
  readonly default: TDefault;
  readonly minimum?: number;
  readonly maximum?: number;
  /** Closed choices are required for `enum` and forbidden for other types. */
  readonly values?: readonly PackParameterScalar[];
  /** Optional authoring-only kind constraint for asset GUID parameters. */
  readonly kind?: Asset['kind'];
}

export type PackParameterValueFor<T extends PackParameterType> = T extends 'bool'
  ? boolean
  : T extends 'u32' | 'i32' | 'f32' | 'f64'
    ? number
    : T extends 'string' | 'enum'
      ? string
      : T extends 'vec2'
        ? readonly [number, number]
        : T extends 'vec3'
          ? readonly [number, number, number]
          : T extends 'vec4' | 'color'
            ? readonly [number, number, number, number]
            : T extends 'asset-guid'
              ? AssetGuid
              : never;

export type PackParameterValues<TParameters extends readonly PackParameterDefinition[]> = Readonly<{
  [TParameter in TParameters[number] as TParameter['name']]: TParameter extends {
    readonly type: infer TType extends PackParameterType;
  }
    ? TType extends 'enum'
      ? TParameter extends { readonly values: readonly (infer TValue)[] }
        ? Extract<TValue, string>
        : string
      : PackParameterValueFor<TType>
    : never;
}>;

export interface PackAuthoringError {
  readonly code: PackAuthoringErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly actual?: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type PackAuthoringErrorCode =
  | 'pack-module-not-found'
  | 'pack-package-id-invalid'
  | 'pack-package-id-collision'
  | 'pack-source-key-invalid'
  | 'pack-guid-collision'
  | 'pack-parent-not-found'
  | 'pack-parent-cycle'
  | 'pack-parent-has-no-parameters'
  | 'pack-parameter-invalid'
  | 'pack-content-dependency-stalled'
  | 'pack-output-reference-missing'
  | 'pack-output-reference-conflict'
  | 'pack-output-not-materialized'
  | 'asset-not-ready'
  | 'pack-source-revision-conflict'
  | 'pack-source-path-invalid'
  | 'pack-source-not-found'
  | 'pack-source-mutation-unsupported'
  | 'pack-source-write-failed';

function authoringError(
  code: PackAuthoringErrorCode,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
  actual?: string,
): PackAuthoringError {
  return {
    code,
    expected,
    hint,
    ...(actual === undefined ? {} : { actual }),
    detail,
  };
}

function failure<T = never>(error: PackAuthoringError): Result<T, PackAuthoringError> {
  return err(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSceneComponents(
  value: unknown,
): Result<readonly ScriptablePackSceneComponentInput[] | undefined, PackAuthoringError> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value)) {
    return failure(
      parameterFailure(
        '$.sceneComponents',
        'an array of component schema records',
        value,
        'sceneComponents is not an array',
      ),
    );
  }
  const components: ScriptablePackSceneComponentInput[] = [];
  const names = new Set<string>();
  for (const [componentIndex, candidate] of value.entries()) {
    if (!isRecord(candidate) || typeof candidate.name !== 'string' || !isRecord(candidate.fields)) {
      return failure(
        parameterFailure(
          `$.sceneComponents[${componentIndex}]`,
          'a component record with name and fields',
          candidate,
          'scene component schema is malformed',
        ),
      );
    }
    if (candidate.name.length === 0 || names.has(candidate.name)) {
      return failure(
        parameterFailure(
          `$.sceneComponents[${componentIndex}].name`,
          'a non-empty unique component name',
          candidate.name,
          'scene component names must be unique',
        ),
      );
    }
    names.add(candidate.name);
    const fields: Record<string, string | { readonly type: string }> = {};
    for (const [fieldName, field] of Object.entries(candidate.fields)) {
      if (
        (typeof field === 'string' && field.length === 0) ||
        (typeof field !== 'string' &&
          (!isRecord(field) || typeof field.type !== 'string' || field.type.length === 0))
      ) {
        return failure(
          parameterFailure(
            `$.sceneComponents[${componentIndex}].fields.${fieldName}`,
            'a field type string or { type: string }',
            field,
            'scene component field schema is malformed',
          ),
        );
      }
      fields[fieldName] = field as string | { readonly type: string };
    }
    components.push({ name: candidate.name, fields });
  }
  return ok(components);
}

function isPackageId(value: unknown): value is PackageId {
  return value instanceof Uint8Array && value.byteLength === 16;
}

function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return value.slice() as T;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  return value;
}

function sourceKeyFailure(sourceKey: unknown, propertyPath = '$.sourceKey'): PackAuthoringError {
  return authoringError(
    'pack-source-key-invalid',
    'a sourceKey matching ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$',
    'use a stable lower-case semantic key; do not derive it from file paths or output order',
    { propertyPath, sourceKey },
    typeof sourceKey === 'string' ? sourceKey : undefined,
  );
}

function parameterFailure(
  propertyPath: string,
  expected: string,
  actual: unknown,
  reason: string,
): PackAuthoringError {
  return authoringError(
    'pack-parameter-invalid',
    expected,
    'repair the parameter declaration or the instance values, then inspect and rebuild',
    { propertyPath, reason, actual: typeof actual === 'string' ? actual : JSON.stringify(actual) },
  );
}

function numericType(type: PackParameterType): boolean {
  return type === 'u32' || type === 'i32' || type === 'f32' || type === 'f64';
}

function vectorLength(type: PackParameterType): number | undefined {
  switch (type) {
    case 'vec2':
      return 2;
    case 'vec3':
      return 3;
    case 'vec4':
    case 'color':
      return 4;
    default:
      return undefined;
  }
}

function parameterValueError(
  parameter: PackParameterDefinition,
  value: unknown,
  propertyPath: string,
): PackAuthoringError | undefined {
  const { type } = parameter;
  if (type === 'bool') {
    return typeof value === 'boolean'
      ? undefined
      : parameterFailure(propertyPath, 'a boolean', value, 'bool value has the wrong type');
  }
  if (numericType(type)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return parameterFailure(
        propertyPath,
        'a finite number',
        value,
        'numeric value is not finite',
      );
    }
    if ((type === 'u32' || type === 'i32') && !Number.isInteger(value)) {
      return parameterFailure(
        propertyPath,
        'an integer',
        value,
        'integer parameter received a fraction',
      );
    }
    if (type === 'u32' && (value < 0 || value > 0xffff_ffff)) {
      return parameterFailure(
        propertyPath,
        'an unsigned 32-bit integer',
        value,
        'u32 value is outside [0, 2^32 - 1]',
      );
    }
    if (type === 'i32' && (value < -0x8000_0000 || value > 0x7fff_ffff)) {
      return parameterFailure(
        propertyPath,
        'a signed 32-bit integer',
        value,
        'i32 value is outside [-2^31, 2^31 - 1]',
      );
    }
    if (type === 'f32' && !Number.isFinite(Math.fround(value))) {
      return parameterFailure(
        propertyPath,
        'a finite IEEE-754 32-bit float',
        value,
        'f32 value overflows binary32',
      );
    }
    if (parameter.minimum !== undefined && value < parameter.minimum) {
      return parameterFailure(
        propertyPath,
        `a number >= ${parameter.minimum}`,
        value,
        'value is below minimum',
      );
    }
    if (parameter.maximum !== undefined && value > parameter.maximum) {
      return parameterFailure(
        propertyPath,
        `a number <= ${parameter.maximum}`,
        value,
        'value is above maximum',
      );
    }
    return undefined;
  }
  if (type === 'string') {
    return typeof value === 'string'
      ? undefined
      : parameterFailure(propertyPath, 'a string', value, 'string parameter has the wrong type');
  }
  if (type === 'enum') {
    if (typeof value !== 'string') {
      return parameterFailure(
        propertyPath,
        'one of the declared enum strings',
        value,
        'enum value has the wrong type',
      );
    }
    if (parameter.values === undefined || !parameter.values.includes(value)) {
      return parameterFailure(
        propertyPath,
        'one of the declared enum values',
        value,
        'enum value is not declared',
      );
    }
    return undefined;
  }
  const length = vectorLength(type);
  if (length !== undefined) {
    if (
      !Array.isArray(value) ||
      value.length !== length ||
      value.some((component) => typeof component !== 'number' || !Number.isFinite(component))
    ) {
      return parameterFailure(
        propertyPath,
        `a finite numeric vector with ${length} components`,
        value,
        'vector value has the wrong shape',
      );
    }
    if (type === 'color' && value.some((component) => component < 0 || component > 1)) {
      return parameterFailure(
        propertyPath,
        'an RGBA color with components in [0, 1]',
        value,
        'color component is outside [0, 1]',
      );
    }
    return undefined;
  }
  if (type === 'asset-guid') {
    const validString = typeof value === 'string' && isValidAssetGuidString(value);
    if (!(value instanceof Uint8Array && value.byteLength === 16) && !validString) {
      return parameterFailure(
        propertyPath,
        'a 16-byte AssetGuid or UUID string',
        value,
        'asset GUID value is malformed',
      );
    }
    return undefined;
  }
  return parameterFailure(
    propertyPath,
    'a supported Pack parameter type',
    value,
    'unknown parameter type',
  );
}

function normalizeParameterValue(
  parameter: PackParameterDefinition,
  value: unknown,
  propertyPath: string,
): Result<PackParameterValue, PackAuthoringError> {
  const error = parameterValueError(parameter, value, propertyPath);
  if (error !== undefined) return failure(error);
  if (parameter.type === 'asset-guid' && typeof value === 'string') {
    const parsed = AssetGuidCodec.parse(value);
    if (!parsed.ok) {
      return failure(
        parameterFailure(
          propertyPath,
          'a valid AssetGuid UUID string',
          value,
          'asset GUID parser rejected the value',
        ),
      );
    }
    return ok(parsed.value);
  }
  return ok(cloneValue(value as PackParameterValue));
}

function validateParameterDefinitions(
  parameters: unknown,
  propertyPath = '$.parameters',
): Result<readonly PackParameterDefinition[], PackAuthoringError> {
  if (!Array.isArray(parameters) || parameters.length === 0) {
    return failure(
      parameterFailure(
        propertyPath,
        'a non-empty parameter descriptor array',
        parameters,
        'parameters must be explicit and non-empty',
      ),
    );
  }
  const names = new Set<string>();
  const normalized: PackParameterDefinition[] = [];
  for (const [index, candidate] of parameters.entries()) {
    const path = `${propertyPath}[${index}]`;
    if (!isRecord(candidate))
      return failure(
        parameterFailure(
          path,
          'a parameter descriptor object',
          candidate,
          'descriptor is not an object',
        ),
      );
    const name = candidate.name;
    if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
      return failure(
        parameterFailure(
          `${path}.name`,
          'a unique identifier-like parameter name',
          name,
          'parameter name is invalid',
        ),
      );
    }
    if (names.has(name))
      return failure(
        parameterFailure(
          `${path}.name`,
          'a unique parameter name',
          name,
          'parameter name is duplicated',
        ),
      );
    names.add(name);
    const unknown = Object.keys(candidate).find(
      (key) => !['name', 'type', 'default', 'minimum', 'maximum', 'values', 'kind'].includes(key),
    );
    if (unknown !== undefined) {
      return failure(
        parameterFailure(
          `${path}.${unknown}`,
          'only name, type, default, minimum, maximum, values, and kind fields',
          candidate[unknown],
          'parameter descriptors are a closed authoring schema',
        ),
      );
    }
    const type = candidate.type;
    if (typeof type !== 'string' || !(PACK_PARAMETER_TYPES as readonly string[]).includes(type)) {
      return failure(
        parameterFailure(
          `${path}.type`,
          PACK_PARAMETER_TYPES.join(' | '),
          type,
          'parameter type is not supported',
        ),
      );
    }
    const typed = {
      ...candidate,
      name,
      type: type as PackParameterType,
    } as PackParameterDefinition;
    if (typed.values !== undefined) {
      if (
        typed.type !== 'enum' ||
        !Array.isArray(typed.values) ||
        typed.values.length === 0 ||
        typed.values.some((item) => typeof item !== 'string') ||
        new Set(typed.values).size !== typed.values.length
      ) {
        return failure(
          parameterFailure(
            `${path}.values`,
            'unique non-empty strings for enum',
            typed.values,
            'enum values are malformed',
          ),
        );
      }
    } else if (typed.type === 'enum') {
      return failure(
        parameterFailure(
          `${path}.values`,
          'a non-empty enum choices array',
          typed.values,
          'enum has no choices',
        ),
      );
    }
    if (
      typed.kind !== undefined &&
      (typed.type !== 'asset-guid' || typeof typed.kind !== 'string')
    ) {
      return failure(
        parameterFailure(
          `${path}.kind`,
          'a kind constraint only on asset-guid parameters',
          typed.kind,
          'kind is misplaced',
        ),
      );
    }
    for (const field of ['minimum', 'maximum'] as const) {
      const bound = typed[field];
      if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) {
        return failure(
          parameterFailure(
            `${path}.${field}`,
            'a finite numeric bound',
            bound,
            'numeric bound is invalid',
          ),
        );
      }
    }
    if (!numericType(typed.type) && (typed.minimum !== undefined || typed.maximum !== undefined)) {
      return failure(
        parameterFailure(
          path,
          'minimum/maximum only on numeric parameters',
          typed,
          'numeric bounds are not meaningful for this parameter type',
        ),
      );
    }
    if (
      typed.minimum !== undefined &&
      typed.maximum !== undefined &&
      typed.minimum > typed.maximum
    ) {
      return failure(
        parameterFailure(path, 'minimum <= maximum', typed, 'numeric bounds are reversed'),
      );
    }
    const defaultResult = normalizeParameterValue(typed, typed.default, `${path}.default`);
    if (!defaultResult.ok) return defaultResult;
    normalized.push({
      ...typed,
      default: defaultResult.value,
      ...(typed.values === undefined ? {} : { values: Object.freeze([...typed.values]) }),
    });
  }
  return ok(Object.freeze(normalized));
}

export interface PackBuildReadContext {
  readByGuid<TAsset extends PackOutput = Asset>(guid: AssetGuid): Promise<Result<TAsset, unknown>>;
}

export interface PackBuildContextWithoutParameters extends PackBuildReadContext {
  readonly packageId: PackageId;
}

export interface PackBuildContextWithParameters<
  TParameters extends readonly PackParameterDefinition[],
> extends PackBuildReadContext {
  readonly packageId: PackageId;
  readonly values: PackParameterValues<TParameters>;
}

export type PackBuildContext<TParameters extends readonly PackParameterDefinition[] | undefined> =
  TParameters extends readonly PackParameterDefinition[]
    ? PackBuildContextWithParameters<TParameters>
    : PackBuildContextWithoutParameters;

/** Build-only custom source. The host derives identity and invokes the kind's NativeCooker. */
export interface PackCookSource {
  readonly kind: string;
  readonly execution: 'cooked';
  readonly source: unknown;
}

export type PackOutput = Asset | PluginAssetSource | PackCookSource;
export type PackOutputMap = Readonly<Record<string, PackOutput>>;
export type PackBuildResult<TError = unknown> =
  | Result<PackOutputMap, TError>
  | Promise<Result<PackOutputMap, TError>>;

export interface ScriptablePackRuntime {
  /** Complete asset read closure, including dependencies of non-default parameter branches. */
  readonly dependencies: readonly string[];
}

interface PackDefinitionBase {
  readonly schemaVersion: '2.0.0';
  readonly packageId: PackageId;
  readonly name?: string;
  readonly runtime?: ScriptablePackRuntime;
  /** Neutral component schemas used only to externalize SceneAsset refs at cook time. */
  readonly sceneComponents?: readonly ScriptablePackSceneComponentInput[];
}

export type ScriptablePackDefinition<
  TParameters extends readonly PackParameterDefinition[] | undefined = undefined,
> = PackDefinitionBase &
  (TParameters extends readonly PackParameterDefinition[]
    ? {
        readonly parameters: TParameters;
        readonly build: (context: PackBuildContextWithParameters<TParameters>) => PackBuildResult;
      }
    : {
        readonly build: (context: PackBuildContextWithoutParameters) => PackBuildResult;
      });

export type PackParameterList = readonly [PackParameterDefinition, ...PackParameterDefinition[]];
type NonEmptyParameters = PackParameterList;
type NoParameterPackInput = PackDefinitionBase & {
  readonly parameters?: never;
  readonly build: (context: PackBuildContextWithoutParameters) => PackBuildResult;
};
type ScriptablePackDefinitionInput<TParameters extends NonEmptyParameters> = PackDefinitionBase & {
  readonly parameters: TParameters;
  readonly build: (context: PackBuildContextWithParameters<TParameters>) => PackBuildResult;
};

/** Convert a UUID literal into the distinct Pack-level identity brand. */
export function definePackageId(value: string | PackageId): PackageId {
  if (isPackageId(value)) return value.slice() as PackageId;
  const parsed = PackageId.parse(value);
  if (!parsed.ok) {
    const error = authoringError(
      'pack-package-id-invalid',
      'a 36-character RFC 4122 UUID packageId',
      'use PackageId.random() or repair the packageId literal before loading the Pack',
      { value },
      value,
    );
    throw Object.assign(new TypeError(error.hint), error);
  }
  return parsed.value;
}

function cloneDefinition(
  definition: ScriptablePackDefinition<NonEmptyParameters> | ScriptablePackDefinition<undefined>,
): ScriptablePackDefinition<NonEmptyParameters> | ScriptablePackDefinition<undefined> {
  const parameters =
    'parameters' in definition
      ? Object.freeze(
          definition.parameters.map((parameter) =>
            Object.freeze({
              ...parameter,
              default: cloneValue(parameter.default),
              ...(parameter.values === undefined
                ? {}
                : { values: Object.freeze(parameter.values.map((value) => cloneValue(value))) }),
            }),
          ),
        )
      : undefined;
  const sceneComponents =
    definition.sceneComponents === undefined
      ? undefined
      : Object.freeze(
          definition.sceneComponents.map((component) =>
            Object.freeze({
              name: component.name,
              fields: Object.freeze({ ...component.fields }),
            }),
          ),
        );
  return Object.freeze({
    ...definition,
    packageId: definition.packageId.slice() as PackageId,
    ...(parameters === undefined ? {} : { parameters }),
    ...(sceneComponents === undefined ? {} : { sceneComponents }),
    ...(definition.runtime === undefined
      ? {}
      : {
          runtime: Object.freeze({
            dependencies: Object.freeze([...definition.runtime.dependencies]),
          }),
        }),
  }) as ScriptablePackDefinition<NonEmptyParameters> | ScriptablePackDefinition<undefined>;
}

/**
 * Define the only executable authoring shape. A missing `parameters` property
 * is meaningful: its build context has no `values` member.
 */
export function definePack(definition: NoParameterPackInput): ScriptablePackDefinition<undefined>;
export function definePack<const TParameters extends NonEmptyParameters>(
  definition: ScriptablePackDefinitionInput<TParameters>,
): ScriptablePackDefinition<TParameters>;
export function definePack(
  definition: NoParameterPackInput | ScriptablePackDefinitionInput<NonEmptyParameters>,
): ScriptablePackDefinition<NonEmptyParameters> | ScriptablePackDefinition<undefined> {
  const validated = validatePackDefinition(definition);
  if (!validated.ok) throw Object.assign(new TypeError(validated.error.hint), validated.error);
  return cloneDefinition(
    validated.value as
      | ScriptablePackDefinition<NonEmptyParameters>
      | ScriptablePackDefinition<undefined>,
  );
}

/** Union used only at orchestration boundaries that accept either source form. */
export type AnyScriptablePackDefinition =
  | ScriptablePackDefinition<PackParameterList>
  | ScriptablePackDefinition<undefined>;

export interface ScriptablePackSourceMeta {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'scriptable-pack-source';
  readonly packageId: string;
  readonly source: string;
  readonly parameters?: readonly Readonly<Record<string, unknown>>[];
  readonly runtime?: ScriptablePackRuntime;
}

/** Ephemeral scan evidence; it intentionally contains no output GUID table. */
export function projectScriptablePackMeta(
  definition: AnyScriptablePackDefinition,
  sourcePath: string,
): ScriptablePackSourceMeta {
  return {
    schemaVersion: '2.0.0',
    kind: 'scriptable-pack-source',
    packageId: PackageId.format(definition.packageId),
    source: sourcePath,
    ...(definition.runtime === undefined
      ? {}
      : {
          runtime: { dependencies: [...definition.runtime.dependencies] },
        }),
    ...('parameters' in definition
      ? {
          parameters: definition.parameters.map((parameter) => ({
            name: parameter.name,
            type: parameter.type,
            default: jsonParameterValue(parameter.default),
            ...(parameter.minimum === undefined ? {} : { minimum: parameter.minimum }),
            ...(parameter.maximum === undefined ? {} : { maximum: parameter.maximum }),
            ...(parameter.values === undefined ? {} : { values: parameter.values }),
            ...(parameter.kind === undefined ? {} : { kind: parameter.kind }),
          })),
        }
      : {}),
  };
}

function jsonParameterValue(value: PackParameterValue): unknown {
  return value instanceof Uint8Array ? AssetGuidCodec.format(value) : value;
}

/** Runtime validation used by the isolated module loader and source scanner. */
export function validatePackDefinition(
  value: unknown,
  sourcePath?: string,
): Result<
  ScriptablePackDefinition<NonEmptyParameters> | ScriptablePackDefinition<undefined>,
  PackAuthoringError
> {
  if (!isRecord(value))
    return failure(
      parameterFailure('$', 'a Pack definition object', value, 'definition is not an object'),
    );
  const unknown = Object.keys(value).find((key) => !isScriptablePackField(key));
  if (unknown !== undefined) {
    return failure(
      parameterFailure(
        `$.${unknown}`,
        'only schemaVersion, packageId, name, parameters, sceneComponents, runtime, and build fields',
        value[unknown],
        'legacy static output declarations and external asset tables are not part of v2 authoring',
      ),
    );
  }
  if (value.schemaVersion !== '2.0.0') {
    return failure(
      parameterFailure(
        '$.schemaVersion',
        "the literal '2.0.0'",
        value.schemaVersion,
        'authoring source schema is unsupported',
      ),
    );
  }
  if (!isPackageId(value.packageId)) {
    return failure(
      authoringError(
        'pack-package-id-invalid',
        'a 16-byte PackageId',
        'use definePackageId() for the stable source identity',
        { sourcePath, propertyPath: '$.packageId' },
        typeof value.packageId === 'string' ? value.packageId : undefined,
      ),
    );
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    return failure(
      parameterFailure('$.name', 'a string when present', value.name, 'display name is malformed'),
    );
  }
  if (typeof value.build !== 'function') {
    return failure(
      parameterFailure('$.build', 'a build function', value.build, 'build is not callable'),
    );
  }
  const sceneComponents = validateSceneComponents(value.sceneComponents);
  if (!sceneComponents.ok) return sceneComponents;
  let runtime: ScriptablePackRuntime | undefined;
  if (value.runtime !== undefined) {
    const candidate = value.runtime;
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).some((key) => key !== 'dependencies') ||
      !Array.isArray(candidate.dependencies) ||
      candidate.dependencies.some(
        (guid) =>
          typeof guid !== 'string' || !isValidAssetGuidString(guid) || guid !== guid.toLowerCase(),
      ) ||
      new Set(candidate.dependencies).size !== candidate.dependencies.length
    ) {
      return failure(
        parameterFailure(
          '$.runtime',
          'a dependencies array of unique canonical asset UUIDs',
          candidate,
          'runtime generation requires an explicit complete read closure',
        ),
      );
    }
    runtime = Object.freeze({ dependencies: Object.freeze([...candidate.dependencies]) });
  }
  const hasParameters = Object.hasOwn(value, 'parameters');
  if (!hasParameters) {
    return ok(
      Object.freeze({
        schemaVersion: '2.0.0',
        packageId: value.packageId,
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(runtime === undefined ? {} : { runtime }),
        ...(sceneComponents.value === undefined ? {} : { sceneComponents: sceneComponents.value }),
        build: value.build,
      }) as ScriptablePackDefinition<undefined>,
    );
  }
  const parameters = validateParameterDefinitions(value.parameters);
  if (!parameters.ok) return parameters;
  return ok(
    Object.freeze({
      schemaVersion: '2.0.0',
      packageId: value.packageId,
      ...(value.name === undefined ? {} : { name: value.name }),
      ...(runtime === undefined ? {} : { runtime }),
      ...(sceneComponents.value === undefined ? {} : { sceneComponents: sceneComponents.value }),
      parameters: parameters.value,
      build: value.build,
    }) as ScriptablePackDefinition<NonEmptyParameters>,
  );
}

export function hasPackParameters(
  value: ScriptablePackDefinition | unknown,
): value is ScriptablePackDefinition<NonEmptyParameters> {
  return isRecord(value) && Array.isArray(value.parameters) && value.parameters.length > 0;
}

/** Resolve defaults plus a sparse instance override with shallow replacement. */
export function resolvePackParameterValues(
  definition: ScriptablePackDefinition<NonEmptyParameters>,
  overrides: unknown = {},
  inheritedValues?: Readonly<Record<string, PackParameterValue>>,
): Result<PackParameterValues<NonEmptyParameters>, PackAuthoringError> {
  if (!isRecord(overrides)) {
    return failure(
      parameterFailure(
        '$.values',
        'an object of sparse parameter overrides',
        overrides,
        'values is not an object',
      ),
    );
  }
  const descriptors = new Map(
    definition.parameters.map((parameter) => [parameter.name, parameter]),
  );
  for (const name of Object.keys(overrides)) {
    if (!descriptors.has(name)) {
      return failure(
        parameterFailure(
          `$.values.${name}`,
          'a declared parameter name',
          name,
          'instance contains an unknown parameter',
        ),
      );
    }
  }
  const values: Record<string, PackParameterValue> = {};
  for (const parameter of definition.parameters) {
    const raw = Object.hasOwn(overrides, parameter.name)
      ? overrides[parameter.name]
      : (inheritedValues?.[parameter.name] ?? parameter.default);
    const normalized = normalizeParameterValue(parameter, raw, `$.values.${parameter.name}`);
    if (!normalized.ok) return normalized;
    values[parameter.name] = normalized.value;
  }
  return ok(Object.freeze(values) as PackParameterValues<NonEmptyParameters>);
}

export interface DirectPackJsonAsset {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly refs: readonly string[];
  readonly name?: string;
  readonly artifacts?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface DirectPackJson {
  readonly schemaVersion: '3.0.0';
  readonly packageId: string;
  /** Plugin source refs derive from $asset markers; other kinds supply refs. */
  readonly assets: Readonly<
    Record<string, Omit<DirectPackJsonAsset, 'refs'> & { readonly refs?: readonly string[] }>
  >;
}

export interface PackInstanceJson {
  readonly schemaVersion: '3.0.0';
  readonly packageId: string;
  readonly parent: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface ParsedDirectPackJson {
  readonly format: 'direct';
  readonly schemaVersion: '3.0.0';
  readonly packageId: PackageId;
  readonly assets: Readonly<Record<string, DirectPackJsonAsset>>;
}

export interface ParsedPackInstanceJson {
  readonly format: 'instance';
  readonly schemaVersion: '3.0.0';
  readonly packageId: PackageId;
  readonly parent: PackageId;
  readonly values: Readonly<Record<string, unknown>>;
}

export type ParsedPackJson = ParsedDirectPackJson | ParsedPackInstanceJson;

function jsonError(
  propertyPath: string,
  expected: string,
  actual: unknown,
  reason: string,
): Result<never, PackAuthoringError> {
  return failure(
    authoringError(
      'pack-parameter-invalid',
      expected,
      'repair the v3 pack.json authoring data, then rerun scan or rebuild',
      {
        propertyPath,
        reason,
        actual: typeof actual === 'string' ? actual : JSON.stringify(actual),
      },
    ),
  );
}

function parsePackageId(
  value: unknown,
  propertyPath: string,
): Result<PackageId, PackAuthoringError> {
  if (typeof value !== 'string') {
    return failure(
      authoringError(
        'pack-package-id-invalid',
        'a UUID string',
        'repair packageId in the authoring file',
        { propertyPath, value },
      ),
    );
  }
  const parsed = PackageId.parse(value);
  if (!parsed.ok) {
    return failure(
      authoringError(
        'pack-package-id-invalid',
        'a 36-character RFC 4122 UUID',
        'repair packageId or use the authoring gateway to mint one',
        { propertyPath, value },
        value,
      ),
    );
  }
  return ok(parsed.value);
}

function parsePackJsonAsset(
  value: unknown,
  sourceKey: string,
): Result<DirectPackJsonAsset, PackAuthoringError> {
  if (!isRecord(value))
    return jsonError(
      `$.assets.${sourceKey}`,
      'an asset entry object',
      value,
      'asset entry is not an object',
    );
  const allowed = new Set(['kind', 'payload', 'refs', 'name', 'artifacts']);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined)
    return jsonError(
      `$.assets.${sourceKey}.${unknown}`,
      'no GUID or extra authoring field',
      value[unknown],
      'direct v3 entries derive identity from their object key',
    );
  if (typeof value.kind !== 'string' || value.kind.length === 0)
    return jsonError(
      `$.assets.${sourceKey}.kind`,
      'a non-empty asset kind',
      value.kind,
      'asset kind is missing',
    );
  if (!isRecord(value.payload))
    return jsonError(
      `$.assets.${sourceKey}.payload`,
      'a JSON object payload',
      value.payload,
      'payload must be a plain object',
    );
  let refs: readonly string[];
  if (value.kind === 'plugin') {
    if (Object.hasOwn(value, 'refs'))
      return jsonError(
        `$.assets.${sourceKey}.refs`,
        'producer-derived plugin references',
        value.refs,
        'use $asset configuration markers instead of authored refs',
      );
    const plugin = validatePluginAssetSource({ ...value.payload, kind: 'plugin' });
    if (!plugin.ok)
      return jsonError(
        `$.assets.${sourceKey}.payload${plugin.error.detail.path.slice(1)}`,
        plugin.error.expected,
        value.payload,
        plugin.error.detail.reason,
      );
    refs =
      plugin.value.config === undefined ? [] : lowerPluginConfig(plugin.value.config).unwrap().refs;
  } else if (
    !Array.isArray(value.refs) ||
    value.refs.some((ref) => typeof ref !== 'string' || !isValidAssetGuidString(ref))
  ) {
    return jsonError(
      `$.assets.${sourceKey}.refs`,
      'an array of UUID references',
      value.refs,
      'references must already be real AssetGuids',
    );
  } else refs = value.refs;
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length === 0))
    return jsonError(
      `$.assets.${sourceKey}.name`,
      'a non-empty display name when present',
      value.name,
      'asset name is malformed',
    );
  if (value.artifacts !== undefined && !isRecord(value.artifacts))
    return jsonError(
      `$.assets.${sourceKey}.artifacts`,
      'an artifact descriptor object when present',
      value.artifacts,
      'artifacts are not an object',
    );
  const base: DirectPackJsonAsset = {
    kind: value.kind,
    payload: value.payload,
    refs: Object.freeze([...refs]),
    ...(value.name === undefined ? {} : { name: value.name }),
  };
  if (value.artifacts === undefined) return ok(base);
  const withArtifacts: DirectPackJsonAsset = {
    ...base,
    artifacts: value.artifacts as NonNullable<DirectPackJsonAsset['artifacts']>,
  };
  return ok(withArtifacts);
}

/** Parse the two mutually exclusive v3 pack.json branches. */
export function parsePackSourceJson(value: unknown): Result<ParsedPackJson, PackAuthoringError> {
  if (!isRecord(value))
    return jsonError('$', 'a v3 pack.json object', value, 'document is not an object');
  if (value.schemaVersion !== '3.0.0')
    return jsonError(
      '$.schemaVersion',
      "the literal '3.0.0'",
      value.schemaVersion,
      'document schema is not v3',
    );
  const unknown = Object.keys(value).find(
    (key) => !['schemaVersion', 'packageId', 'assets', 'parent', 'values'].includes(key),
  );
  if (unknown !== undefined)
    return jsonError(
      `$.${unknown}`,
      'no extra top-level authoring fields',
      value[unknown],
      'keep the v3 document to packageId+assets or packageId+parent+values',
    );
  const packageResult = parsePackageId(value.packageId, '$.packageId');
  if (!packageResult.ok) return packageResult;
  const hasAssets = Object.hasOwn(value, 'assets');
  const hasParent = Object.hasOwn(value, 'parent');
  const hasValues = Object.hasOwn(value, 'values');
  if (hasAssets && (hasParent || hasValues))
    return jsonError(
      '$',
      'assets or parent+values, never both',
      value,
      'direct and instance branches are mutually exclusive',
    );
  if (hasAssets) {
    if (!isRecord(value.assets))
      return jsonError(
        '$.assets',
        'a sourceKey to asset object',
        value.assets,
        'direct assets are not an object',
      );
    const assets: Record<string, DirectPackJsonAsset> = {};
    for (const [sourceKey, entry] of Object.entries(value.assets)) {
      if (!isValidPackSourceKey(sourceKey))
        return failure(sourceKeyFailure(sourceKey, `$.assets.${sourceKey}`));
      const parsed = parsePackJsonAsset(entry, sourceKey);
      if (!parsed.ok) return parsed;
      assets[sourceKey] = parsed.value;
    }
    return ok({
      format: 'direct',
      schemaVersion: '3.0.0',
      packageId: packageResult.value,
      assets: Object.freeze(assets),
    });
  }
  if (!hasParent || !hasValues || hasAssets)
    return jsonError(
      '$',
      'parent and values for an instance document',
      value,
      'instance branch is incomplete',
    );
  const parentResult = parsePackageId(value.parent, '$.parent');
  if (!parentResult.ok) return parentResult;
  if (!isRecord(value.values))
    return jsonError(
      '$.values',
      'a sparse parameter object',
      value.values,
      'instance values are not an object',
    );
  return ok({
    format: 'instance',
    schemaVersion: '3.0.0',
    packageId: packageResult.value,
    parent: parentResult.value,
    values: Object.freeze({ ...value.values }),
  });
}

export interface DirectPackAssetProjection extends DirectPackJsonAsset {
  readonly guid: string;
  readonly sourceKey: string;
}

export interface DirectPackProjection {
  readonly packageId: string;
  readonly assets: readonly DirectPackAssetProjection[];
}

/** Add the computed GUIDs needed by the ordinary Pack v2 publication path. */
export function projectDirectPackJson(value: ParsedDirectPackJson): DirectPackProjection {
  const assets: DirectPackAssetProjection[] = [];
  for (const [sourceKey, entry] of Object.entries(value.assets).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    assets.push({
      ...entry,
      guid: AssetGuidCodec.format(AssetGuidCodec.derive(value.packageId, sourceKey)),
      sourceKey,
    });
  }
  return { packageId: PackageId.format(value.packageId), assets: Object.freeze(assets) };
}

export interface PackParameterRootSubject {
  readonly format: 'source';
  readonly packageId: PackageId;
  readonly parameters: readonly PackParameterDefinition[];
}

export interface PackParameterInstanceSubject {
  readonly format: 'instance';
  readonly packageId: PackageId;
  readonly parent: PackageId;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface PackDirectSubject {
  readonly format: 'direct';
  readonly packageId: PackageId;
}

export type PackParameterInheritanceSubject =
  | PackParameterRootSubject
  | PackParameterInstanceSubject
  | PackDirectSubject;

export interface ResolvedPackParameterInheritance {
  readonly packageId: PackageId;
  readonly rootPackageId: PackageId;
  readonly values: Readonly<Record<string, PackParameterValue>>;
  readonly parentChain: readonly string[];
  readonly parameters: readonly PackParameterDefinition[];
}

export type PackParameterSubjectReader = (
  packageId: PackageId,
) =>
  | PackParameterInheritanceSubject
  | undefined
  | Promise<PackParameterInheritanceSubject | undefined>;

function subjectId(subject: PackParameterInheritanceSubject): string {
  return PackageId.format(subject.packageId).toLowerCase();
}

/** Resolve one finite parent chain. Every instance keeps its own packageId. */
export async function resolvePackParameterInheritance(
  subject: PackParameterInheritanceSubject,
  readParent: PackParameterSubjectReader,
): Promise<Result<ResolvedPackParameterInheritance, PackAuthoringError>> {
  const visited = new Set<string>();

  async function visit(
    current: PackParameterInheritanceSubject,
    path: readonly string[],
  ): Promise<Result<ResolvedPackParameterInheritance, PackAuthoringError>> {
    const currentId = subjectId(current);
    if (visited.has(currentId) || path.includes(currentId)) {
      return failure(
        authoringError(
          'pack-parent-cycle',
          'a finite acyclic Pack parent chain',
          'inspect parentChain and repair the first repeated packageId',
          { packageId: currentId, parentChain: [...path, currentId] },
        ),
      );
    }
    visited.add(currentId);
    const nextPath = [...path, currentId];
    if (current.format === 'direct') {
      return failure(
        authoringError(
          'pack-parent-has-no-parameters',
          'a ScriptablePack source with parameters as the parent',
          'direct packs cannot be instance parents; point the instance at a ScriptablePack source with parameters',
          { packageId: currentId },
        ),
      );
    }
    if (current.format === 'source') {
      const descriptors = validateParameterDefinitions(current.parameters, '$.parameters');
      if (!descriptors.ok) return descriptors;
      if (descriptors.value.length === 0) {
        return failure(
          authoringError(
            'pack-parent-has-no-parameters',
            'the parent source to declare a non-empty parameter list',
            'use clone for an independent zero-parameter Pack instead of creating an empty instance',
            { packageId: currentId },
          ),
        );
      }
      const definition = {
        schemaVersion: '2.0.0',
        packageId: current.packageId,
        parameters: descriptors.value as NonEmptyParameters,
        build: () => ok({}),
      } as ScriptablePackDefinition<NonEmptyParameters>;
      const values = resolvePackParameterValues(definition);
      if (!values.ok) return values;
      return ok({
        packageId: current.packageId,
        rootPackageId: current.packageId,
        values: values.value,
        parentChain: [],
        parameters: descriptors.value,
      });
    }
    const parent = await readParent(current.parent);
    if (parent === undefined) {
      return failure(
        authoringError(
          'pack-parent-not-found',
          'the parent packageId to resolve in the source index',
          'inspect the parent locator or recreate the instance from a live ScriptablePack with parameters',
          { packageId: currentId, parent: PackageId.format(current.parent) },
        ),
      );
    }
    if (
      PackageId.format(parent.packageId).toLowerCase() !==
      PackageId.format(current.parent).toLowerCase()
    ) {
      return failure(
        authoringError(
          'pack-parent-not-found',
          'the parent reader to return the requested packageId',
          'repair the Source Index locator and retry inheritance resolution',
          {
            packageId: currentId,
            requestedParent: PackageId.format(current.parent),
            observedParent: PackageId.format(parent.packageId),
          },
        ),
      );
    }
    const resolvedParent = await visit(parent, nextPath);
    if (!resolvedParent.ok) return resolvedParent;
    const descriptors = resolvedParent.value.parameters;
    const definition = {
      schemaVersion: '2.0.0',
      packageId: resolvedParent.value.rootPackageId,
      parameters: descriptors as NonEmptyParameters,
      build: () => ok({}),
    } as ScriptablePackDefinition<NonEmptyParameters>;
    const values = resolvePackParameterValues(
      definition,
      current.values,
      resolvedParent.value.values,
    );
    if (!values.ok) return values;
    return ok({
      packageId: current.packageId,
      rootPackageId: resolvedParent.value.rootPackageId,
      values: values.value,
      parentChain: [PackageId.format(current.parent), ...resolvedParent.value.parentChain],
      parameters: descriptors,
    });
  }

  return visit(subject, []);
}

export const PACK_AUTHORING_OPERATION_IDS = [
  'asset.list',
  'asset.inspect',
  'asset.resolve',
  'asset.verify',
  'asset.source.create',
  'asset.source.clone',
  'asset.source.import',
  'asset.source.instance.create',
  'asset.source.values.apply',
  'asset.source.rebuild',
  'asset.source.cold-cook',
] as const;

export type PackAuthoringOperationId = (typeof PACK_AUTHORING_OPERATION_IDS)[number];

export interface PackAuthoringOperation {
  readonly requestId: string;
  readonly expectedRevision?: string;
  readonly operation: PackAuthoringOperationId;
  readonly subject?: string;
  readonly sourcePath?: string;
  readonly sourceRoot?: string;
  readonly targetPath?: string;
  readonly packageId?: string;
  /** Parent package identity used by asset.source.instance.create. */
  readonly parentPackageId?: string;
  /** JSON-facing alias accepted by adapters at the operation boundary. */
  readonly parent?: string;
  readonly sourceKey?: string;
  readonly values?: Readonly<Record<string, unknown>>;
  /** `pack.ts` or `pack.json`; omitted defaults to the target extension. */
  readonly format?: 'pack.ts' | 'pack.json';
  /** Direct v3 entries for asset.source.create. */
  readonly initialAssets?: Readonly<Record<string, DirectPackJsonAsset>>;
  /** Explicit non-empty parameter declarations for a generated pack.ts scaffold. */
  readonly parameters?: readonly Readonly<Record<string, unknown>>[];
  /** Required proof level for asset.resolve. */
  readonly require?: 'identity' | 'present' | 'ready';
}

export type PackAuthoringResolutionStatus = 'identity' | 'present' | 'ready';

export interface PackAuthoringOperationResult {
  readonly operation: PackAuthoringOperationId;
  readonly requestId: string;
  readonly schemaVersion?: 'asset-verification-v1';
  readonly sourcePath?: string;
  readonly targetPath?: string;
  readonly revision?: string;
  readonly packageId?: string;
  readonly parentPackageId?: string;
  readonly sourceKey?: string;
  readonly guid?: string;
  readonly format?: 'pack.ts' | 'pack.json' | 'direct' | 'instance';
  readonly status?: PackAuthoringResolutionStatus;
  readonly kind?: string;
  readonly parameters?: readonly Readonly<Record<string, unknown>>[];
  readonly values?: Readonly<Record<string, unknown>>;
  /** Authored payload of the selected direct Pack output, never the whole source. */
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly effectiveValues?: Readonly<Record<string, unknown>>;
  readonly parentChain?: readonly string[];
  readonly assets?: readonly Readonly<Record<string, unknown>>[];
  readonly sources?: readonly Readonly<Record<string, unknown>>[];
  /** Source-local failures retained by partial read queries; mutations remain strict. */
  readonly diagnostics?: readonly {
    readonly sourcePath: string;
    readonly error: PackAuthoringError;
  }[];
  readonly capabilities?: readonly PackAuthoringOperationId[];
  readonly snapshot?: {
    readonly sourceCount: number;
    readonly assetCount: number;
  };
  /** Bounded source/output facts for read-only verification consumers. */
  readonly scope?: {
    readonly sourceCount: number;
    readonly assetCount: number;
    readonly sourcePaths: readonly string[];
    readonly omittedSourceCount: number;
    readonly assetLimit: number;
    readonly truncated: boolean;
    readonly scriptablePackSourceCount: number;
    readonly scriptablePackSources: readonly {
      readonly sourcePath: string;
      readonly packageId: string;
      readonly output: 'unproduced';
      readonly reason: 'producer-not-run';
    }[];
    readonly omittedScriptablePackSourceCount: number;
  };
  readonly summary?: {
    readonly assetCount: number;
    readonly emittedAssetCount: number;
    readonly materialCount: number;
    readonly unproducedAssetCount: number;
    readonly unknownAssetCount: number;
    readonly unmaterializedScriptablePackCount: number;
  };
}

export interface PackAuthoringGatewayPort<TResult = unknown> {
  execute(operation: PackAuthoringOperation): Promise<Result<TResult, PackAuthoringError>>;
}

/** One idempotent gateway wrapper shared by Editor and CLI adapters. */
export function createPackAuthoringGateway<TResult = unknown>(
  port: PackAuthoringGatewayPort<TResult>,
): PackAuthoringGatewayPort<TResult> {
  const requests = new Map<
    string,
    { fingerprint: string; result: Promise<Result<TResult, PackAuthoringError>> }
  >();
  return {
    execute(operation) {
      if (typeof operation.requestId !== 'string' || operation.requestId.trim().length === 0) {
        return Promise.resolve(
          failure(
            authoringError(
              'pack-source-revision-conflict',
              'a non-empty caller-minted requestId',
              'mint a new requestId and retry',
              { requestId: operation.requestId },
            ),
          ),
        );
      }
      let fingerprint: string;
      try {
        fingerprint = JSON.stringify(operation);
      } catch (cause) {
        return Promise.resolve(
          failure(
            authoringError(
              'pack-parameter-invalid',
              'a JSON-serialisable authoring operation',
              'remove non-serialisable operation fields and retry with a new requestId',
              {
                requestId: operation.requestId,
                cause: cause instanceof Error ? cause.message : String(cause),
              },
            ),
          ),
        );
      }
      const previous = requests.get(operation.requestId);
      if (previous !== undefined) {
        if (previous.fingerprint === fingerprint) return previous.result;
        return Promise.resolve(
          failure(
            authoringError(
              'pack-source-revision-conflict',
              'one immutable operation per requestId',
              'read the original result or mint a new requestId',
              { requestId: operation.requestId },
            ),
          ),
        );
      }
      const result = Promise.resolve()
        .then(() => port.execute(operation))
        .catch(
          (cause): Result<TResult, PackAuthoringError> =>
            failure(
              authoringError(
                'pack-parameter-invalid',
                'the Pack authoring port to return a structured Result',
                'repair the gateway port failure, then retry with a new requestId',
                {
                  requestId: operation.requestId,
                  cause: cause instanceof Error ? cause.message : String(cause),
                },
              ),
            ),
        );
      requests.set(operation.requestId, { fingerprint, result });
      return result;
    },
  };
}

export const PACK_AUTHORING_OPERATION_DESCRIPTORS = PACK_AUTHORING_OPERATION_IDS.map((id) => ({
  id,
  domain: id.startsWith('asset.source.') ? 'session' : 'asset',
  readOnly: id.startsWith('asset.'),
  requiresRevision: !id.startsWith('asset.') && id !== 'asset.source.create',
})) as readonly {
  id: PackAuthoringOperationId;
  domain: 'asset' | 'session';
  readOnly: boolean;
  requiresRevision: boolean;
}[];
