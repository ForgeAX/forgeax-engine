import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetChange } from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { buildGlyphMeshAsset, layoutGlyphText } from '@forgeax/engine-graphics-extras';
import { GlobalTransform, readPresentationWorldMatrix, Transform } from '@forgeax/engine-scene';
import {
  type AssetHandle,
  type FontAsset,
  type MaterialAsset,
  type MeshAsset,
  TextError,
} from '@forgeax/engine-types';
import { GlyphText } from './components/glyph-text';
import { Layer } from './components/layer';
import { MaterialResource } from './material-resource';
import type { RenderResourceScope } from './publication/resource-scope';
import {
  appendMaterialDispatchEntries,
  type DispatchEntry,
  defaultMaterialSnapshot,
  type ExtractedFrame,
  type MaterialSnapshot,
  prepareMaterialSnapshot,
  type RenderableSnapshot,
} from './render-system-extract';
import {
  appendGeneratedQueue,
  captureGeneratedQueueSource,
  type MaterialFrame,
} from './scene/material-dispatch';
import { slotContent } from './scene/mesh-draw';
import type { RenderSceneApplyResult, RenderSceneSlot } from './scene/render-scene-types';
import { projectViewSources } from './scene/render-scene-view';

/** Retained author facts; Font content and generated geometry remain shared owners. */
export interface GlyphRenderSource {
  readonly font: AssetHandle<'font'>;
  readonly text: string;
  readonly size: number;
  readonly worldOriented: boolean;
  readonly color: readonly [number, number, number, number];
}

const rootMaterial = MaterialResource.from({ ...defaultMaterialSnapshot(), passes: [] });
const textPasses: NonNullable<MaterialAsset['passes']> = [
  {
    name: 'text',
    program: { module: 'forgeax::msdf-text' },
    renderState: {
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
      cullMode: 'none',
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
      tags: { LightMode: 'Forward' },
      queue: 3000,
    },
  },
];

interface GlyphLayout {
  readonly text: string;
  readonly size: number;
  readonly mesh: MeshAsset;
  users: number;
}

interface GlyphInk {
  readonly key: string;
  readonly mode: boolean;
  readonly color: readonly number[];
  readonly material: MaterialResource;
  users: number;
}

interface GlyphDraw {
  readonly mesh: MeshAsset;
  readonly material: MaterialResource;
}

interface LabelProducts {
  layout?: GlyphLayout;
  ink?: GlyphInk;
  draw?: GlyphDraw;
}

interface FontContent {
  readonly font: FontAsset;
  readonly labels: Map<number, LabelProducts>;
  readonly layouts: Map<string, Map<number, GlyphLayout>>;
  readonly inks: Map<string, GlyphInk>;
  readonly bases: [MaterialSnapshot | undefined, MaterialSnapshot | undefined];
}

/** Scene rows own each requested product. Tint and pose changes preserve a still-used layout. */
function releaseChangedProducts(
  font: FontContent,
  label: LabelProducts,
  next?: GlyphRenderSource,
): void {
  const { layout, ink } = label;
  if (layout !== undefined && (layout.text !== next?.text || layout.size !== next?.size)) {
    if (--layout.users === 0) {
      const sizes = font.layouts.get(layout.text);
      sizes?.delete(layout.size);
      if (sizes?.size === 0) font.layouts.delete(layout.text);
    }
    delete label.layout;
    delete label.draw;
  }
  if (
    ink !== undefined &&
    (next === undefined ||
      ink.mode !== next.worldOriented ||
      ink.color[0] !== next.color[0] ||
      ink.color[1] !== next.color[1] ||
      ink.color[2] !== next.color[2] ||
      ink.color[3] !== next.color[3])
  ) {
    if (--ink.users === 0) font.inks.delete(ink.key);
    delete label.ink;
    delete label.draw;
  }
}

function acquireGlyphInk(
  content: FontContent,
  world: RenderResourceScope,
  assets: AssetRegistry,
  source: GlyphRenderSource,
): GlyphInk {
  const mode = source.worldOriented ? 1 : 0;
  const key = `${mode}:${source.color.join(',')}`;
  const shared = content.inks.get(key);
  if (shared !== undefined) return shared;
  const font = content.font;
  const snapshot =
    content.bases[mode] ??
    prepareMaterialSnapshot({
      handle: 0,
      world,
      assets,
      programSelections: undefined,
      material: {
        kind: 'material',
        passes: textPasses,
        colorSpace: 'linear',
        parameters: [
          { name: 'tintColor', type: 'color', default: [1, 1, 1, 1] },
          { name: 'distanceRange', type: 'vec4', default: [4, 512, 512, 0] },
          { name: 'baseColorTexture', type: 'texture' },
          { name: 'metallicRoughnessTexture', type: 'texture', optional: true },
          { name: 'normalTexture', type: 'texture', optional: true },
        ],
        values: {
          tintColor: [1, 1, 1, 1],
          distanceRange: [
            font.common.distanceRange,
            font.common.atlasWidth,
            font.common.atlasHeight,
            mode,
          ],
          baseColorTexture: { texture: font.atlas, sampler: font.sampler },
        },
      },
    });
  content.bases[mode] = snapshot;
  const color = [...source.color];
  const material = MaterialResource.from({
    ...snapshot,
    paramSnapshot: { ...snapshot.paramSnapshot, tintColor: color },
    immutableValues: true,
  });
  return { key, mode: source.worldOriented, color, material, users: 0 };
}

export class GlyphSources {
  private source: RenderResourceScope | undefined;
  private readonly roots = new Map<number, FontContent>();
  private rootsFor(source: RenderResourceScope): Map<number, FontContent> {
    if (this.source !== source) {
      this.clear();
      this.source = source;
    }
    return this.roots;
  }

  private content(world: RenderResourceScope, handle: AssetHandle<'font'>): FontContent {
    const roots = this.rootsFor(world);
    const current = roots.get(handle);
    if (current !== undefined) return current;
    const font = world.resolveAsset<FontAsset>(handle).unwrap();
    if (font.kind !== 'font' || typeof font.atlas !== 'number' || typeof font.sampler !== 'number')
      throw new TextError({
        code: 'font-atlas-missing',
        expected: 'a managed Font with its complete atlas/sampler closure',
        hint: 'load or create the Font through its asset owner before binding GlyphText',
      });
    const content: FontContent = {
      font: structuredClone(font),
      labels: new Map(),
      layouts: new Map(),
      inks: new Map(),
      bases: [undefined, undefined],
    };
    return content;
  }

  adopt(world: RenderResourceScope, changes: readonly AssetChange[]): void {
    const roots = this.rootsFor(world);
    for (const change of changes) roots.delete(change.handle);
  }

  /** Only the changed or retired authored rows can withdraw previously requested products. */
  adoptRows(delta: RenderSceneApplyResult): void {
    if (this.roots.size === 0) return;
    for (const row of delta.removedSlots) this.withdraw(row);
    for (const row of delta.recreatedSlots) {
      const before = delta.previous.get(row);
      if (before !== undefined) this.withdraw(before);
    }
    for (const row of delta.contentUpdatedSlots) {
      const before = delta.previous.get(row);
      if (before !== undefined) this.withdraw(before, row);
    }
  }

  private withdraw(before: RenderSceneSlot, after?: RenderSceneSlot): void {
    const handle = slotContent(before).glyph?.font;
    if (handle === undefined) return;
    const font = this.roots.get(handle);
    const label = font?.labels.get(before.entityKey);
    if (label === undefined || font === undefined) return;
    const source = after === undefined ? undefined : slotContent(after);
    const next = source?.authorVisible === false ? undefined : source?.glyph;
    if (next?.font === handle && next.text.length > 0) {
      releaseChangedProducts(font, label, next);
      return;
    }
    releaseChangedProducts(font, label);
    font.labels.delete(before.entityKey);
    if (font.labels.size === 0) this.roots.delete(handle);
  }

  resolve(
    world: RenderResourceScope,
    entity: number,
    source: GlyphRenderSource,
    assets: AssetRegistry,
  ): GlyphDraw {
    const font = this.content(world, source.font);
    let label = font.labels.get(entity);
    if (label !== undefined) {
      releaseChangedProducts(font, label, source);
      if (label.draw !== undefined) return label.draw;
    } else {
      label = {};
    }
    const sizes = font.layouts.get(source.text);
    const layout = label.layout ??
      sizes?.get(source.size) ?? {
        text: source.text,
        size: source.size,
        users: 0,
        mesh: buildGlyphMeshAsset(layoutGlyphText(font.font, source.text, source.size)),
      };
    const ink = label.ink ?? acquireGlyphInk(font, world, assets, source);
    // Both builders succeeded. Only now publish the row's ownership.
    if (label.layout === undefined) {
      if (layout.users++ === 0) {
        const active = sizes ?? new Map<number, GlyphLayout>();
        active.set(source.size, layout);
        if (sizes === undefined) font.layouts.set(source.text, active);
      }
      label.layout = layout;
    }
    if (label.ink === undefined) {
      if (ink.users++ === 0) font.inks.set(ink.key, ink);
      label.ink = ink;
    }
    label.draw = { mesh: layout.mesh, material: ink.material };
    font.labels.set(entity, label);
    if (font.labels.size === 1) this.roots.set(source.font, font);
    return label.draw;
  }

  detach(world: RenderResourceScope): void {
    if (this.source === world) this.clear();
  }
  clear(): void {
    this.roots.clear();
    this.source = undefined;
  }
}

/** Snapshot changed component rows; layout is deferred until actual view consumption. */
export function extractGlyphSources(
  world: World,
  renderables: RenderableSnapshot[],
  selected?: ReadonlySet<number>,
  visibility?: { effective(entity: number): string },
  retainHidden = false,
  hidden?: Set<number>,
): void {
  const append = (entity: EntityHandle) => {
    const data = world.get(entity, GlyphText);
    if (!data.ok || data.value.fontHandle === 0) return;
    const matrix = readPresentationWorldMatrix(world, entity);
    if (matrix === undefined) return;
    const visible = visibility?.effective(entity) !== 'hidden';
    if (!visible) {
      hidden?.add(entity);
      if (!retainHidden) return;
    }
    const glyph = data.value;
    if (
      !Number.isFinite(glyph.fontSize) ||
      glyph.fontSize <= 0 ||
      !Array.from(glyph.color).every(Number.isFinite)
    )
      throw new TextError({
        code: 'glyph-layout-failed',
        expected: 'a positive finite fontSize and finite RGBA color',
        hint: 'repair the GlyphText component values',
      });
    const layer = world.get(entity, Layer);
    renderables.push({
      glyph: {
        font: glyph.fontHandle,
        text: glyph.text,
        size: glyph.fontSize,
        worldOriented: glyph.worldOriented,
        color: [glyph.color[0] ?? 1, glyph.color[1] ?? 1, glyph.color[2] ?? 1, glyph.color[3] ?? 1],
      },
      transform: { world: new Float32Array(matrix) },
      entityKey: entity,
      material: rootMaterial,
      materials: [rootMaterial],
      materialBindingSources: ['mesh-default'],
      shadowCaster: false,
      layer: layer.ok ? layer.value.value : 0,
      ...(visible ? {} : { authorVisible: false }),
    });
  };
  if (selected !== undefined) {
    // The changed set spans every renderable kind; a component miss would allocate an error per entity.
    for (const entity of selected)
      if (world.hasComponent(entity as EntityHandle, GlyphText)) append(entity as EntityHandle);
  } else
    for (const querySpan of world
      .query({ read: [GlyphText, Transform, GlobalTransform] })
      .unwrap()
      .spans()
      .unwrap()) {
      const queryEntities = querySpan.entities;
      for (let queryIndex = 0; queryIndex < querySpan.length; queryIndex++) {
        const queriedEntity = queryEntities[queryIndex] as EntityHandle;
        append(queriedEntity);
      }
    }
}

/** Actual draw work may scale with labels; an asset update only replaces its shared Font root. */
export function projectGlyphView(
  frame: ExtractedFrame,
  materials: MaterialFrame,
  sourceScope: RenderResourceScope,
  sources: GlyphSources,
  assets: AssetRegistry | undefined,
  hasSources = frame.renderables.some((source) => source.glyph !== undefined),
): { frame: ExtractedFrame; materials: MaterialFrame } {
  if (!hasSources) return { frame, materials };
  const base = captureGeneratedQueueSource(frame.dispatch);
  const dispatch: DispatchEntry[] = [];
  const renderables = projectViewSources(frame.renderables, (source, index) => {
    if (
      source.glyph === undefined ||
      source.authorVisible === false ||
      source.glyph.text.length === 0
    )
      return source;
    const world = sourceScope;
    if (world === undefined) throw new Error('GlyphText requires its source resource scope');
    if (assets === undefined) throw new Error('GlyphText requires the renderer asset service');
    const { mesh, material } = sources.resolve(world, source.entityKey, source.glyph, assets);
    if (mesh.indices?.length === 0) return source;
    materials = materials.with(material);
    appendMaterialDispatchEntries(
      dispatch,
      material.snapshot.passes,
      source.entityKey as EntityHandle,
      0,
      index,
      source.layer ?? 0,
    );
    // Billboards keep only the anchor; world-oriented labels keep rotation and scale too.
    let matrix = source.transform.world;
    if (!source.glyph.worldOriented) {
      matrix = new Float32Array(16);
      matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
      matrix[12] = source.transform.world[12] ?? 0;
      matrix[13] = source.transform.world[13] ?? 0;
      matrix[14] = source.transform.world[14] ?? 0;
    }
    return {
      ...source,
      transform: { world: matrix },
      generatedMesh: mesh,
      ...(mesh.aabb === undefined ? {} : { localAabb: mesh.aabb }),
      material,
      materials: [material],
    };
  });
  return {
    frame: { ...frame, renderables, dispatch: appendGeneratedQueue(base, dispatch) },
    materials,
  };
}
