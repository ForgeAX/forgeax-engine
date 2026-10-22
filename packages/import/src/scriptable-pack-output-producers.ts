import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  ANIMATION_CLIP_SAMPLES_ARTIFACT,
  encodeAnimationClipSamples,
} from '@forgeax/engine-pack/runtime';
import type { ScriptablePackSceneComponent } from '@forgeax/engine-pack/source';
import { externalizeSceneAsset } from '@forgeax/engine-scene';
import type {
  AnimationClip,
  AnimationGraph,
  AssetGuid as AssetGuidType,
  AssetHandle,
  AssetRef,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  IesProfileAsset,
  ImportedArtifactBody,
  MaterialAsset,
  MaterialTextureReference,
  MaterialTextureValue,
  MeshAsset,
  ParticleEffectAsset,
  RenderPipelineAsset,
  SamplerAsset,
  SceneAsset,
  SkeletonAsset,
  SkinAsset,
  TerrainAsset,
  TextureAsset,
  TilesetAsset,
  VideoAsset,
} from '@forgeax/engine-types';
import {
  canonicalJson,
  deriveTextureLayout,
  err,
  ImportError,
  isMaterialTextureParameterType,
  MATERIAL_TEXTURE_SLOTS,
  ok,
} from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { packMeshBin } from './mesh-bin.js';
import { encodeMeshDistanceFieldProduct } from './mesh-distance-field-product';
import {
  type AssetOutputInput,
  type AssetOutputProducer,
  AssetOutputProducerRegistry,
  type AssetOutputProduct,
} from './scriptable-pack.js';

function producerError(input: AssetOutputInput, reason: unknown): ImportError {
  return new ImportError({
    code: 'import-internal-error',
    expected: `ScriptablePack ${input.asset.kind} output ${input.sourceKey} to satisfy its domain producer contract`,
    hint: 'fix the generated Asset payload and rebuild the ScriptablePack',
    detail: { reason: reason instanceof Error ? reason.message : String(reason) },
  });
}

function formatGuid(value: AssetGuidType | string): string {
  if (typeof value === 'string') {
    const parsed = AssetGuid.parse(value);
    if (!parsed.ok) throw parsed.error;
    return AssetGuid.format(parsed.value);
  }
  return AssetGuid.format(value);
}

function particleProgramArtifact(effect: ParticleEffectAsset): {
  readonly program: ParticleEffectAsset['program'];
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
} {
  const artifactProgram = { format: effect.program.format, emitters: effect.program.emitters };
  const bytes = new TextEncoder().encode(canonicalJson(artifactProgram));
  const fingerprint = `sha256:${bytesToHex(sha256(bytes))}`;
  return {
    program: { ...effect.program, fingerprint },
    bytes,
    fingerprint,
  };
}

function materialProduct(input: AssetOutputInput): AssetOutputProduct {
  if (input.asset.kind !== 'material') throw new TypeError('expected MaterialAsset');
  const material = input.asset as MaterialAsset;
  const requirePersistableValue = (value: unknown): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'source' in value) {
      throw new TypeError(
        'Pack material textures require source GUIDs; runtime render sources cannot be persisted',
      );
    }
  };
  for (const parameter of material.parameters ?? []) requirePersistableValue(parameter.default);
  const refs: AssetRef[] = [];
  const addRef = (
    guid: AssetGuidType | string,
    sourceField: NonNullable<AssetRef['sourceField']>,
  ): number => {
    refs.push({ guid: formatGuid(guid), sourceField });
    return refs.length - 1;
  };

  const addMaterialRef = (
    value: MaterialTextureReference | AssetHandle<'sampler'>,
    sourceField: NonNullable<AssetRef['sourceField']>,
  ): number => {
    if (typeof value === 'number') {
      throw new TypeError('material texture references must be GUIDs, not runtime handles');
    }
    return addRef(value, sourceField);
  };

  const textureFields =
    material.parameters === undefined
      ? new Set<string>(MATERIAL_TEXTURE_SLOTS)
      : new Set(
          material.parameters
            .filter((parameter) => isMaterialTextureParameterType(parameter.type))
            .map((parameter) => parameter.name),
        );

  const parent =
    material.parent === undefined ? undefined : addRef(material.parent, { fieldName: 'parent' });
  const values: Record<string, unknown> = {};
  for (const fieldName of Object.keys(material.values ?? {}).sort()) {
    const value = material.values?.[fieldName];
    requirePersistableValue(value);
    if (typeof value === 'string' && textureFields.has(fieldName)) {
      values[fieldName] = {
        texture: addMaterialRef(value, { componentName: '<material>', fieldName }),
      };
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'texture' in value
    ) {
      const texture = value as MaterialTextureValue & { texture: MaterialTextureReference };
      values[fieldName] = {
        ...texture,
        texture: addMaterialRef(texture.texture, { componentName: '<material>', fieldName }),
        ...(texture.sampler === undefined
          ? {}
          : {
              sampler: addMaterialRef(texture.sampler, {
                componentName: '<material>',
                fieldName: `${fieldName}.sampler`,
              }),
            }),
      };
    } else {
      values[fieldName] = value;
    }
  }

  const { parent: _parent, values: _values, ...materialShape } = material;
  return {
    payload: {
      ...materialShape,
      ...(parent === undefined ? {} : { parent }),
      ...(material.values === undefined ? {} : { values }),
    },
    refs,
    artifacts: {},
  };
}

function meshDataProduct(input: AssetOutputInput): AssetOutputProduct {
  if (input.asset.kind !== 'mesh') throw new TypeError('expected MeshAsset');
  const mesh = input.asset as MeshAsset;
  const refs: AssetRef[] = [];
  for (let slotIndex = 0; slotIndex < mesh.materialSlots.length; slotIndex++) {
    const defaultMaterial = mesh.materialSlots[slotIndex]?.defaultMaterial;
    if (defaultMaterial === undefined) continue;
    if (typeof defaultMaterial === 'number')
      throw new TypeError('Pack Mesh material references require source GUIDs');
    refs.push({
      guid: formatGuid(defaultMaterial),
      sourceField: { fieldName: 'materialSlots', arrayIndex: slotIndex },
    });
  }
  const seenRefs = new Set(refs.map((reference) => reference.guid.toLowerCase()));
  for (const [lodIndex, lod] of (mesh.lods ?? []).entries()) {
    if (typeof lod.mesh === 'number')
      throw new TypeError('Pack Mesh LOD references require source GUIDs');
    const guid = formatGuid(lod.mesh);
    if (seenRefs.has(guid.toLowerCase())) continue;
    seenRefs.add(guid.toLowerCase());
    refs.push({ guid, sourceField: { fieldName: 'lods', arrayIndex: lodIndex } });
  }
  return { payload: mesh, refs, artifacts: {} };
}

function meshProduct(input: AssetOutputInput): AssetOutputProduct {
  const prepared = meshDataProduct(input);
  const mesh = prepared.payload as MeshAsset;
  const refs = prepared.refs;
  return {
    ...prepared,
    // The binary body owns geometry. Keeping the author arrays in JSON as well
    // duplicates bytes and creates two competing payloads at runtime admission.
    payload: { kind: 'mesh' },
    artifacts: {
      body: {
        mediaType: 'application/x-forgeax-mesh',
        assetCodec: { name: 'mesh-binary', version: '5' },
        bytes: (() => {
          const packed = packMeshBin(
            mesh,
            input.sourceKey,
            refs.map((reference) => reference.guid),
          );
          if (!packed.ok) {
            throw packed.error;
          }
          return packed.value;
        })(),
      },
    },
  };
}

function sceneProduct(
  input: AssetOutputInput,
  components: ReadonlyMap<string, Readonly<Record<string, string>>>,
): AssetOutputProduct {
  if (input.asset.kind !== 'scene') throw new TypeError('expected SceneAsset');
  const externalized = externalizeSceneAsset(input.asset as SceneAsset, (componentName) => {
    const schema = components.get(componentName);
    if (schema === undefined) {
      throw new TypeError(
        `ScriptablePack scene component ${componentName} is missing from sceneComponents`,
      );
    }
    return schema;
  });
  if (!externalized.ok) throw new TypeError(`scene field ${externalized.error.field} is invalid`);
  return {
    payload: { kind: 'scene', ...externalized.value.payload },
    refs: externalized.value.refs,
    artifacts: {},
  };
}

function containsAssetGuid(value: unknown): boolean {
  if (typeof value === 'string') return AssetGuid.parse(value).ok;
  if (Array.isArray(value)) return value.some(containsAssetGuid);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsAssetGuid);
  }
  return false;
}

/**
 * Direct v3 scenes migrated from Pack v2 already carry runtime ref indices in
 * their component payload. There is no component-schema authority in a JSON
 * direct entry, so preserve that transport shape and let the entry's explicit
 * refs provide the closure. A GUID-bearing scene is still sent through the
 * schema-backed producer and therefore fails closed when no schema is present.
 */
function preExternalizedSceneProduct(input: AssetOutputInput): AssetOutputProduct {
  if (input.asset.kind !== 'scene') throw new TypeError('expected SceneAsset');
  if (containsAssetGuid(input.asset)) {
    throw new TypeError('direct scene payload must use explicit refs with runtime indices');
  }
  return {
    payload: { ...(input.asset as SceneAsset), kind: 'scene' },
    refs: [],
    artifacts: {},
  };
}

function createSafeProducer(
  kind: AssetOutputProducer['kind'],
  version: string,
  product: (input: AssetOutputInput) => AssetOutputProduct,
): AssetOutputProducer {
  return {
    kind,
    version,
    produce(input) {
      try {
        return ok(product(input));
      } catch (error) {
        return err(producerError(input, error));
      }
    },
  };
}

function jsonArtifact(value: unknown): ImportedArtifactBody {
  return {
    mediaType: 'application/json',
    assetCodec: { name: 'forgeax-json', version: '1' },
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function ref(guid: AssetGuidType, fieldName: string, arrayIndex?: number): AssetRef {
  return {
    guid: formatGuid(guid),
    sourceField: { fieldName, ...(arrayIndex === undefined ? {} : { arrayIndex }) },
  };
}

function bytes(value: Uint8Array | Uint8ClampedArray): Uint8Array {
  return Uint8Array.from(value);
}

function textureProduct(input: AssetOutputInput): AssetOutputProduct {
  if (input.asset.kind !== 'texture') throw new TypeError('expected TextureAsset');
  const texture = input.asset as TextureAsset;
  const layout = deriveTextureLayout({
    shape: texture.shape,
    format: texture.format,
    mips: texture.mips,
    actualByteLength: texture.data.byteLength,
    order: 'mip-major,image-major,row-major',
  });
  if (!layout.ok) {
    const expectedBytes =
      layout.error.code === 'texture-packing-invalid'
        ? layout.error.detail.expectedBytes
        : texture.data.byteLength;
    const actualBytes =
      layout.error.code === 'texture-packing-invalid'
        ? layout.error.detail.actualBytes
        : texture.data.byteLength;
    throw new TypeError(
      `texture data is not canonical: expected ${expectedBytes} bytes, got ${actualBytes}`,
    );
  }
  return {
    payload: texture,
    refs: [],
    artifacts: {
      body: {
        mediaType:
          texture.format === 'r8unorm'
            ? 'application/x-forgeax-r8'
            : `application/x-forgeax-${texture.format}`,
        assetCodec: { name: texture.format, version: '1' },
        bytes: bytes(texture.data),
      },
    },
  };
}

function ordinaryPodProduct(input: AssetOutputInput): AssetOutputProduct {
  const asset = input.asset;
  switch (asset.kind) {
    case 'plugin':
      throw new TypeError('plugin definitions require the plugin output producer');
    case 'texture':
      return textureProduct(input);
    case 'equirect': {
      const equirect = asset as EquirectAsset;
      return {
        payload: equirect,
        refs: [],
        artifacts: {
          body: {
            mediaType: 'image/raw',
            assetCodec: { name: 'raw-image', version: '1' },
            bytes: bytes(equirect.data),
          },
        },
      };
    }
    case 'sampler': {
      const sampler = asset as SamplerAsset;
      return { payload: sampler, refs: [], artifacts: { body: jsonArtifact(sampler) } };
    }
    case 'font': {
      const font = asset as FontAsset;
      if (typeof font.atlas === 'number' || typeof font.sampler === 'number')
        throw new TypeError('Font Pack output requires source GUIDs, not runtime asset handles');
      const atlas = ref(font.atlas, 'atlas');
      const sampler = ref(font.sampler, 'sampler');
      return {
        payload: {
          kind: font.kind,
          glyphs: font.glyphs,
          common: font.common,
          atlasGuid: atlas.guid,
          samplerGuid: sampler.guid,
        },
        refs: [atlas, sampler],
        artifacts: { body: jsonArtifact(font) },
      };
    }
    case 'render-pipeline': {
      const pipeline = asset as RenderPipelineAsset;
      return {
        payload: pipeline,
        refs: [],
        artifacts: { body: jsonArtifact(pipeline) },
      };
    }
    case 'navigation-mesh': {
      return { payload: asset, refs: [], artifacts: { body: jsonArtifact(asset) } };
    }
    case 'terrain': {
      const terrain = asset as TerrainAsset;
      const dependencies = [
        ...terrain.grids,
        ...terrain.layers.flatMap((layer) =>
          layer.blend === 'height' ? [layer.material, layer.height] : [layer.material],
        ),
        ...terrain.sections.flatMap((section) => [
          section.heightTexture,
          section.weightTexture,
          section.material,
        ]),
      ];
      const refs = [...new Set(dependencies)].map((guid) => {
        if (typeof guid !== 'string')
          throw new TypeError('Pack terrain outputs require source GUIDs, not runtime handles');
        const parsed = AssetGuid.parse(guid);
        if (!parsed.ok) throw parsed.error;
        return ref(parsed.value, 'terrain');
      });
      const body = {
        ...terrain,
        heights: Array.from(terrain.heights),
        weights: Array.from(terrain.weights),
      };
      return { payload: terrain, refs, artifacts: { body: jsonArtifact(body) } };
    }
    case 'tileset': {
      const tileset = asset as TilesetAsset;
      const refs = tileset.atlases.map((atlas, index) => {
        if (typeof atlas === 'number')
          throw new Error(
            'Pack Tileset atlases require source GUIDs; runtime handles cannot be persisted',
          );
        const parsed = typeof atlas === 'string' ? AssetGuid.parse(atlas) : ok(atlas);
        if (!parsed.ok) throw parsed.error;
        return ref(parsed.value, 'atlases', index);
      });
      return {
        payload: { ...tileset, atlases: refs.map((_entry, index) => index) },
        refs,
        artifacts: { body: jsonArtifact(tileset) },
      };
    }
    case 'video': {
      const video = asset as VideoAsset;
      try {
        const url = new URL(video.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
          throw new Error('unsupported URL scheme');
      } catch (error) {
        throw new TypeError(
          `video URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { payload: video, refs: [], artifacts: {} };
    }
    case 'skeleton': {
      const skeleton = asset as SkeletonAsset;
      return {
        payload: skeleton,
        refs: [],
        artifacts: { body: jsonArtifact(skeleton) },
      };
    }
    case 'skin': {
      const skin = asset as SkinAsset;
      const skeletonGuid = AssetGuid.parse(skin.skeletonGuid);
      if (!skeletonGuid.ok) throw skeletonGuid.error;
      return {
        payload: skin,
        refs: [ref(skeletonGuid.value, 'skeletonGuid')],
        artifacts: { body: jsonArtifact(skin) },
      };
    }
    case 'animation-clip': {
      const clip = asset as AnimationClip;
      const refs: AssetRef[] = [];
      for (const [index, key] of (clip.events ?? []).entries()) {
        if (key.action.kind === 'method' || key.action.clip === null) continue;
        const guid = AssetGuid.parse(key.action.clip);
        if (!guid.ok) throw guid.error;
        refs.push(ref(guid.value, 'events', index));
      }
      const samples = encodeAnimationClipSamples(clip as unknown as Record<string, unknown>);
      // Pack projection replaces the inline arrays with windows into this artifact.
      return {
        payload: clip,
        refs,
        artifacts:
          samples === undefined
            ? {}
            : {
                [ANIMATION_CLIP_SAMPLES_ARTIFACT]: {
                  mediaType: 'application/octet-stream',
                  bytes: samples.bytes,
                },
              },
      };
    }
    case 'animation-graph': {
      const graph = asset as AnimationGraph;
      const refs: AssetRef[] = [];
      const nodes = graph.nodes.map((node, index) => {
        if (node.type !== 'clip') return node;
        if (typeof node.clip !== 'string')
          throw new TypeError(
            'Pack animation graphs require source GUIDs; resolve runtime clip references before persistence',
          );
        const parsed = AssetGuid.parse(node.clip);
        if (!parsed.ok) throw parsed.error;
        const referenceIndex = refs.push(ref(parsed.value, 'nodes', index)) - 1;
        return { ...node, clip: referenceIndex };
      });
      return {
        payload: { kind: graph.kind, root: graph.root, nodes },
        refs,
        artifacts: { body: jsonArtifact(graph) },
      };
    }
    case 'audio': {
      const audio = asset as AudioClipAsset;
      if (audio.stream)
        throw new Error(
          'stream audio is source/Meta-owned; runtime locators cannot be serialized as authored Pack bytes',
        );
      return {
        payload: {
          kind: audio.kind,
          sourceKey: audio.sourceKey,
          mediaType: audio.mediaType,
        },
        refs: [],
        artifacts: {
          source: {
            mediaType: audio.mediaType,
            assetCodec: { name: 'browser-audio', version: '1' },
            bytes: audio.bytes.slice(),
          },
        },
      };
    }
    case 'particle-effect': {
      const effect = asset as ParticleEffectAsset;
      const cooked = particleProgramArtifact(effect);
      const refs = new Set<string>();
      for (const emitter of cooked.program.emitters) {
        for (const field of emitter.forceFields ?? [])
          if (field.kind === 'vector') {
            if (typeof field.texture === 'number')
              throw new TypeError('Pack vector fields require source texture GUIDs');
            refs.add(formatGuid(field.texture));
          }
        for (const renderer of emitter.renderers) {
          if (!('material' in renderer) || typeof renderer.material !== 'string') {
            throw new Error(`Particle emitter '${emitter.id}' requires a renderer Material GUID`);
          }
          refs.add(formatGuid(renderer.material));
          if ('kind' in renderer && renderer.kind === 'mesh') {
            const mesh = 'mesh' in renderer ? renderer.mesh : undefined;
            if (typeof mesh === 'string') {
              refs.add(formatGuid(mesh));
            } else if (
              mesh === null ||
              typeof mesh !== 'object' ||
              Array.isArray(mesh) ||
              !('source' in mesh) ||
              mesh.source !== 'player' ||
              Object.keys(mesh).length !== 1
            ) {
              throw new Error(
                `Particle emitter '${emitter.id}' requires a renderer Mesh GUID or Player source`,
              );
            }
          }
        }
      }
      return {
        payload: { ...effect, programFingerprint: cooked.fingerprint, program: cooked.program },
        refs: [...refs].sort().map((guid) => ({ guid })),
        artifacts: {
          'particle-effect/program.json': {
            mediaType: 'application/json',
            assetCodec: { name: 'forgeax-vfx-program', version: effect.program.format },
            bytes: cooked.bytes,
          },
        },
      };
    }
    case 'ies-profile': {
      const profile = asset as IesProfileAsset;
      return {
        payload: profile,
        refs: [],
        artifacts: {
          body: {
            mediaType: 'application/octet-stream',
            assetCodec: { name: 'forgeax-ies-profile', version: '1' },
            bytes: bytes(profile.data),
          },
        },
      };
    }
    case 'material':
    case 'mesh':
    case 'scene':
      throw new TypeError(`ordinary producer received already-owned ${asset.kind} asset`);
  }
}

export const materialAssetOutputProducer = createSafeProducer(
  'material',
  'material-pack/2',
  materialProduct,
);

export const meshAssetDataProducer = meshProducer('mesh-data/2', meshDataProduct);

export const meshAssetOutputProducer = meshProducer('mesh-binary/7', meshProduct);
export const textureAssetOutputProducer = createSafeProducer(
  'texture',
  'texture-pack/1',
  textureProduct,
);

export function createSceneAssetOutputProducer(
  sceneComponents: readonly ScriptablePackSceneComponent[] = [],
): AssetOutputProducer {
  const schemas = new Map(
    sceneComponents.map((component) => [component.name, component.fields] as const),
  );
  return createSafeProducer('scene', 'scene-pack/4', (input) => sceneProduct(input, schemas));
}

export function createPreExternalizedSceneAssetOutputProducer(): AssetOutputProducer {
  return createSafeProducer('scene', 'scene-pack/4', preExternalizedSceneProduct);
}

export function createAssetOutputProducerRegistry(
  sceneComponents: readonly ScriptablePackSceneComponent[] = [],
): AssetOutputProducerRegistry {
  const registry = new AssetOutputProducerRegistry();
  registry.register(materialAssetOutputProducer);
  registry.register(meshAssetOutputProducer);
  registry.register(textureAssetOutputProducer);
  registry.register(createSceneAssetOutputProducer(sceneComponents));
  registry.register(particleEffectProducer());
  for (const kind of [
    'equirect',
    'sampler',
    'font',
    'render-pipeline',
    'tileset',
    'video',
    'skeleton',
    'skin',
    'animation-clip',
    'animation-graph',
    'audio',
    'ies-profile',
    'terrain',
    'navigation-mesh',
  ] as const) {
    registry.register(
      createSafeProducer(
        kind,
        kind === 'animation-clip' ? 'animation-clip/3' : 'ordinary-pod/1',
        ordinaryPodProduct,
      ),
    );
  }
  return registry;
}

function particleEffectProducer(): AssetOutputProducer {
  const produced = createSafeProducer('particle-effect', 'particle-effect/4', ordinaryPodProduct);
  return {
    ...produced,
    produce(input) {
      if (input.asset.kind !== 'particle-effect' || !('source' in input.asset))
        return produced.produce(input);
      const source = input.asset.source;
      return (async () => {
        try {
          if (Object.keys(input.asset).some((key) => key !== 'kind' && key !== 'source'))
            throw new TypeError('Particle authoring output requires only kind and source');
          if (input.cookers === undefined)
            throw new TypeError('Particle authoring output requires the native build host');
          const cooked = await input.cookers.runDraft('particle-effect', {
            guid: input.guid,
            source,
          });
          if (!cooked.ok) throw new TypeError(cooked.error.hint);
          if (cooked.value.guid.toLowerCase() !== input.guid.toLowerCase())
            throw new TypeError('Particle Native Cook must preserve the derived AssetGuid');
          const effect = cooked.value.payload as ParticleEffectAsset;
          if (effect?.kind !== 'particle-effect')
            throw new TypeError('Particle Native Cook must return a particle-effect payload');
          const product = await produced.produce({ ...input, asset: effect });
          return product.ok
            ? ok({ ...product.value, inputFingerprint: cooked.value.inputFingerprint })
            : product;
        } catch (error) {
          return err(producerError(input, error));
        }
      })();
    },
  };
}

/** The complete Mesh product, unlike the geometry-only binary encoder, carries derived data. */
function meshProducer(
  version: string,
  produceGeometry: (input: AssetOutputInput) => AssetOutputProduct,
): AssetOutputProducer {
  const plain = createSafeProducer('mesh', version, produceGeometry);
  return {
    kind: 'mesh',
    version,
    produce(input) {
      if (input.asset.kind !== 'mesh' || input.asset.distanceField === undefined)
        return plain.produce(input);
      const sourceMesh = input.asset;
      return (async () => {
        try {
          const attached = await encodeMeshDistanceFieldProduct(sourceMesh);
          const { distanceField: _, ...mesh } = sourceMesh;
          const product = produceGeometry({ ...input, asset: mesh });
          return ok({
            ...product,
            payload: {
              ...product.payload,
              ...(attached === undefined ? {} : { distanceField: attached.payload }),
            },
            artifacts: { ...product.artifacts, ...attached?.artifacts },
          });
        } catch (error) {
          return err(producerError(input, error));
        }
      })();
    },
  };
}
