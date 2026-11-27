import type {
  BindGroup,
  BindGroupEntry,
  BindGroupLayout,
  Buffer,
  Result,
  RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import type { GpuSceneInputPreparation, GpuSceneInputs } from '../gpu-scene-inputs';
import { type RasterWindowLayout, retainRasterWindow } from './raster-window-layout';
import type { ViewStorageTarget } from './view-gpu';

export type RasterInputDemand =
  | { readonly kind: 'successor'; readonly preparation: GpuSceneInputPreparation }
  | { readonly kind: 'current'; readonly storage: ViewStorageTarget; readonly buffer: Buffer };

export function rasterInputTarget(inputs: GpuSceneInputs, demand: RasterInputDemand) {
  return demand.kind === 'successor'
    ? inputs.preparationTarget(demand.preparation)
    : demand.storage.isCurrent() && inputs.isCurrentBuffer(demand.buffer)
      ? { buffer: demand.buffer }
      : undefined;
}

export function rasterInputCurrent(
  inputs: GpuSceneInputs,
  demand: RasterInputDemand,
  buffer: Buffer,
): boolean {
  return demand.kind === 'successor'
    ? inputs.preparationIsCurrent(demand.preparation) || inputs.isCurrentBuffer(buffer)
    : demand.storage.isCurrent() && inputs.isCurrentBuffer(buffer);
}

export interface RasterSceneTables {
  readonly transformBuffer: Buffer;
  readonly transformBytes: number;
  readonly instanceBuffer: Buffer;
  readonly instanceBytes: number;
  readonly primitiveBuffer: Buffer;
  readonly primitiveBytes: number;
  readonly visibleSurfaceRows: Buffer | undefined;
  readonly sceneInputs: Buffer | undefined;
  readonly inputOwner?: GpuSceneInputs;
}

export interface RasterWindowStorage {
  readonly tables: RasterSceneTables;
  readonly probe: Buffer | undefined;
  readonly dynamicInput: Buffer;
  readonly dynamicFrame: Buffer;
  readonly sharedFrame: Buffer;
}

export interface GpuRasterInputPreparation {
  isCurrent(): boolean;
  bindingIdentity(): object | undefined;
  replacement(window: BindGroup): BindGroup | undefined;
  publish(): Result<void, RhiError>;
  release(): void;
}

export type RasterWindowCache = WeakMap<Buffer, Map<string, BindGroup>>;
export interface RasterWindowSnapshot {
  readonly buffer: Buffer;
  readonly groups: Map<string, BindGroup> | undefined;
  readonly rows: readonly (readonly [string, BindGroup])[];
}

export interface PreparingRasterInputBindings {
  facts:
    | {
        readonly storage: RasterWindowStorage;
        readonly cache: RasterWindowCache;
        readonly visible: Buffer;
        readonly whole: boolean;
        readonly inputs: GpuSceneInputs;
        readonly demand: RasterInputDemand;
        readonly target: { readonly buffer: Buffer } | undefined;
      }
    | undefined;
  readonly snapshots: RasterWindowSnapshot[];
  readonly replacements: Map<BindGroup, BindGroup>;
  next: RasterWindowCache | undefined;
  nextTables: RasterSceneTables | undefined;
  nextVisible: Buffer | undefined;
  nextInstances: BindGroup | undefined;
  sceneTablesCurrent?: (() => boolean) | undefined;
  ready: boolean;
  closeOwner: (() => void) | undefined;
}

const binding = (buffer: Buffer, offset?: number, size?: number) => ({
  kind: 'buffer' as const,
  value: {
    buffer,
    ...(offset === undefined ? {} : { offset }),
    ...(size === undefined ? {} : { size }),
  },
});

/** The ordinary and privately prepared windows share their exact native descriptor. */
export function createRasterWindowBinding(
  device: RhiDevice,
  layout: BindGroupLayout,
  storage: RasterWindowStorage,
  visible: Buffer,
  base: number,
  capacity: number,
  shadow: boolean,
  projection?: RasterWindowLayout,
): Result<BindGroup, RhiError> {
  const whole = device.caps.firstInstanceIndirect;
  const window = () => (whole ? binding(visible) : binding(visible, base * 16, capacity * 16));
  const slots = projection?.slots ?? FULL_RASTER_WINDOW_SLOTS;
  const entries = slots.map(
    (slot): BindGroupEntry => ({
      binding: slot,
      resource: rasterWindowResource(storage, visible, shadow, window, slot),
    }),
  );
  const result = device.createBindGroup({
    label: `standard-pbr-gpu-driven-visible-window-${base}`,
    layout: projection?.layout ?? layout,
    entries,
  });
  if (result.ok && projection !== undefined) retainRasterWindow(result.value, projection);
  return result;
}

const FULL_RASTER_WINDOW_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

function rasterWindowResource(
  storage: RasterWindowStorage,
  visible: Buffer,
  shadow: boolean,
  window: () => ReturnType<typeof binding>,
  slot: number,
): BindGroupEntry['resource'] {
  const tables = storage.tables;
  switch (slot) {
    case 0:
      return binding(tables.instanceBuffer, 0, tables.instanceBytes);
    case 1:
      return shadow || storage.probe === undefined ? window() : binding(storage.probe);
    case 2:
      return window();
    case 3:
      return binding(storage.dynamicInput);
    case 4:
      return binding(storage.dynamicFrame);
    case 5:
      return binding(storage.sharedFrame);
    case 6:
      return binding(tables.primitiveBuffer, 0, tables.primitiveBytes);
    case 7:
      return binding(tables.visibleSurfaceRows ?? visible);
    case 8:
      return binding(tables.sceneInputs ?? visible);
    case 9:
      return binding(tables.transformBuffer, 0, tables.transformBytes);
    default:
      throw new Error('Unknown GPU Scene raster window slot');
  }
}

/** Late windows move with their original View's reserved mirror, not with unrelated numeric addresses. */
export function remapRasterWindowBase(base: number, target: ViewStorageTarget): number {
  return target.previousLateVisibleBase > 0 && base >= target.previousLateVisibleBase
    ? base - target.previousLateVisibleBase + target.lateVisibleBase
    : base;
}
