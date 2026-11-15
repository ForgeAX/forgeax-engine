import { type AssetVersion, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { defineResource } from '@forgeax/engine-ecs';
import type { MeshAsset } from '@forgeax/engine-types';
import { type AssetHandle, err, ok, type Result } from '@forgeax/engine-types';
import type { OutlineSnapshot } from '../../components/outline';

export type EditorAssistanceDepth = 'occluded' | 'always';
export type EditorAssistanceVector = readonly [number, number, number];
export type EditorAssistanceColor = readonly [number, number, number, number];
export type EditorAssistanceAction =
  | { readonly kind: 'entity'; readonly entity: EntityHandle }
  | {
      readonly kind: 'gizmo';
      readonly entity: EntityHandle;
      readonly handle: string;
      readonly interactionFrame?: number;
    };

/** Presentation facts only. No helper has an ECS entity or a second scene graph. */
export type EditorAssistancePrimitive = {
  readonly depth: EditorAssistanceDepth;
  readonly color: EditorAssistanceColor;
  readonly action?: EditorAssistanceAction;
} & (
  | {
      readonly kind: 'line';
      readonly start: EditorAssistanceVector;
      readonly end: EditorAssistanceVector;
    }
  | {
      readonly kind: 'mesh';
      readonly mesh: AssetHandle<'mesh'>;
      readonly transform: readonly number[];
    }
  | {
      readonly kind: 'icon';
      readonly icon: 'camera' | 'light';
      readonly position: EditorAssistanceVector;
      readonly pixels: number;
    }
);

/** Derived revision belongs to the producer capture, never to a World routing lane. */
export type CapturedEditorAssistancePrimitive = EditorAssistancePrimitive & {
  readonly meshRevision?: number;
};
export interface EditorAssistanceMeshVersion {
  readonly handle: number;
  readonly revision: number | undefined;
  /** Borrowed immutable local value. Worker extraction publishes it through assetVersions. */
  readonly value?: MeshAsset;
}
export interface EditorAssistanceOptions {
  readonly enabled: boolean;
  /** Scene camera only. An undefined selector follows the display camera. */
  readonly camera?: EntityHandle | undefined;
  readonly icons: boolean;
  readonly cameraFrusta: boolean;
  readonly lightRanges: boolean;
  readonly bounds: boolean;
  readonly collision: boolean;
  readonly depth: EditorAssistanceDepth;
}
export const EDITOR_ASSISTANCE_LIMITS = Object.freeze({
  selection: 256,
  contributions: 16,
  primitives: 4096,
  icons: 512,
  submittedFrames: 2,
});
export type EditorAssistanceErrorCode =
  | 'editor-assistance-invalid-input'
  | 'editor-assistance-unavailable'
  | 'editor-assistance-stale-frame';
export class EditorAssistanceError extends Error {
  readonly expected =
    'valid editor assistance input bound to the current target and submitted frame';
  readonly hint = 'refresh the target and submitted frame, then retry the editor intent';
  constructor(
    readonly code: EditorAssistanceErrorCode,
    readonly detail: { readonly reason: string },
  ) {
    super(`${code}: ${detail.reason}`);
    this.name = 'EditorAssistanceError';
  }
}

export interface EditorAssistanceInput {
  readonly revision: number;
  readonly options: EditorAssistanceOptions;
  readonly selected: readonly EntityHandle[];
  readonly hovered: EntityHandle | undefined;
  readonly outline: Omit<OutlineSnapshot, 'entities'>;
  readonly primitives: readonly CapturedEditorAssistancePrimitive[];
  readonly meshes: readonly EditorAssistanceMeshVersion[];
}
const DEFAULT_OPTIONS: EditorAssistanceOptions = Object.freeze({
  enabled: false,
  icons: false,
  cameraFrusta: false,
  lightRanges: false,
  bounds: false,
  collision: false,
  depth: 'occluded',
});
const DEFAULT_OUTLINE: Omit<OutlineSnapshot, 'entities'> = Object.freeze({
  visibleColor: Object.freeze([1, 0.5, 0]),
  hiddenColor: Object.freeze([0.15, 0.05, 0.02]),
  width: 4,
  occlusion: 0,
});
const INPUT = defineResource<EditorAssistanceState>('EditorAssistanceInput');
const SOURCE_INPUT = Symbol('EditorAssistanceSourceInput');

function finite(values: readonly number[], count: number): boolean {
  return values.length === count && values.every(Number.isFinite);
}
function validAction(world: World, action: EditorAssistanceAction | undefined): boolean {
  if (action === undefined) return true;
  if (!world.componentsOf(action.entity).ok || !['entity', 'gizmo'].includes(action.kind))
    return false;
  if (action.kind !== 'gizmo') return true;
  return (
    typeof action.handle === 'string' &&
    action.handle.length > 0 &&
    action.handle.length <= 64 &&
    (action.interactionFrame === undefined ||
      (Number.isSafeInteger(action.interactionFrame) && action.interactionFrame >= 1))
  );
}
function validGeometry(row: EditorAssistancePrimitive): boolean {
  switch (row.kind) {
    case 'line':
      return finite(row.start, 3) && finite(row.end, 3);
    case 'mesh':
      return finite(row.transform, 16) && Number.isSafeInteger(row.mesh) && row.mesh > 0;
    case 'icon':
      return (
        finite(row.position, 3) &&
        Number.isFinite(row.pixels) &&
        row.pixels > 0 &&
        row.pixels <= 256
      );
  }
}
function validPrimitive(world: World, row: EditorAssistancePrimitive): boolean {
  return (
    ['line', 'mesh', 'icon'].includes(row.kind) &&
    (row.depth === 'always' || row.depth === 'occluded') &&
    finite(row.color, 4) &&
    !row.color.some((value) => value < 0 || value > 1) &&
    validAction(world, row.action) &&
    validGeometry(row)
  );
}
function capturePrimitive(row: EditorAssistancePrimitive): EditorAssistancePrimitive {
  const base = {
    ...row,
    color: Object.freeze([...row.color]) as EditorAssistanceColor,
    ...(row.action === undefined ? {} : { action: Object.freeze({ ...row.action }) }),
  };
  switch (row.kind) {
    case 'line':
      return Object.freeze({
        ...base,
        kind: 'line',
        start: Object.freeze([...row.start]) as EditorAssistanceVector,
        end: Object.freeze([...row.end]) as EditorAssistanceVector,
      });
    case 'mesh':
      return Object.freeze({
        ...base,
        kind: 'mesh',
        mesh: row.mesh,
        transform: Object.freeze([...row.transform]),
      });
    case 'icon':
      return Object.freeze({
        ...base,
        kind: 'icon',
        icon: row.icon,
        position: Object.freeze([...row.position]) as EditorAssistanceVector,
        pixels: row.pixels,
      });
  }
}

/** Created only by a tool that explicitly enables editor presentation. */
export class EditorAssistanceState {
  private optionsValue = DEFAULT_OPTIONS;
  private selectedValue: readonly EntityHandle[] = [];
  private hoveredValue: EntityHandle | undefined;
  private selectionOwner: object | undefined;
  private outlineValue = DEFAULT_OUTLINE;
  private readonly contributions = new Map<
    object,
    {
      readonly primitives: readonly CapturedEditorAssistancePrimitive[];
      readonly assets: readonly Pick<
        AssetVersion<MeshAsset>,
        'handle' | 'revision' | 'value' | 'dispose'
      >[];
    }
  >();
  private revisionValue = 0;
  private captured: EditorAssistanceInput | undefined;
  constructor(private readonly world: World) {}
  get revision(): number {
    return this.revisionValue;
  }
  get options(): EditorAssistanceOptions {
    return this.optionsValue;
  }
  private changed(): void {
    this.revisionValue++;
    this.captured = undefined;
  }
  configure(patch: Partial<EditorAssistanceOptions>): Result<void, EditorAssistanceError> {
    const next = { ...this.optionsValue, ...patch };
    if (
      (next.depth !== 'always' && next.depth !== 'occluded') ||
      (next.camera !== undefined && !this.world.componentsOf(next.camera).ok) ||
      ['enabled', 'icons', 'cameraFrusta', 'lightRanges', 'bounds', 'collision'].some(
        (key) => typeof next[key as keyof EditorAssistanceOptions] !== 'boolean',
      )
    )
      return err(
        new EditorAssistanceError('editor-assistance-invalid-input', { reason: 'options' }),
      );
    this.optionsValue = Object.freeze(next);
    this.changed();
    return ok(undefined);
  }
  select(
    entities: readonly EntityHandle[],
    hovered?: EntityHandle,
    owner?: object,
  ): Result<void, EditorAssistanceError> {
    if (
      entities.length > EDITOR_ASSISTANCE_LIMITS.selection ||
      [...entities, ...(hovered === undefined ? [] : [hovered])].some(
        (entity) => !this.world.componentsOf(entity).ok,
      )
    )
      return err(
        new EditorAssistanceError('editor-assistance-invalid-input', { reason: 'selection' }),
      );
    this.selectedValue = Object.freeze([...new Set(entities)]);
    this.hoveredValue = hovered;
    this.selectionOwner = owner;
    this.changed();
    return ok(undefined);
  }
  releaseSelection(owner: object): void {
    if (this.selectionOwner !== owner) return;
    this.selectedValue = [];
    this.hoveredValue = undefined;
    this.selectionOwner = undefined;
    this.changed();
  }
  style(outline: Omit<OutlineSnapshot, 'entities'>): Result<void, EditorAssistanceError> {
    if (
      !Number.isInteger(outline.width) ||
      outline.width < 0 ||
      outline.width > 8 ||
      ![0, 1, 2].includes(outline.occlusion) ||
      [outline.visibleColor, outline.hiddenColor].some(
        (color) => color.length !== 3 || color.some((v) => !Number.isFinite(v) || v < 0 || v > 1),
      )
    )
      return err(
        new EditorAssistanceError('editor-assistance-invalid-input', { reason: 'outline' }),
      );
    this.outlineValue = Object.freeze({
      ...outline,
      visibleColor: Object.freeze([...outline.visibleColor]),
      hiddenColor: Object.freeze([...outline.hiddenColor]),
    });
    this.changed();
    return ok(undefined);
  }
  /** A presentation lease replaces its complete bounded contribution, never World entities. */
  contribute(
    owner: object,
    primitives: readonly EditorAssistancePrimitive[],
  ): Result<void, EditorAssistanceError> {
    if (
      (!this.contributions.has(owner) &&
        this.contributions.size >= EDITOR_ASSISTANCE_LIMITS.contributions) ||
      primitives.length +
        [...this.contributions].reduce(
          (sum, [key, row]) => sum + (key === owner ? 0 : row.primitives.length),
          0,
        ) >
        EDITOR_ASSISTANCE_LIMITS.primitives
    )
      return err(
        new EditorAssistanceError('editor-assistance-invalid-input', { reason: 'geometry-budget' }),
      );
    const captured: EditorAssistancePrimitive[] = [];
    for (const row of primitives) {
      if (!validPrimitive(this.world, row))
        return err(
          new EditorAssistanceError('editor-assistance-invalid-input', { reason: 'geometry' }),
        );
      captured.push(capturePrimitive(row));
    }
    const assets: Array<
      Pick<AssetVersion<MeshAsset>, 'handle' | 'revision' | 'value' | 'dispose'>
    > = [];
    const fixed: CapturedEditorAssistancePrimitive[] = [];
    for (const row of captured) {
      if (row.kind !== 'mesh') {
        fixed.push(row);
        continue;
      }
      const pinned =
        this.world.assets === undefined
          ? undefined
          : runtimeAssets(this.world.assets).pin<MeshAsset>(row.mesh);
      if (!pinned?.ok || pinned.value.value.kind !== 'mesh') {
        if (pinned?.ok) pinned.value.dispose();
        for (const lease of assets) lease.dispose();
        return err(
          new EditorAssistanceError('editor-assistance-invalid-input', { reason: 'mesh-asset' }),
        );
      }
      const records =
        this.world.assets === undefined ? undefined : runtimeAssets(this.world.assets);
      const retained = records?.retain(row.mesh, 'mesh');
      if (!retained?.ok || records === undefined) {
        pinned.value.dispose();
        for (const lease of assets) lease.dispose();
        return err(
          new EditorAssistanceError('editor-assistance-invalid-input', { reason: 'mesh-asset' }),
        );
      }
      const version = pinned.value;
      let active = true;
      assets.push({
        handle: version.handle,
        revision: version.revision,
        value: version.value,
        dispose() {
          if (!active) return;
          active = false;
          version.dispose();
          records.release(row.mesh).unwrap();
        },
      });
      fixed.push(Object.freeze({ ...row, meshRevision: pinned.value.revision }));
    }
    const previous = this.contributions.get(owner);
    this.contributions.set(
      owner,
      Object.freeze({ primitives: Object.freeze(fixed), assets: Object.freeze(assets) }),
    );
    for (const lease of previous?.assets ?? []) lease.dispose();
    this.changed();
    return ok(undefined);
  }
  release(owner: object): void {
    const previous = this.contributions.get(owner);
    if (previous === undefined) return;
    this.contributions.delete(owner);
    for (const lease of previous.assets) lease.dispose();
    this.changed();
  }
  clear(): void {
    this.optionsValue = DEFAULT_OPTIONS;
    this.selectedValue = [];
    this.hoveredValue = undefined;
    this.selectionOwner = undefined;
    for (const contribution of this.contributions.values())
      for (const lease of contribution.assets) lease.dispose();
    this.contributions.clear();
    this.changed();
  }
  [SOURCE_INPUT](): EditorAssistanceInput | undefined {
    const input = this.snapshot();
    if (input === undefined) return undefined;
    return Object.freeze({
      ...input,
      meshes: Object.freeze(
        [...this.contributions.values()].flatMap((row) =>
          row.assets.map((asset) =>
            Object.freeze({
              handle: Number(asset.handle),
              revision: asset.revision,
              value: asset.value,
            }),
          ),
        ),
      ),
    });
  }
  snapshot(): EditorAssistanceInput | undefined {
    if (!this.optionsValue.enabled) return undefined;
    this.captured ??= Object.freeze({
      revision: this.revisionValue,
      options: this.optionsValue,
      selected: this.selectedValue,
      hovered: this.hoveredValue,
      outline: this.outlineValue,
      primitives: Object.freeze([...this.contributions.values()].flatMap((row) => row.primitives)),
      meshes: Object.freeze(
        [...this.contributions.values()].flatMap((row) =>
          row.assets.map((asset) =>
            Object.freeze({ handle: Number(asset.handle), revision: asset.revision }),
          ),
        ),
      ),
    });
    return this.captured;
  }
}
/** Reading a disabled ordinary game never installs a resource or starts a system. */
export function readEditorAssistance(world: World): EditorAssistanceState | undefined {
  return world.hasResource(INPUT) ? world.getResource(INPUT) : undefined;
}
export function editorAssistance(world: World): EditorAssistanceState {
  const current = readEditorAssistance(world);
  if (current !== undefined) return current;
  const state = new EditorAssistanceState(world);
  world.insertResource(INPUT, state);
  return state;
}

/** Package-internal producer borrow; fixed asset payloads are absent from public state inspection. */
export function readEditorAssistanceSource(world: World): EditorAssistanceInput | undefined {
  return readEditorAssistance(world)?.[SOURCE_INPUT]();
}
