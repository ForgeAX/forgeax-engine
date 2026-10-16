import { rendererCrashProbe } from './render-worker-recovery-fixture';
import { HANDLE_CUBE, HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import {
  Camera,
  DirectionalLight,
  PointLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
  SkyboxBackground,
  perspective,
  type RenderFeature,
  type Renderer,
} from '@forgeax/engine-render';
import { GlyphText, TileLayer, Tilemap } from '@forgeax/engine-render/authoring';
import { VIDEO_SOURCE_PROVIDER_KEY } from '@forgeax/engine-graphics-extras';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { ok, type FontAsset, type TextureAsset } from '@forgeax/engine-types';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';

function parseGuid(value: string) {
  const result = AssetGuid.parse(value);
  if (!result.ok) throw result.error;
  return result.value;
}
const atlasGuid = '12345678-1234-1234-1234-123456789abc';
const tilesetGuid = '12345678-1234-1234-1234-123456789abd';
const samplerGuid = '12345678-1234-1234-1234-123456789abe';
const camera = {
  ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 20 }),
  tonemap: 0,
  antialias: 0,
  clearColor: [0.02, 0.02, 0.02, 1],
};

const entry: ExecutionBootstrapEntry = (data) => {
  const mode = String(data);
  if (mode === 'environment') {
    // Enable the existing binding receipt in each fixture-owned renderer realm.
    Object.assign(globalThis, { process: { env: { FORGEAX_MATERIAL_DIAGNOSTICS: '1' } } });
  }
  const crashRenderer = rendererCrashProbe();
  let revision = 0;
  let acknowledgments = 0;
  const renderErrors: string[] = [];
  let submittedErrors: readonly string[] = [];
  let renderer: Renderer | undefined;
  let environmentReady = false;
  const feature: RenderFeature<unknown> = {
    identity: 'publication.content-proof',
    extract: () => ok({ revision }),
    plan: () =>
      ok({
        work: [{ scope: 'frame', resources: [], passes: [] }],
        sourceFeedback: {
          errors: renderErrors,
          environmentReady: renderer?.inspect().iblBinding?.active === 'active',
        },
      }),
    onSourceFrameSubmitted(_frame, feedback) {
      const state = feedback as { errors: string[]; environmentReady: boolean };
      submittedErrors = state.errors;
      environmentReady = state.environmentReady;
      acknowledgments++;
    },
  };
  return {
    features: [feature],
    configureRenderer(value) {
      renderer = value;
      renderer.subscribe((event) => {
        if (event.kind === 'error' && renderErrors.length < 10)
          renderErrors.push(JSON.stringify(event.error));
      });
    },
    plugins: [
      {
        name: 'publication-content-fixture',
        inject: ['world', 'assets', 'executionBootstrapHost'],
        apply(ctx) {
          const world = ctx.world;
          const assets = ctx.assets;
          if (assets === undefined) throw new Error('Fixture assets unavailable');
          const cameraEntity = world
            .spawn(
              { component: Transform, data: { pos: [0, 0, 6] } },
              { component: Camera, data: camera },
            )
            .unwrap();
          const pixels = new Uint8Array(8 * 8 * 4).fill(255);
          const atlas: TextureAsset = {
            kind: 'texture',
            shape: { viewDimension: '2d', extent: { width: 8, height: 8 } },
            format: 'rgba8unorm-srgb',
            data: pixels,
            colorSpace: 'srgb',
            mips: { kind: 'none' },
          };
          let update: () => void;
          if (mode === 'lighting-channels') {
            const material = world.allocSharedRef('MaterialAsset', Materials.standard({
              baseColor: [0.5, 0.5, 0.5, 1], roughness: 0.7,
              emissive: [0.02, 0.02, 0.02], emissiveIntensity: 1,
            }));
            const receiver = world.spawn(
              { component: Transform, data: { scale: [3, 3, 0.2] } },
              { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
              { component: MeshRenderer, data: { materials: [material], lightingChannels: 2 } },
            ).unwrap();
            world.spawn({ component: DirectionalLight, data: { direction: [0, 0, -1],
              intensity: 3, castShadow: false, lightingChannels: 0x80000001 } }).unwrap();
            world.spawn({ component: Transform, data: { pos: [0, 2, 4] } },
              { component: PointLight, data: { intensity: 0.2, range: 10 } }).unwrap();
            update = () => world.set(receiver, MeshRenderer, { lightingChannels: 0x80000000 }).unwrap();
          } else if (mode === 'video') {
            assets.catalog(atlasGuid, { kind: 'video', url: 'native-frame-fixture.webm' }).unwrap();
            const source = new OffscreenCanvas(16, 16);
            const context = source.getContext('2d');
            if (context === null) throw new Error('Video fixture has no 2D context');
            let frame: VideoFrame | undefined;
            const paint = (color: string) => {
              context.fillStyle = color;
              context.fillRect(0, 0, 16, 16);
              frame?.close();
              frame = new VideoFrame(source, { timestamp: revision });
            };
            paint('red');
            world.insertResource(VIDEO_SOURCE_PROVIDER_KEY, { getSource: () => frame });
            ctx.effect(() => () => frame?.close());
            const material = world.allocSharedRef(
              'MaterialAsset',
              Materials.standard({
                baseColor: [1, 1, 1, 1],
                baseColorTexture: { texture: atlasGuid },
              }),
            );
            world.spawn({ component: Skylight, data: {} }).unwrap();
            world
              .spawn(
                { component: Transform, data: {} },
                { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
                { component: MeshRenderer, data: { materials: [material] } },
              )
              .unwrap();
            update = () => paint('lime');
          } else if (mode === 'text') {
            assets.catalog(atlasGuid, atlas).unwrap();
            assets
              .catalog(samplerGuid, {
                kind: 'sampler',
                minFilter: 'linear',
                magFilter: 'linear',
                mipmapFilter: 'nearest',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
              })
              .unwrap();
            const font = world.allocSharedRef('FontAsset', {
              kind: 'font',
              atlas: parseGuid(atlasGuid),
              sampler: parseGuid(samplerGuid),
              glyphs: {
                65: {
                  advance: 10,
                  bearingX: 0,
                  bearingY: 8,
                  size: { w: 8, h: 8 },
                  region: { x: 0, y: 0, w: 8, h: 8 },
                },
              },
              common: {
                lineHeight: 12,
                base: 8,
                distanceRange: 4,
                pxRange: 4,
                atlasWidth: 8,
                atlasHeight: 8,
              },
            } satisfies FontAsset);
            const label = world
              .spawn(
                { component: Transform, data: {} },
                {
                  component: GlyphText,
                  data: { fontHandle: font, text: 'A', fontSize: 1, color: [1, 0, 0, 1] },
                },
              )
              .unwrap();
            update = () => {
              world.set(label, GlyphText, { text: 'AAA', color: [0, 1, 0, 1] }).unwrap();
            };
          } else if (mode === 'tile-layer' || mode === 'tile-cell') {
            assets.catalog(atlasGuid, atlas).unwrap();
            assets
              .catalog(tilesetGuid, {
                kind: 'tileset',
                atlases: [atlasGuid],
                tileWidth: 8,
                tileHeight: 8,
                columns: 1,
                rows: 1,
                regions: [{ x: 0, y: 0, width: 8, height: 8 }],
                tiles: [{ regionIndex: 0 }],
              })
              .unwrap();
            const map = world
              .spawn(
                { component: Transform, data: { pos: [-1, -1, 0] } },
                {
                  component: Tilemap,
                  data: { cols: 2, rows: 2, tileSize: [1, 1], chunkSize: 2, tileset: tilesetGuid },
                },
              )
              .unwrap();
            const layer = world
              .spawn(
                { component: Transform, data: {} },
                { component: ChildOf, data: { parent: map } },
                {
                  component: TileLayer,
                  data: {
                    tiles: new Uint32Array([1, 0, 0, 0]),
                    dirty: 1,
                    sortScope: mode === 'tile-cell' ? 1 : 0,
                  },
                },
              )
              .unwrap();
            update = () => {
              world
                .set(layer, TileLayer, { tiles: new Uint32Array([0, 1, 1, 1]), dirty: 1 })
                .unwrap();
            };
          } else if (mode === 'environment') {
            world.set(cameraEntity, Camera, { tonemap: 1 }).unwrap();
            const hdr = new Uint16Array(8 * 4 * 4);
            for (let i = 0; i < hdr.length; i += 4) hdr.set([0x3c00, 0x3800, 0x3400, 0x3c00], i);
            const environment = world.allocSharedRef('EquirectAsset', {
              kind: 'equirect',
              width: 8,
              height: 4,
              format: 'rgba16float',
              data: new Uint8Array(hdr.buffer),
              colorSpace: 'linear',
            });
            const light = world
              .spawn({ component: Skylight, data: { equirect: environment } })
              .unwrap();
            world.spawn({ component: SkyboxBackground, data: { equirect: environment } }).unwrap();
            const material = world.allocSharedRef(
              'MaterialAsset',
              Materials.standard({ baseColor: [1, 1, 1, 1] }),
            );
            world
              .spawn(
                { component: Transform, data: {} },
                { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
                { component: MeshRenderer, data: { materials: [material] } },
              )
              .unwrap();
            update = () => {
              world.set(light, Skylight, { intensity: 0.1 }).unwrap();
            };
          } else if (mode === 'target') {
            const targets = ctx.executionBootstrapHost.renderTargets;
            if (targets === undefined) throw new Error('Target authoring unavailable');
            const descriptor = {
              shape: '2d',
              width: 32,
              height: 32,
              format: 'rgba8unorm-srgb',
              mipLevels: 1,
              sampleCount: 1,
              sampled: true,
              readback: true,
            } as const;
            const target = targets.createRenderTarget(descriptor);
            if (!target.ok) throw target.error;
            const source = targets.createRenderTargetTextureSource(target.value, {
              aspect: 'color',
              dimension: '2d',
              mipLevel: 0,
            });
            if (!source.ok) throw source.error;
            const targetRef = world.allocSharedRef('RenderTarget', target.value);
            const sourceRef = world.allocSharedRef('RenderTargetTextureSource', source.value);
            const auxiliary = world
              .spawn(
                { component: Transform, data: { pos: [10, 0, 6] } },
                {
                  component: Camera,
                  data: { ...camera, target: targetRef, clearColor: [1, 0, 0, 1] },
                },
              )
              .unwrap();
            const capturedMaterial = world.allocSharedRef(
              'MaterialAsset',
              Materials.unlit([0, 0, 1, 1]),
            );
            world
              .spawn(
                { component: Transform, data: { pos: [10, 0, 0], scale: [3, 3, 3] } },
                { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
                { component: MeshRenderer, data: { materials: [capturedMaterial] } },
              )
              .unwrap();
            const material = world.allocSharedRef(
              'MaterialAsset',
              Materials.standard({
                baseColor: [1, 1, 1, 1],
                baseColorTexture: sourceRef,
              }),
            );
            world.spawn({ component: Skylight, data: {} }).unwrap();
            world
              .spawn(
                { component: Transform, data: { scale: [2, 2, 2] } },
                { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
                { component: MeshRenderer, data: { materials: [material] } },
              )
              .unwrap();
            update = () => {
              world.set(auxiliary, Camera, { clearColor: [0, 1, 0, 1] }).unwrap();
              const resized = targets.resizeRenderTarget(target.value, {
                ...descriptor,
                width: 64,
              });
              if (!resized.ok) throw resized.error;
            };
          } else throw new Error(`Unknown content mode ${mode}`);
          const port = ctx.executionBootstrapHost.port;
          if (port !== undefined) {
            port.onmessage = (event) => {
              if (event.data === 'recover') crashRenderer();
              if (event.data === 'update') {
                revision++;
                update();
              }
              port.postMessage({
                revision,
                acknowledgments,
                errors: submittedErrors,
                environmentReady,
              });
            };
            port.start();
          }
        },
      },
    ],
  };
};
export default entry;
