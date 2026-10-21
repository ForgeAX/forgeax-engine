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
  sortDispatchByQueue,
} from './render-system-extract';
import type { MaterialFrame } from './scene/material-dispatch';

/** Retained author facts; Font content and generated geometry remain shared owners. */
export interface GlyphRenderSource {
  readonly font: AssetHandle<'font'>;
  readonly text: string;
  readonly size: number;
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

interface FontContent {
  readonly font: FontAsset;
  /** Bounded by generated layout bytes, independent of entity count and color changes. */
  readonly layouts: Map<string, Map<number, MeshAsset>>;
  readonly materials: WeakMap<GlyphRenderSource, MaterialResource>;
  readonly colors: Map<string, MaterialResource>;
  base?: MaterialSnapshot;
  bytes: number;
}

/** Adopts only changed Font roots. No entity catalogue or Font-to-label reverse index. */
export class GlyphSources {
  private worlds = new WeakMap<RenderResourceScope, Map<number, FontContent>>();

  private content(world: RenderResourceScope, handle: AssetHandle<'font'>): FontContent {
    let roots = this.worlds.get(world);
    const cached = roots?.get(handle);
    if (cached !== undefined) return cached;
    const font = world.resolveAsset<FontAsset>(handle).unwrap();
    if (font.kind !== 'font' || typeof font.atlas !== 'number' || typeof font.sampler !== 'number')
      throw new TextError({
        code: 'font-atlas-missing',
        expected: 'a managed Font with its complete atlas/sampler closure',
        hint: 'load or create the Font through its asset owner before binding GlyphText',
      });
    const content: FontContent = {
      font: structuredClone(font),
      layouts: new Map(),
      materials: new WeakMap(),
      colors: new Map(),
      bytes: 0,
    };
    if (roots === undefined) {
      roots = new Map();
      this.worlds.set(world, roots);
    }
    roots.set(handle, content);
    return content;
  }

  adopt(world: RenderResourceScope, changes: readonly AssetChange[]): void {
    const roots = this.worlds.get(world);
    if (roots === undefined) return;
    for (const change of changes) roots.delete(change.handle);
  }

  resolve(
    world: RenderResourceScope,
    source: GlyphRenderSource,
    assets: AssetRegistry,
  ): {
    readonly mesh: MeshAsset;
    readonly material: MaterialResource;
  } {
    const content = this.content(world, source.font);
    let sizes = content.layouts.get(source.text);
    let mesh = sizes?.get(source.size);
    if (mesh === undefined) {
      mesh = buildGlyphMeshAsset(layoutGlyphText(content.font, source.text, source.size));
      const bytes =
        mesh.vertices.byteLength * 2 + (mesh.indices?.byteLength ?? 0) + source.text.length * 2;
      if (content.bytes + bytes > 16 * 1024 * 1024) {
        content.layouts.clear();
        content.bytes = 0;
        sizes = undefined;
      }
      if (sizes === undefined) {
        sizes = new Map();
        content.layouts.set(source.text, sizes);
      }
      if (bytes <= 16 * 1024 * 1024) {
        sizes.set(source.size, mesh);
        content.bytes += bytes;
      }
    }
    let material = content.materials.get(source);
    if (material === undefined) {
      const font = content.font;
      const key = source.color.join(',');
      material = content.colors.get(key);
      const snapshot =
        content.base ??
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
              tintColor: source.color,
              distanceRange: [
                font.common.distanceRange,
                font.common.atlasWidth,
                font.common.atlasHeight,
                0,
              ],
              baseColorTexture: { texture: font.atlas, sampler: font.sampler },
            },
          },
        });
      content.base = snapshot;
      if (material === undefined) {
        material = MaterialResource.from({
          ...snapshot,
          paramSnapshot: { ...snapshot.paramSnapshot, tintColor: [...source.color] },
          immutableValues: true,
        });
        if (content.colors.size >= 256)
          content.colors.delete(content.colors.keys().next().value as string);
        content.colors.set(key, material);
      }
      content.materials.set(source, material);
    }
    return { mesh, material };
  }

  detach(world: RenderResourceScope): void {
    this.worlds.delete(world);
  }
  clear(): void {
    this.worlds = new WeakMap();
  }
}

/** Snapshot changed component rows; layout is deferred until actual view consumption. */
export function extractGlyphSources(
  world: World,
  worldId: number,
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
        color: [glyph.color[0] ?? 1, glyph.color[1] ?? 1, glyph.color[2] ?? 1, glyph.color[3] ?? 1],
      },
      transform: { world: new Float32Array(matrix) },
      worldId,
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
    for (const entity of selected) append(entity as EntityHandle);
  } else
    for (const row of world.query({ read: [GlyphText, Transform, GlobalTransform] }).unwrap())
      append(row.entity);
}

/** Actual draw work may scale with labels; an asset update only replaces its shared Font root. */
export function projectGlyphView(
  frame: ExtractedFrame,
  materials: MaterialFrame,
  worlds: readonly RenderResourceScope[],
  sources: GlyphSources,
  assets: AssetRegistry | undefined,
  hasSources = frame.renderables.some((source) => source.glyph !== undefined),
): { frame: ExtractedFrame; materials: MaterialFrame } {
  if (!hasSources) return { frame, materials };
  const dispatch: DispatchEntry[] = [...frame.dispatch];
  const renderables = frame.renderables.map((source, index) => {
    if (
      source.glyph === undefined ||
      source.authorVisible === false ||
      source.glyph.text.length === 0
    )
      return source;
    const world = worlds[source.worldId];
    if (world === undefined) throw new Error('GlyphText requires its source resource scope');
    if (assets === undefined) throw new Error('GlyphText requires the renderer asset service');
    const { mesh, material } = sources.resolve(world, source.glyph, assets);
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
    const matrix = new Float32Array(16);
    matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
    matrix[12] = source.transform.world[12] ?? 0;
    matrix[13] = source.transform.world[13] ?? 0;
    matrix[14] = source.transform.world[14] ?? 0;
    return {
      ...source,
      transform: { world: matrix },
      generatedMesh: mesh,
      ...(mesh.aabb === undefined ? {} : { localAabb: mesh.aabb }),
      material,
      materials: [material],
    };
  });
  return { frame: { ...frame, renderables, dispatch: sortDispatchByQueue(dispatch) }, materials };
}
