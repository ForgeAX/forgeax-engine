import { meshDistanceFieldSource } from '@forgeax/engine-geometry';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { GpuResidencyCache } from '../device/gpu-residency';
import type { StandardProbeGlobal } from '../pipeline/standard-profile';
import { meshAttributeChannels } from '../publication/packed-rows-mesh';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import type { MaterialFrame } from '../scene/material-dispatch';
import { CardCaptureScheduler } from './card-capture-schedule';
import { packCardLookupProjections } from './card-lookup';
import { type CardResidencyFocus, cardResidencyScore, rankCardResidency } from './card-residency';
import { fieldLocalBounds, worldBounds } from './field-edit';
import {
  createGlobalSdfCardLookupRecorder,
  GLOBAL_SDF_CARD_LOOKUP_WGSL,
} from './global-card-lookup';
import type { packGlobalSdfComposition } from './global-sdf';
import { IRRADIANCE_FIELD_SURFACE_BYTES } from './irradiance-field';
import { prepareSurfaceMaterialTextures } from './material-residency';
import { createProbeCardSupportRecorder, PROBE_CARD_SUPPORT_WGSL } from './probe-card-support';
import { rayGeometryKey } from './scene';
import type { SceneFieldSource } from './scene-field-projection';
import type { SdfMeshInstance } from './sdf-query';
import {
  prepareSurfaceCapture,
  type SurfaceCapture,
  type SurfaceCaptureSource,
} from './surface-cards';

const CARD_PROJECTION_BYTES = 80;

type TexturePreparation = Extract<
  ReturnType<GpuResidencyCache['prepareTextureResidencyForGraph']>,
  { ok: true }
>['value'];
type MaterialTextures = Extract<
  ReturnType<typeof prepareSurfaceMaterialTextures>,
  { ok: true }
>['value'];
export interface ProbeCardCapture {
  readonly device: RhiDevice;
  readonly capture: SurfaceCapture;
  acceptMaterials(frame: MaterialFrame): void;
  readonly projections: { readonly buffer: Buffer; readonly size: number };
  readonly settings: { readonly buffer: Buffer; readonly size: number };
  readonly textures: readonly TexturePreparation[];
  readonly textureRevision: number;
  readonly lookup: Extract<
    ReturnType<typeof createGlobalSdfCardLookupRecorder>,
    { ok: true }
  >['value']['record'];
  readonly support: Extract<
    ReturnType<typeof createProbeCardSupportRecorder>,
    { ok: true }
  >['value']['record'];
  /**
   * Lowers one projected source instance onto Card capture input at Global row `row`.
   * Actual capture work pulls current native texture and sampler residency on demand.
   */
  readonly lower: (
    source: SceneFieldSource,
    instance: SdfMeshInstance,
    row: number,
  ) => SurfaceCaptureSource;
  readonly current: () => boolean;
  readonly commit: () => boolean;
  readonly release: () => void;
  readonly track: (done: Promise<unknown>) => void;
  /** Progressive budgeted atlas capture, shared by every Card consumer. */
  readonly schedule: CardCaptureScheduler;
}

/** Retained source identities are reused; Card geometry is not reconstructed from visible draws. */
export async function prepareProbeCards(
  runtime: RenderSystemInternals,
  sources: readonly SceneFieldSource[],
  instances: readonly SdfMeshInstance[],
  globalSources: Extract<
    ReturnType<typeof packGlobalSdfComposition>,
    { ok: true }
  >['value']['sources'],
  profile: NonNullable<StandardProbeGlobal['cards']>,
  /**
   * Reserve atlas tiles and lookup rows for in-place adds, in residency mode: a
   * scene past the Card ceilings installs its highest-priority prefix (nearest
   * `focus` first) and streams the rest.
   */
  editable = false,
  focus?: CardResidencyFocus,
): Promise<ProbeCardCapture> {
  const { device, shaderRegistry: shaders, createShaderModule: compile, gpuStore: store } = runtime;
  const sampler = runtime.getPipelineState()?.defaultSampler;
  if (shaders === undefined || compile === undefined || sampler === undefined)
    throw new Error(
      'native Card capture requires the accepted Renderer shader and material binding owners',
    );
  if (!Number.isSafeInteger(profile.maxCaptureBytes) || profile.maxCaptureBytes < 1)
    throw new Error('native Card capture requires a positive explicit capture byte budget');
  interface PoolEntry {
    readonly preparation: TexturePreparation;
    readonly revision: number | undefined;
    readonly scope: RenderResourceScope;
    readonly handle: number;
    references: number;
  }
  const pools = new Map<RenderResourceScope, Map<number, PoolEntry>>();
  const textureEntries: TexturePreparation[] = [];
  const textureIndices = new Map<TexturePreparation, number>();
  const pendingTextures = new Set<PoolEntry>();
  const materials = new Set<MaterialTextures>();
  let textureRevision = 0;
  const releasePool = (entry: PoolEntry) => {
    if (entry.references !== 0) return;
    const pool = pools.get(entry.scope);
    if (pool?.get(entry.handle) === entry) pool.delete(entry.handle);
    pendingTextures.delete(entry);
    const index = textureIndices.get(entry.preparation);
    if (index === undefined) return;
    textureIndices.delete(entry.preparation);
    const tail = textureEntries.pop();
    if (tail !== undefined && tail !== entry.preparation) {
      textureEntries[index] = tail;
      textureIndices.set(tail, index);
    }
    textureRevision++;
    void entry.preparation.lease.release(false);
  };
  const referenceTexture = (
    scope: RenderResourceScope,
    handle: import('@forgeax/engine-types').AssetHandle<'texture'>,
    payload: import('@forgeax/engine-types').TextureAsset,
  ) => {
    let pool = pools.get(scope);
    if (pool === undefined) {
      pool = new Map();
      pools.set(scope, pool);
    }
    let entry = pool.get(handle);
    const revision = scope.assetRevision(handle);
    if (entry === undefined || entry.revision !== revision || !entry.preparation.current()) {
      const result = store.prepareTextureResidencyForGraph(handle, payload, scope);
      if (!result.ok) return result;
      const base = result.value;
      const next: PoolEntry = {
        preparation: {
          ...base,
          get needsMipmaps() {
            return pendingTextures.has(next) && base.needsMipmaps;
          },
        },
        revision,
        scope,
        handle,
        references: 0,
      };
      if (entry !== undefined) {
        pendingTextures.delete(entry);
        releasePool(entry);
      }
      entry = next;
      pool.set(handle, entry);
      textureIndices.set(entry.preparation, textureEntries.length);
      textureEntries.push(entry.preparation);
      pendingTextures.add(entry);
      textureRevision++;
    }
    const retained = entry;
    retained.references++;
    let released = false;
    return ok({
      ...entry.preparation,
      lease: {
        track: (done: Promise<unknown>) => retained.preparation.lease.track(done),
        release: (): undefined => {
          if (released) return;
          released = true;
          retained.references--;
          releasePool(retained);
        },
      },
    });
  };
  const nativeMaterials = new WeakMap<
    object,
    {
      textures(): MaterialTextures | undefined;
      snapshot(): import('../render-system-extract').MaterialSnapshot | undefined;
      refresh(snapshot: import('../render-system-extract').MaterialSnapshot): void;
      release(): void;
    }
  >();
  const prepared: SurfaceCaptureSource[] = [];
  const priorities: number[] = [];
  const owned: Buffer[] = [];
  let capture: SurfaceCapture | undefined;
  let materialFrame: MaterialFrame | undefined;
  let released = false;
  const generation = runtime.deviceScope.generation;
  // The region/field owner validates its source revision. An editable field
  // advances that revision while retaining these same native Card resources.
  const current = () => !released && runtime.deviceScope.generation === generation;
  const release = () => {
    if (released) return;
    released = true;
    capture?.dispose();
    for (const buffer of owned) device.destroyBuffer(buffer);
    for (const material of materials) void material.release();
    for (const texture of [...textureEntries]) void texture.lease.release(false);
    textureEntries.length = 0;
    textureIndices.clear();
    pendingTextures.clear();
  };
  const geometries = new WeakMap<
    object,
    {
      field: SceneFieldSource['field'];
      positions: SurfaceCaptureSource['instance']['positions'];
      indices: SurfaceCaptureSource['instance']['indices'];
      normals: Float32Array | undefined;
      tangents: Float32Array | undefined;
      colors: Float32Array | undefined;
      uvSets: Float32Array[];
      attributeKeys: unknown[];
    }
  >();
  const meshGeometry = (source: SceneFieldSource) => {
    const { mesh } = source;
    const cached = geometries.get(mesh);
    if (cached !== undefined && cached.field === source.field) return cached;
    const geometry = meshDistanceFieldSource(mesh, {
      sectionSidedness: source.field.sectionSidedness,
    }).unwrap();
    const channels = meshAttributeChannels(mesh);
    const attribute = (name: keyof MeshAsset['attributes']) => {
      const value = channels[name];
      if (value === undefined) return undefined;
      if (value instanceof Float32Array) return value.slice();
      if (value instanceof ArrayBuffer && value.byteLength % 4 === 0)
        return new Float32Array(value.slice(0));
      throw new Error(`native Card attribute ${name} requires float32 source data`);
    };
    const normals = attribute('normal'),
      tangents = attribute('tangent'),
      colors = attribute('color');
    const uvSets: Float32Array[] = [];
    for (const [i, name] of (
      ['uv', 'uv1', 'uv2', 'uv3', 'uv4', 'uv5', 'uv6', 'uv7'] as const
    ).entries()) {
      const uv = attribute(name);
      if (uv === undefined) continue;
      if (uvSets.length !== i) throw new Error('native Card source has a gap in authored UV sets');
      uvSets.push(uv);
    }
    const attributeKeys = [normals, tangents, colors, ...uvSets].map((value) =>
      value === undefined
        ? null
        : [
            value.length,
            bytesToHex(sha256(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))),
          ],
    );
    const value = {
      field: source.field,
      positions: geometry.positions.slice(),
      indices: geometry.indices.slice(),
      normals,
      tangents,
      colors,
      uvSets,
      attributeKeys,
    };
    geometries.set(mesh, value);
    return value;
  };
  const lowerSections = (source: SceneFieldSource) => {
    const { mesh, scope } = source;
    const sectionInputs: SurfaceCaptureSource['sections'][number][] = [];
    const materialKeys: unknown[] = [];
    let offset = 0;
    for (const [sectionIndex, section] of mesh.submeshes.entries()) {
      const accepted = source.materials[sectionIndex];
      if (accepted === undefined || accepted.materialSlot !== section.materialSlot)
        throw new Error('native Card section must retain its actual accepted material slot');
      const snapshot = materialFrame?.get(accepted.resource)?.snapshot ?? accepted.snapshot;
      const selected = snapshot.materialSurfacePrograms?.['card-capture'];
      if (selected === undefined)
        throw new Error(`native Card material ${accepted.handle} has no published Card derivative`);
      const artifact = shaders.findMaterialArtifact(selected.programKey).unwrap();
      let native = nativeMaterials.get(accepted.resource);
      if (native === undefined) {
        let active: MaterialTextures | undefined;
        let acceptedSnapshot: import('../render-system-extract').MaterialSnapshot | undefined;
        native = {
          snapshot: () => acceptedSnapshot,
          textures: () => active,
          refresh: (snapshot) => {
            const next = prepareSurfaceMaterialTextures(
              store,
              sampler,
              artifact.paramSchema,
              scope,
              snapshot,
              (handle, payload) => referenceTexture(scope, handle, payload),
            ).unwrap();
            const previous = active;
            active = next;
            acceptedSnapshot = snapshot;
            materials.add(next);
            if (previous !== undefined) {
              materials.delete(previous);
              void previous.release();
            }
          },
          release: () => {
            const previous = active;
            active = undefined;
            acceptedSnapshot = undefined;
            if (previous !== undefined) {
              materials.delete(previous);
              void previous.release();
            }
          },
        };
        native.refresh(snapshot);
        nativeMaterials.set(accepted.resource, native);
      } else if (native.snapshot() !== snapshot || native.textures()?.current() !== true)
        native.refresh(snapshot);
      const textures = native.textures();
      if (textures === undefined)
        throw new Error('native Card texture preparation did not complete');
      const indexCount = mesh.indices === undefined ? section.vertexCount : section.indexCount;
      sectionInputs.push({
        indexOffset: mesh.indices === undefined ? offset : section.indexOffset,
        indexCount,
        material: {
          id: sectionIndex,
          identity: accepted.resource,
          scope,
          snapshot,
          refreshTextures: native.refresh,
          releaseTextures: native.release,
          program: artifact,
          resolveTexture: (parameter) => {
            if (native.textures() === undefined) native.refresh(snapshot);
            const texture = native.textures()?.textures.get(parameter);
            if (texture === undefined) throw new Error(`native Card material lost ${parameter}`);
            return ok(texture);
          },
        },
      });
      offset += indexCount;
      materialKeys.push([
        section.materialSlot,
        accepted.handle,
        selected.programKey,
        artifact.program.identity,
        snapshot.paramSnapshot,
        [...(snapshot.textureCoordinates ?? [])],
        snapshot.renderState,
        textures.contentKey,
      ]);
    }
    return { sectionInputs, materialKeys };
  };
  const lowerInstance = (
    source: SceneFieldSource,
    sections: ReturnType<typeof lowerSections>,
    instance: SdfMeshInstance,
    row: number,
    ordinal: number,
  ): SurfaceCaptureSource => {
    const { mesh } = source;
    if (mesh.cardLayout === undefined)
      throw new Error(
        `native Card source ${source.worldId}:${source.entityKey}:${source.slot} has no cooked whole-Mesh cardLayout`,
      );
    const geometry = meshGeometry(source);
    const cardInstance = {
      instanceId: row,
      geometryId: instance.geometryId,
      mask: instance.mask,
      transform: Array.from(instance.transform),
      positions: geometry.positions,
      indices: geometry.indices,
      uvSets: geometry.uvSets,
      ...(geometry.normals === undefined ? {} : { normals: geometry.normals }),
      ...(geometry.tangents === undefined ? {} : { tangents: geometry.tangents }),
      ...(geometry.colors === undefined ? {} : { colors: geometry.colors }),
    };
    return {
      instance: cardInstance,
      layout: mesh.cardLayout,
      sections: sections.sectionInputs,
      captureKey: JSON.stringify([
        rayGeometryKey(cardInstance, mesh.cardLayout.meshDigest),
        mesh.cardLayout,
        geometry.attributeKeys,
        sections.materialKeys,
        source.instances?.generations?.[ordinal] ?? 0,
      ]),
    };
  };
  try {
    for (const source of sources) {
      if (source.mesh.cardLayout === undefined)
        throw new Error(
          `native Card source ${source.worldId}:${source.entityKey}:${source.slot} has no cooked whole-Mesh cardLayout`,
        );
      const sections = lowerSections(source);
      for (let ordinal = 0; ordinal < (source.instances?.instanceCount ?? 1); ordinal++) {
        const instance = instances[source.firstInstance + ordinal];
        if (instance === undefined)
          throw new Error('native Card source lost its retained Global instance');
        prepared.push(lowerInstance(source, sections, instance, instance.instanceId, ordinal));
        priorities.push(
          cardResidencyScore(
            worldBounds(fieldLocalBounds(instance), instance.transform),
            focus === undefined ? [] : [focus],
          ),
        );
      }
    }
    const ordered = editable
      ? rankCardResidency(prepared.map((_, i) => ({ row: i, score: priorities[i] ?? 0 }))).flatMap(
          (i) => prepared[i] ?? [],
        )
      : prepared;
    capture = (
      await prepareSurfaceCapture(
        device,
        compile,
        ordered,
        {
          kind: 'cards',
          resolution: profile.resolution,
        },
        profile.maxCaptureBytes,
        editable
          ? Math.max(
              64,
              prepared.reduce((n, p) => n + p.layout.cards.length, 0),
            )
          : 0,
        editable
          ? {
              maxTexels: Math.floor(
                device.limits.maxStorageBufferBindingSize / IRRADIANCE_FIELD_SURFACE_BYTES,
              ),
            }
          : undefined,
      )
    ).unwrap();
    const packedProjections = packCardLookupProjections(
      capture,
      globalSources.map((s) => ({ instanceId: s.instanceId, key: s.geometryKey })),
      prepared,
    );
    let projectionBytes = packedProjections.bytes;
    if (editable) {
      // Spare lookup rows match no instance until an add claims their tiles.
      projectionBytes = new Uint8Array(Math.max(1, capture.capacity) * CARD_PROJECTION_BYTES);
      projectionBytes.set(packedProjections.bytes.subarray(0, packedProjections.count * 80));
      const view = new DataView(projectionBytes.buffer);
      for (let row = packedProjections.count; row < capture.capacity; row++)
        view.setUint32(row * CARD_PROJECTION_BYTES + 64, 0xffffffff, true);
    }
    const projections = { bytes: projectionBytes, count: packedProjections.count };
    const buffer = (label: string, data: Uint8Array, uniform = false) => {
      const value = device
        .createBuffer({ label, size: data.byteLength, usage: (uniform ? 64 : 128) | 12 })
        .unwrap();
      owned.push(value);
      device.queue.writeBuffer(value, 0, data).unwrap();
      return { buffer: value, size: data.byteLength };
    };
    const cards = buffer('probe-global.card-projections', projections.bytes);
    const settings = buffer(
      'probe-global.card-settings',
      new Uint8Array(new Uint32Array([projections.count, capture.resolution, 0, 0]).buffer),
      true,
    );
    const lookup = createGlobalSdfCardLookupRecorder(
      device,
      (
        await compile(device, { code: GLOBAL_SDF_CARD_LOOKUP_WGSL, label: 'probe-global.cards' })
      ).unwrap(),
    ).unwrap();
    const support = createProbeCardSupportRecorder(
      device,
      (
        await compile(device, { code: PROBE_CARD_SUPPORT_WGSL, label: 'probe-global.card-support' })
      ).unwrap(),
    ).unwrap();
    return {
      device,
      capture,
      acceptMaterials: (frame) => {
        materialFrame = frame;
      },
      lower: (source, instance, row) => {
        if (released) throw new Error('native Card capture is released');
        const ordinal = instance.instanceId - source.firstInstance;
        return lowerInstance(source, lowerSections(source), instance, row, ordinal);
      },
      projections: cards,
      settings,
      textures: textureEntries,
      get textureRevision() {
        return textureRevision;
      },
      lookup: lookup.record,
      support: support.record,
      schedule: new CardCaptureScheduler(capture.allocatedTiles, profile.budget),
      current,
      commit: () => {
        if (!current()) return false;
        for (const entry of pendingTextures) {
          if (
            entry.scope.assetRevision(entry.handle) !== entry.revision ||
            entry.preparation.entry.texture.isDestroyed
          )
            return false;
          // Another view can publish a same-source allocation first. This submitted
          // capture still owns its private allocation and its completed mip writers.
          entry.preparation.commit();
          pendingTextures.delete(entry);
          textureRevision++;
        }
        return true;
      },
      track: (done) => {
        for (const texture of textureEntries) texture.lease.track(done);
        capture?.track(done);
      },
      release,
    };
  } catch (cause) {
    release();
    throw cause;
  }
}
