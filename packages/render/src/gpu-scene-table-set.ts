import {
  type Buffer,
  err,
  ok,
  type Result,
  type RhiDevice,
  RhiError,
  type TextureView,
} from '@forgeax/engine-rhi';
import { MATERIAL_SCENE_ADDRESS_UNIT_BYTES } from '@forgeax/engine-types';
import { GPU_SCENE_LAYOUTS, type GpuSceneTableLayout } from './gpu-scene-schema';
import {
  createGpuSceneTable,
  destroyGpuSceneTables,
  type GpuSceneTableBackend,
  type GpuSceneTableResource,
  type GpuSceneTableStorage,
} from './gpu-scene-tables';

export const MATERIAL = {
  name: 'GpuSceneMaterialAddress',
  stride: MATERIAL_SCENE_ADDRESS_UNIT_BYTES,
  fields: [],
} as const;

export interface GpuSceneTables {
  readonly primitive: GpuSceneTableResource;
  readonly instance: GpuSceneTableResource;
  readonly transform: GpuSceneTableResource;
  readonly material: GpuSceneTableResource;
}

/** The row tables a texture-backed scene binds to `textureLoad` reads. */
export interface GpuSceneTableTextures {
  readonly primitive: TextureView;
  readonly instance: TextureView;
  readonly transform: TextureView;
}

export type GpuSceneTableName = keyof GpuSceneTables;

export const TABLE_LAYOUTS = {
  primitive: GPU_SCENE_LAYOUTS.primitive,
  instance: GPU_SCENE_LAYOUTS.instance,
  transform: GPU_SCENE_LAYOUTS.transform,
  material: MATERIAL,
} as const satisfies Readonly<Record<GpuSceneTableName, GpuSceneTableLayout>>;

export const TABLE_NAMES = Object.keys(TABLE_LAYOUTS) as readonly GpuSceneTableName[];

/**
 * Doubling growth keeps reallocation amortized O(1) per row; slack is clamped
 * to the rows the device can bind, and only a requirement beyond that fails.
 */
export function growGpuSceneTableCapacity(
  current: number,
  required: number,
  stride: number,
  limitBytes: number,
): Result<number, RhiError> {
  if (required <= current) return ok(current);
  const maxRows = Math.floor(limitBytes / stride);
  if (required > maxRows)
    return err(
      new RhiError({
        code: 'limit-exceeded',
        expected: `GPU Scene table (${required} rows x ${stride} B) fits the device table binding limit (${limitBytes} B)`,
        hint: 'reduce resident GPU-driven rows or request a device with larger storage binding limits',
        detail: { maxStorageBufferBindingSize: limitBytes, requestedBytes: required * stride },
      }),
    );
  let next = Math.max(1, current);
  while (next < required) next *= 2;
  return ok(Math.min(next, maxRows));
}

export function createTables(
  device: RhiDevice,
  backend: GpuSceneTableBackend,
  capacity: number,
  materialCapacity: number,
): Result<GpuSceneTables, RhiError> {
  const created: Partial<Record<GpuSceneTableName, GpuSceneTableResource>> = {};
  const captured: GpuSceneTableStorage[] = [];
  const failed = (cause: unknown): Result<never, RhiError> => {
    const cleanup = destroyGpuSceneTables(device, captured);
    const failure =
      cause instanceof RhiError
        ? cause
        : Object.assign(
            new RhiError({
              code: 'internal-error',
              expected: 'complete initial GPU Scene table construction',
              hint: 'retain construction and cleanup failures and rebuild the GPU owner',
            }),
            { cause },
          );
    return cleanup.ok
      ? err(failure)
      : err(
          Object.assign(cleanup.error, {
            cause: new AggregateError(
              [failure, cleanup.error.cause],
              'GPU table creation and cleanup failed',
            ),
          }),
        );
  };
  for (const name of TABLE_NAMES) {
    try {
      const result = createGpuSceneTable(
        device,
        backend,
        `gpu-scene-${name}-table`,
        (name === 'material' ? materialCapacity : capacity) * TABLE_LAYOUTS[name].stride,
        (table) => captured.push(table),
      );
      if (!result.ok) return failed(result.error);
      created[name] = result.value;
    } catch (cause) {
      return failed(cause);
    }
  }
  const { primitive, instance, transform, material } = created;
  if (
    primitive === undefined ||
    instance === undefined ||
    transform === undefined ||
    material === undefined
  ) {
    return err(
      new RhiError({
        code: 'internal-error',
        expected: 'GPU scene creates one resource for every table',
        hint: 'rebuild the renderer after inspecting the device resource failure',
      }),
    );
  }
  return ok({ primitive, instance, transform, material });
}

export function tableBuffer(table: GpuSceneTableResource): Buffer {
  if (table.kind === 'buffer') return table.buffer;
  throw new RhiError({
    code: 'internal-error',
    expected: 'storage-buffer GPU Scene tables for a storage-bound consumer',
    hint: 'read texture-backed GPU Scene tables through tableTextures',
  });
}

/** Publish the actual texture bindings when the scene installs new physical tables. */
export function textureTableViews(tables: GpuSceneTables): GpuSceneTableTextures | undefined {
  const { primitive, instance, transform } = tables;
  if (primitive.kind !== 'texture' || instance.kind !== 'texture' || transform.kind !== 'texture')
    return undefined;
  return Object.freeze({
    primitive: primitive.view,
    instance: instance.view,
    transform: transform.view,
  });
}
