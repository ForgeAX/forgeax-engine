import { isToolCommandContract, type ToolCommandContract } from '@forgeax/engine-tool-runtime';
import type { PluginAsset, PluginConfigValue, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { isValidAssetGuidString } from './guid.js';

export interface PluginModuleReference {
  readonly specifier: string;
  readonly export?: string;
}

export interface PluginAssetSource {
  readonly kind: 'plugin';
  readonly module: PluginModuleReference;
  readonly config?: PluginConfigValue;
  readonly toolContract?: PluginModuleReference | ToolCommandContract;
}

export interface PluginSourceError {
  readonly code: 'plugin-source-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly path: string; readonly reason: string };
}

function invalid(path: string, reason: string): PluginSourceError {
  return {
    code: 'plugin-source-invalid',
    expected:
      'a static module reference and a finite JSON configuration with explicit $asset markers',
    hint: 'repair this Pack output before rebuilding its program closure',
    detail: { path, reason },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function moduleReference(value: unknown, path: string): PluginSourceError | undefined {
  if (!record(value)) return invalid(path, 'expected a module reference object');
  if (Object.keys(value).some((key) => key !== 'specifier' && key !== 'export')) {
    return invalid(path, 'unknown module reference field');
  }
  if (
    typeof value.specifier !== 'string' ||
    !value.specifier.trim() ||
    /[\0\r\n]/.test(value.specifier) ||
    value.specifier.startsWith('/') ||
    /^[a-zA-Z]:/.test(value.specifier)
  ) {
    return invalid(`${path}.specifier`, 'expected a relative path or package specifier');
  }
  if (value.export !== undefined && (typeof value.export !== 'string' || !value.export)) {
    return invalid(`${path}.export`, 'expected a non-empty export name');
  }
  return undefined;
}

function configTree(
  value: unknown,
  path: string,
  refs: Set<string> | undefined,
  ancestors: Set<object>,
): Result<PluginConfigValue, PluginSourceError> {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return ok(value);
  if (typeof value === 'number' && Number.isFinite(value)) return ok(value);
  if (!Array.isArray(value) && !record(value))
    return err(invalid(path, 'expected finite JSON data'));
  if (ancestors.has(value)) return err(invalid(path, 'cyclic configuration'));
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: PluginConfigValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const child = configTree(value[index], `${path}[${index}]`, refs, ancestors);
        if (!child.ok) return child;
        result.push(child.value);
      }
      if (
        Reflect.ownKeys(value).some(
          (key) => typeof key === 'symbol' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)),
        )
      ) {
        return err(invalid(path, 'array has non-JSON properties'));
      }
      return ok(result);
    }
    const output: Record<string, PluginConfigValue> = {};
    const keys = Reflect.ownKeys(value);
    if (refs !== undefined && Object.hasOwn(value, '$asset')) {
      if (
        keys.length !== 1 ||
        typeof value.$asset !== 'string' ||
        !isValidAssetGuidString(value.$asset) ||
        value.$asset !== value.$asset.toLowerCase()
      ) {
        return err(invalid(path, '$asset must be the sole field and contain a canonical UUID'));
      }
      refs.add(value.$asset);
      return ok(value.$asset);
    }
    for (const key of keys) {
      if (typeof key !== 'string') return err(invalid(path, 'symbol property is not JSON'));
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        return err(invalid(`${path}.${key}`, 'accessors and hidden fields are not JSON'));
      }
      const child = configTree(descriptor.value, `${path}.${key}`, refs, ancestors);
      if (!child.ok) return child;
      // Preserve JSON data keys such as __proto__ without invoking inherited setters.
      Object.defineProperty(output, key, {
        value: child.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return ok(output);
  } finally {
    ancestors.delete(value);
  }
}

export function lowerPluginConfig(value: unknown): Result<
  {
    readonly config: PluginConfigValue;
    readonly refs: readonly string[];
  },
  PluginSourceError
> {
  const refs = new Set<string>();
  const result = configTree(value, '$.config', refs, new Set());
  return result.ok ? ok({ config: result.value, refs: [...refs].sort() }) : result;
}

export function validatePluginAssetSource(
  value: unknown,
): Result<PluginAssetSource, PluginSourceError> {
  if (!record(value) || value.kind !== 'plugin') return err(invalid('$', 'expected plugin source'));
  if (
    Object.keys(value).some((key) => !['kind', 'module', 'config', 'toolContract'].includes(key))
  ) {
    return err(invalid('$', 'unknown plugin source field'));
  }
  const moduleError = moduleReference(value.module, '$.module');
  if (moduleError) return err(moduleError);
  if (value.toolContract !== undefined && !isToolCommandContract(value.toolContract)) {
    const contractError = moduleReference(value.toolContract, '$.toolContract');
    if (contractError) return err(contractError);
  }
  if (Object.hasOwn(value, 'config')) {
    const config = lowerPluginConfig(value.config);
    if (!config.ok) return config;
  }
  return ok(value as unknown as PluginAssetSource);
}

/** Pure executor-reference lowering shared by static delivery and runtime source admission. */
export function lowerPluginToolContract(
  contract: ToolCommandContract,
  resolve: (module: PluginModuleReference) => string,
): Result<ToolCommandContract, PluginSourceError> {
  if (!isToolCommandContract(contract))
    return err(invalid('$.toolContract', 'expected a pure tool command contract'));
  try {
    const commands = structuredClone(contract.commands).map(
      ({ executor, exportName, ...command }) => {
        if (executor === undefined) return command;
        const reference = {
          specifier: executor,
          ...(exportName === undefined ? {} : { export: exportName }),
        };
        const error = moduleReference(reference, '$.toolContract.executor');
        if (error) throw new TypeError(error.detail.reason);
        const program = resolve(reference);
        if (typeof program !== 'string' || !program.length)
          throw new TypeError(`missing executor program ${executor}`);
        return { ...command, executor: program };
      },
    );
    return ok({ schemaVersion: '1.0.0', commands });
  } catch (cause) {
    return err(invalid('$.toolContract', cause instanceof Error ? cause.message : String(cause)));
  }
}

export function validatePluginAsset(value: unknown): Result<PluginAsset, PluginSourceError> {
  if (
    !record(value) ||
    value.kind !== 'plugin' ||
    typeof value.program !== 'string' ||
    !value.program
  ) {
    return err(invalid('$', 'expected a cooked plugin definition with a program key'));
  }
  if (Object.keys(value).some((key) => !['kind', 'program', 'config'].includes(key))) {
    return err(invalid('$', 'unknown cooked plugin field'));
  }
  if (Object.hasOwn(value, 'config')) {
    const config = configTree(value.config, '$.config', undefined, new Set());
    if (!config.ok) return config;
  }
  return ok(value as unknown as PluginAsset);
}
