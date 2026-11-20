import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  Result,
  RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import type { GpuSceneInputPreparation, GpuSceneInputs } from '../gpu-scene-inputs';
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
  prepareMesh(previous: BindGroup): Result<BindGroup | undefined, RhiError>;
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
  meshCurrent?: (() => boolean) | undefined;
  publishMesh?: (() => void) | undefined;
  prepareMesh?: ((previous: BindGroup) => Result<BindGroup | undefined, RhiError>) | undefined;
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
): Result<BindGroup, RhiError> {
  const whole = device.caps.firstInstanceIndirect;
  const window = () => (whole ? binding(visible) : binding(visible, base * 16, capacity * 16));
  const tables = storage.tables;
  return device.createBindGroup({
    label: `standard-pbr-gpu-driven-visible-window-${base}`,
    layout,
    entries: [
      { binding: 0, resource: binding(tables.instanceBuffer, 0, tables.instanceBytes) },
      {
        binding: 1,
        resource: shadow || storage.probe === undefined ? window() : binding(storage.probe),
      },
      { binding: 2, resource: window() },
      { binding: 3, resource: binding(storage.dynamicInput) },
      { binding: 4, resource: binding(storage.dynamicFrame) },
      { binding: 5, resource: binding(storage.sharedFrame) },
      { binding: 6, resource: binding(tables.primitiveBuffer, 0, tables.primitiveBytes) },
      { binding: 7, resource: binding(tables.visibleSurfaceRows ?? visible) },
      { binding: 8, resource: binding(tables.sceneInputs ?? visible) },
    ],
  });
}

/** Late windows move with their original View's reserved mirror, not with unrelated numeric addresses. */
export function remapRasterWindowBase(base: number, target: ViewStorageTarget): number {
  return target.previousLateVisibleBase > 0 && base >= target.previousLateVisibleBase
    ? base - target.previousLateVisibleBase + target.lateVisibleBase
    : base;
}
