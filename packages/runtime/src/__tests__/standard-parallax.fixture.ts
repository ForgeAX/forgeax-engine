import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
} from '@forgeax/engine-render';
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MaterialRootAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { testAssets } from './helpers/runtime-assets';
import { renderValue } from './standard-gbuffer-replay.fixture';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;

export const PARALLAX_SIZE = 128;
const TEXELS = 32;
const THETA = Math.PI / 3;
const DEPTH = 0.4;
const ORTHO_HALF = 1.1;

export interface ParallaxPathFacts {
  readonly renderPath: 'forward' | 'deferred';
  readonly recessDelta: number;
  readonly changedPixels: number;
  readonly zeroBytesIdentical: boolean;
  readonly flatEdges: readonly [number, number];
  readonly parallaxEdges: readonly [number, number];
  readonly expectedShiftPx: number;
  readonly measuredShiftPx: number;
  readonly depthErrorPercent: number;
  readonly variantDeltas: Readonly<Record<string, number>>;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required parallax fixture value is missing');
  return value;
}

// A centered square recess: height 1 (top) outside, 0 (floor) inside texels [8, 24).
const recess = (x: number, y: number) => x >= 8 && x < 24 && y >= 8 && y < 24;
function pattern(inside: number, outside: number): Uint8Array {
  const bytes = new Uint8Array(TEXELS * TEXELS * 4);
  for (let y = 0; y < TEXELS; y++)
    for (let x = 0; x < TEXELS; x++) {
      const v = recess(x, y) ? inside : outside;
      bytes.set([v, v, v, 255], (y * TEXELS + x) * 4);
    }
  return bytes;
}

function hdr(bytes: Uint8Array, pitch: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: PARALLAX_SIZE * PARALLAX_SIZE * 3 }, (_, i) =>
    halfFloat.f16ToF32(
      view.getUint16(
        Math.floor(i / (PARALLAX_SIZE * 3)) * pitch +
          (Math.floor(i / 3) % PARALLAX_SIZE) * 8 +
          (i % 3) * 2,
        true,
      ),
    ),
  );
}

const difference = (a: readonly number[], b: readonly number[]) =>
  a.reduce((max, v, i) => Math.max(max, Math.abs(v - (b[i] ?? Number.NaN))), 0);

/** Rows of the dark recess run on the center column, bounded by lit top surface. */
function recessEdges(pixels: readonly number[]): [number, number] {
  const column = PARALLAX_SIZE / 2;
  const luminance = Array.from({ length: PARALLAX_SIZE }, (_, row) => {
    const offset = (row * PARALLAX_SIZE + column) * 3;
    return (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0);
  });
  const bright = Math.max(...luminance);
  const lit = luminance.map((value) => value > bright * 0.5);
  const first = lit.indexOf(true);
  const last = lit.lastIndexOf(true);
  let top = -1;
  let bottom = -1;
  for (let row = first; row <= last; row++) {
    if (lit[row]) continue;
    if (top < 0) top = row;
    bottom = row + 1;
  }
  if (top < 0) throw new Error('parallax fixture found no recess run on the center column');
  return [top, bottom];
}

function withUv1(mesh: MeshAsset): MeshAsset {
  const uv = mesh.attributes.uv as Float32Array;
  const attributes = { ...mesh.attributes, uv1: Float32Array.from(uv) };
  return {
    ...mesh,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, uv.length / 2).unwrap().vertices,
  };
}

function withSkin(mesh: MeshAsset): MeshAsset {
  const count = (mesh.attributes.position as Float32Array).length / 3;
  const attributes = {
    ...mesh.attributes,
    skinIndex: new Uint16Array(count * 4),
    skinWeight: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
  };
  return {
    ...mesh,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
  };
}

function skinned(material: MaterialRootAsset): MaterialRootAsset {
  return {
    ...material,
    passes: required(material.passes).map((pass) => ({
      ...pass,
      program: {
        ...pass.program,
        module:
          pass.program.module === 'forgeax_material::standard'
            ? 'forgeax::pbr-skin'
            : pass.program.module,
      },
    })),
  };
}

interface ParallaxCase {
  readonly name: string;
  readonly mode?: 'vertex' | 'parallax';
  readonly scale?: number;
  readonly bias?: number;
  readonly objectScale?: number;
  readonly heightSet?: 0 | 1;
  readonly rotatedSlot?: boolean;
  readonly gpu?: boolean;
  readonly skin?: boolean;
  /** Look evidence: raking light and a normal map derived from the same height. */
  readonly lit?: boolean;
}

const CASES: readonly ParallaxCase[] = [
  { name: 'flat' },
  { name: 'zero', mode: 'parallax', scale: 0, bias: 0 },
  { name: 'parallax', mode: 'parallax', scale: DEPTH, bias: -DEPTH },
  { name: 'parallax-gpu', mode: 'parallax', scale: DEPTH, bias: -DEPTH, gpu: true },
  // Object units scale by |M^T n|: half the height under a doubled normal axis.
  { name: 'object-scale', mode: 'parallax', scale: DEPTH / 2, bias: -DEPTH / 2, objectScale: 2 },
  // A half-turn slot transform maps the symmetric recess onto itself; the source
  // offset must invert the rotation to land on the same pixels.
  { name: 'rotated-slot', mode: 'parallax', scale: DEPTH, bias: -DEPTH, rotatedSlot: true },
  // Height on UV1 shifts only UV1 slots; base color on UV0 stays unshifted.
  { name: 'other-set', mode: 'parallax', scale: DEPTH, bias: -DEPTH, heightSet: 1 },
  { name: 'skin', mode: 'parallax', scale: DEPTH, bias: -DEPTH, skin: true },
  { name: 'lit-flat', lit: true },
  { name: 'lit-parallax', mode: 'parallax', scale: DEPTH, bias: -DEPTH, lit: true },
];

// Tangent-space normal map of the recess, from the same height by central
// differences (RGB = n * 0.5 + 0.5, slope scaled to the 0.4 depth over 1/16 uv).
function derivedNormals(): Uint8Array {
  const heightAt = (x: number, y: number) =>
    recess(Math.min(TEXELS - 1, Math.max(0, x)), Math.min(TEXELS - 1, Math.max(0, y))) ? 0 : 1;
  const bytes = new Uint8Array(TEXELS * TEXELS * 4);
  for (let y = 0; y < TEXELS; y++)
    for (let x = 0; x < TEXELS; x++) {
      const dx = (heightAt(x + 1, y) - heightAt(x - 1, y)) * 2;
      const dy = (heightAt(x, y + 1) - heightAt(x, y - 1)) * 2;
      const length = Math.hypot(dx, dy, 1);
      bytes.set(
        [-dx / length, -dy / length, 1 / length]
          .map((n) => Math.round((n * 0.5 + 0.5) * 255))
          .concat(255),
        (y * TEXELS + x) * 4,
      );
    }
  return bytes;
}

/** Pipeline selection evidence for one captured frame. */
export interface ParallaxPipelineEvidence {
  readonly sceneIndexParallax: boolean;
  readonly skinParallax: boolean;
  readonly fragmentEntries: readonly string[];
}

/**
 * Grazing square recess rendered off (no height), zero-height parallax and
 * true parallax through the production Renderer, then compared against the
 * analytic edge shift depth * sin(theta) under an orthographic camera.
 */
export async function verifyStandardParallax(
  renderer: Renderer,
  save: Save,
  options: {
    readonly paths?: readonly ('forward' | 'deferred')[];
    readonly cases?: readonly string[];
    readonly frameCount?: number;
    /** Captures the GPU-driven and skin frames to prove their pipelines were selected. */
    readonly recorder?: import('@forgeax/engine-rhi-debug').RecorderAttachment;
  } = {},
): Promise<ParallaxPathFacts[]> {
  const frameCount = options.frameCount ?? testQuality.staticFrames;
  const world = new World();
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const texture = (data: Uint8Array) =>
    testAssets(world)
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: TEXELS, height: TEXELS } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data,
      } satisfies TextureAsset)
      .unwrap();
  const height = texture(pattern(0, 255));
  const color = texture(pattern(13, 255));
  const flatNormal = texture(pattern(128, 128).map((v, i) => (i % 4 === 2 ? 255 : v)));
  const reliefNormal = texture(derivedNormals());
  const sampler = testAssets(world)
    .create({
      kind: 'sampler',
      minFilter: 'nearest',
      magFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    .unwrap();
  const plane = withUv1(createPlaneGeometry(2, 2).unwrap());
  const rotation = [Math.sin(THETA / 2), 0, 0, Math.cos(THETA / 2)] as const;
  const object = world
    .spawn(
      { component: Transform, data: { quat: [...rotation] } },
      { component: MeshFilter, data: { assetHandle: testAssets(world).create(plane).unwrap() } },
      { component: MeshRenderer, data: { materials: [] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -ORTHO_HALF,
          right: ORTHO_HALF,
          top: ORTHO_HALF,
          bottom: -ORTHO_HALF,
          near: 0.1,
          far: 10,
          antialias: 0,
          bloom: 0,
          tonemap: 1,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const frontLight = [0, 0, -1] as const;
  // Raking: mostly along the plane's tangent, slightly into its normal.
  const rakingLight = [-0.95, 0.26, -0.15] as const;
  const light = world
    .spawn({
      component: DirectionalLight,
      data: { direction: [...frontLight], color: [1, 1, 1], intensity: 2, castShadow: false },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const profile = renderer.inspect().profile;
  const facts: ParallaxPathFacts[] = [];
  const parallaxByPath = new Map<string, number[]>();
  const pipelineEvidence: Record<string, ParallaxPipelineEvidence> = {};
  const cases = CASES.filter(
    (entry) => options.cases === undefined || options.cases.includes(entry.name),
  );
  try {
    for (const renderPath of options.paths ?? (['forward', 'deferred'] as const)) {
      renderValue(renderer.setProfile({ ...profile, renderPath, ssao: false }));
      const pixels = new Map<string, number[]>();
      const bytes = new Map<string, Uint8Array>();
      for (const entry of cases) {
        world
          .set(object, Transform, {
            quat: [...rotation],
            scale: [1, 1, entry.objectScale ?? 1],
          })
          .unwrap();
        world
          .set(object, MeshFilter, {
            assetHandle: testAssets(world)
              .create(entry.skin ? withSkin(plane) : plane)
              .unwrap(),
          })
          .unwrap();
        if (entry.skin) {
          const joint = world
            .spawn({ component: Transform, data: { quat: [...rotation] } })
            .unwrap();
          const skeleton = testAssets(world)
            .create({
              kind: 'skeleton',
              jointCount: 1,
              inverseBindMatrices: new Float32Array([
                1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
              ]),
              bounds: new Float32Array([-1, -1, -1, 1, 1, 1]),
            })
            .unwrap();
          world
            .addComponent(object, {
              component: Skin,
              data: { skeleton, joints: new Uint32Array([joint]) },
            })
            .unwrap();
        }
        world
          .set(light, DirectionalLight, {
            direction: [...(entry.lit ? rakingLight : frontLight)],
            color: [1, 1, 1],
            intensity: entry.lit ? 4 : 2,
            castShadow: false,
          })
          .unwrap();
        const material = Materials.standard({
          baseColor: [1, 1, 1, 1],
          roughness: entry.lit ? 0.6 : 1,
          baseColorTexture: { texture: color, sampler },
          normalTexture: { texture: entry.lit ? reliefNormal : flatNormal, sampler },
          ...(entry.mode === undefined
            ? {}
            : {
                displacementTexture: {
                  texture: height,
                  sampler,
                  ...(entry.heightSet === 1 ? { coordinates: { set: 1 } } : {}),
                  ...(entry.rotatedSlot
                    ? { coordinates: { transform: { offset: [1, 1] as const, rotation: Math.PI } } }
                    : {}),
                },
                displacementScale: required(entry.scale),
                displacementBias: required(entry.bias),
                displacementMode: entry.mode,
              }),
        });
        world
          .set(object, MeshRenderer, {
            materials: [
              testAssets(world)
                .create(entry.skin ? skinned(material) : material)
                .unwrap(),
            ],
          })
          .unwrap();
        let receipt: Awaited<ReturnType<typeof drawReadyFrame>> | undefined;
        const recorder = entry.gpu || entry.skin ? options.recorder : undefined;
        let capture: ReturnType<NonNullable<typeof recorder>['captureFrame']> | undefined;
        for (let frame = 0; frame < frameCount; frame++) {
          world.update(1 / 60).unwrap();
          propagateTransforms(world).unwrap();
          if (recorder !== undefined && frame === frameCount - 1) {
            capture = recorder.captureFrame();
            (await recorder.frameBoundary()).unwrap();
          }
          receipt = await drawReadyFrame(
            renderer,
            {
              ...(entry.gpu ? {} : { geometryLane: 'direct' as const }),
              leases: [lease],
              camera: { lease },
              environment: { lease },
            },
            frame === frameCount - 1 ? ['linear-hdr'] : undefined,
          );
        }
        if (recorder !== undefined && capture !== undefined) {
          (await recorder.frameBoundary()).unwrap();
          const model = buildFrameModel(decodeTape((await capture).unwrap().bytes).unwrap());
          const marched = model.works.filter((work) =>
            work.pipeline.shaders.some((shader) =>
              shader.source?.includes('parallaxSourceUvOffset'),
            ),
          );
          const evidence: ParallaxPipelineEvidence = {
            sceneIndexParallax: marched.some((work) =>
              work.pipeline.shaders.some((shader) => shader.entryPoint === 'vs_scene_index'),
            ),
            skinParallax: marched.some((work) =>
              work.pipeline.shaders.some((shader) =>
                shader.source?.includes('standardSkinVariantIdentity'),
              ),
            ),
            fragmentEntries: [
              ...new Set(
                marched.flatMap((work) =>
                  work.pipeline.shaders.flatMap((shader) =>
                    shader.entryPoint?.startsWith('fs_') ? [shader.entryPoint] : [],
                  ),
                ),
              ),
            ],
          };
          pipelineEvidence[`${renderPath}/${entry.name}`] = evidence;
          if (entry.gpu)
            expect(evidence.sceneIndexParallax, `${renderPath} GPU-driven parallax pipeline`).toBe(
              true,
            );
          if (entry.skin)
            expect(evidence.skinParallax, `${renderPath} skinned parallax pipeline`).toBe(true);
        }
        const live = renderValue(
          await renderer.observe(required(receipt), { include: ['linear-hdr'] }),
        ).observations?.find((o) => o.domain === 'linear-hdr');
        if (!live) throw new Error('missing parallax HDR observation');
        bytes.set(entry.name, live.bytes);
        pixels.set(entry.name, hdr(live.bytes, live.metadata.bytesPerRow));
        await save(`${renderPath}-${entry.name}.rgba16f`, live.bytes);
        if (entry.skin) world.removeComponent(object, Skin).unwrap();
      }
      const value = (name: string) => required(pixels.get(name));
      const flat = value('flat');
      const parallax = value('parallax');
      let changedPixels = 0;
      for (let i = 0; i < flat.length; i += 3)
        if (Math.abs((flat[i] ?? 0) - (parallax[i] ?? 0)) > 0.05) changedPixels++;
      const flatEdges = recessEdges(flat);
      const parallaxEdges = recessEdges(parallax);
      const moved = [parallaxEdges[0] - flatEdges[0], parallaxEdges[1] - flatEdges[1]];
      const measuredShiftPx = Math.max(...moved.map(Math.abs));
      const expectedShiftPx = DEPTH * Math.sin(THETA) * (PARALLAX_SIZE / (2 * ORTHO_HALF));
      const variantDeltas: Record<string, number> = {};
      for (const name of ['parallax-gpu', 'object-scale', 'rotated-slot', 'skin'])
        if (pixels.has(name)) variantDeltas[name] = difference(parallax, value(name));
      if (pixels.has('other-set'))
        variantDeltas['other-set'] = difference(flat, value('other-set'));
      const zero = bytes.get('zero');
      const pathFacts: ParallaxPathFacts = {
        renderPath,
        recessDelta: difference(flat, parallax),
        changedPixels,
        zeroBytesIdentical:
          zero !== undefined &&
          zero.length === required(bytes.get('flat')).length &&
          zero.every((byte, i) => byte === bytes.get('flat')?.[i]),
        flatEdges,
        parallaxEdges,
        expectedShiftPx,
        measuredShiftPx,
        depthErrorPercent: (100 * Math.abs(measuredShiftPx - expectedShiftPx)) / expectedShiftPx,
        variantDeltas,
      };
      facts.push(pathFacts);
      parallaxByPath.set(renderPath, parallax);
      if (pixels.has('lit-parallax'))
        expect(difference(value('lit-flat'), value('lit-parallax'))).toBeGreaterThan(0.05);
      await save(
        'report.json',
        new TextEncoder().encode(JSON.stringify({ facts, pipelineEvidence }, null, 2)),
      );
      expect(pathFacts.recessDelta, `${renderPath} parallax changes the recess`).toBeGreaterThan(
        0.1,
      );
      expect(changedPixels).toBeGreaterThan(expectedShiftPx * 0.5 * 16);
      if (bytes.has('zero'))
        expect(pathFacts.zeroBytesIdentical, 'zero height is identity').toBe(true);
      // One recess edge stays at the base polygon; the far edge moves by depth * sin(theta).
      expect(Math.min(...moved.map(Math.abs))).toBeLessThanOrEqual(1);
      expect(pathFacts.depthErrorPercent).toBeLessThanOrEqual(10);
      for (const name of ['parallax-gpu', 'object-scale', 'rotated-slot'] as const)
        if (name in variantDeltas) {
          const edges = recessEdges(value(name));
          expect(Math.abs(edges[0] - parallaxEdges[0]), name).toBeLessThanOrEqual(1);
          expect(Math.abs(edges[1] - parallaxEdges[1]), name).toBeLessThanOrEqual(1);
        }
      if ('skin' in variantDeltas) {
        const edges = recessEdges(value('skin'));
        expect(Math.abs(edges[0] - parallaxEdges[0]), 'skin').toBeLessThanOrEqual(1);
        expect(Math.abs(edges[1] - parallaxEdges[1]), 'skin').toBeLessThanOrEqual(1);
      }
      if ('other-set' in variantDeltas)
        expect(variantDeltas['other-set'], 'UV1 height leaves UV0 color').toBeLessThanOrEqual(
          0.002,
        );
    }
    const forward = facts.find((entry) => entry.renderPath === 'forward');
    const deferred = facts.find((entry) => entry.renderPath === 'deferred');
    if (forward !== undefined && deferred !== undefined) {
      // Forward and Deferred share evaluateStandardSurface: the same hit, the same edges.
      expect(Math.abs(forward.parallaxEdges[0] - deferred.parallaxEdges[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(forward.parallaxEdges[1] - deferred.parallaxEdges[1])).toBeLessThanOrEqual(1);
      const a = required(parallaxByPath.get('forward'));
      const b = required(parallaxByPath.get('deferred'));
      const meanDelta =
        a.reduce((sum, v, i) => sum + Math.abs(v - (b[i] ?? Number.NaN)), 0) / a.length;
      await save(
        'forward-deferred.json',
        new TextEncoder().encode(JSON.stringify({ meanDelta, maxDelta: difference(a, b) })),
      );
      expect(meanDelta, 'Forward == Deferred parallax').toBeLessThanOrEqual(0.01);
    }
    expect(errors).toEqual([]);
    return facts;
  } catch (error) {
    await save(
      'failure.json',
      new TextEncoder().encode(JSON.stringify({ error: String(error), errors, facts }, null, 2)),
    );
    throw error;
  } finally {
    off();
    lease.dispose();
  }
}

export interface TiledPitFacts {
  readonly theta: number;
  readonly flatDark: number;
  readonly parallaxDark: number;
  /** Analytic floor fraction of the pit, (w - depth * tan(theta)) / w, clamped at 0. */
  readonly expectedFloor: number;
  /** Depth recovered from the visible floor fraction; undefined once floors are hidden. */
  readonly measuredDepth?: number;
}

const PIT_TILES = 4;
const PIT_DEPTH = 0.2;

/**
 * Perforated-panel conditions (T1 C-401): tiled mesh UVs, sharp repeat-sampled
 * height and pits deeper than wide in the UV metric. A height field turns each
 * pit into solid walls, so the visible floor along the tilt is
 * w - depth * tan(theta) and vanishes below the critical elevation. Plane-area
 * fractions equal pixel fractions under the orthographic camera.
 */
export async function verifyParallaxTiledPits(
  renderer: Renderer,
  save: Save,
): Promise<TiledPitFacts[]> {
  const world = new World();
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const assets = testAssets(world);
  const texture = (data: Uint8Array) =>
    assets
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: TEXELS, height: TEXELS } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data,
      } satisfies TextureAsset)
      .unwrap();
  const sampler = assets
    .create({
      kind: 'sampler',
      minFilter: 'nearest',
      magFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    })
    .unwrap();
  const height = { texture: texture(pattern(0, 255)), sampler };
  const color = { texture: texture(pattern(13, 255)), sampler };
  const normal = {
    texture: texture(pattern(128, 128).map((v, i) => (i % 4 === 2 ? 255 : v))),
    sampler,
  };
  const base = createPlaneGeometry(2, 2).unwrap();
  const uv = Float32Array.from(base.attributes.uv as Float32Array, (v) => v * PIT_TILES);
  const attributes = { ...base.attributes, uv };
  const plane = assets
    .create({
      ...base,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, uv.length / 2).unwrap().vertices,
    })
    .unwrap();
  const object = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: plane } },
      { component: MeshRenderer, data: { materials: [] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -ORTHO_HALF,
          right: ORTHO_HALF,
          top: ORTHO_HALF,
          bottom: -ORTHO_HALF,
          near: 0.1,
          far: 10,
          antialias: 0,
          bloom: 0,
          tonemap: 1,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 2, castShadow: false },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const facts: TiledPitFacts[] = [];
  const darkFraction = async (parallax: boolean): Promise<number> => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      roughness: 1,
      baseColorTexture: color,
      normalTexture: normal,
      ...(parallax
        ? {
            displacementTexture: height,
            displacementScale: PIT_DEPTH,
            displacementBias: -PIT_DEPTH,
            displacementMode: 'parallax' as const,
          }
        : {}),
    });
    world.set(object, MeshRenderer, { materials: [assets.create(material).unwrap()] }).unwrap();
    let receipt: Awaited<ReturnType<typeof drawReadyFrame>> | undefined;
    for (let frame = 0; frame < testQuality.staticFrames; frame++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      receipt = await drawReadyFrame(
        renderer,
        { geometryLane: 'direct', leases: [lease], camera: { lease }, environment: { lease } },
        frame === testQuality.staticFrames - 1 ? ['linear-hdr'] : undefined,
      );
    }
    const live = renderValue(
      await renderer.observe(required(receipt), { include: ['linear-hdr'] }),
    ).observations?.find((o) => o.domain === 'linear-hdr');
    if (!live) throw new Error('missing tiled-pit HDR observation');
    await save(`tiled-pits-${parallax ? 'parallax' : 'flat'}.rgba16f`, live.bytes);
    const pixels = hdr(live.bytes, live.metadata.bytesPerRow);
    const sums = Array.from(
      { length: pixels.length / 3 },
      (_, i) => (pixels[i * 3] ?? 0) + (pixels[i * 3 + 1] ?? 0) + (pixels[i * 3 + 2] ?? 0),
    );
    const bright = Math.max(...sums);
    const covered = sums.filter((sum) => sum > 1e-3);
    return covered.filter((sum) => sum < bright * 0.5).length / covered.length;
  };
  try {
    for (const theta of [Math.PI / 6, Math.PI / 3]) {
      const quat = [Math.sin(theta / 2), 0, 0, Math.cos(theta / 2)];
      world.set(object, Transform, { quat }).unwrap();
      const pit = 1 / PIT_TILES;
      const flatDark = await darkFraction(false);
      const parallaxDark = await darkFraction(true);
      const expectedFloor = Math.max(0, 1 - (PIT_DEPTH * Math.tan(theta)) / pit);
      // Normalizing by the flat pit fraction cancels pixel quantization of the pit.
      const floor = parallaxDark / flatDark;
      facts.push({
        theta,
        flatDark,
        parallaxDark,
        expectedFloor,
        ...(expectedFloor > 0 ? { measuredDepth: ((1 - floor) * pit) / Math.tan(theta) } : {}),
      });
    }
    await save('tiled-pits.json', new TextEncoder().encode(JSON.stringify(facts, null, 2)));
    for (const entry of facts) {
      expect(
        Math.abs(entry.flatDark - 0.25),
        'flat pits cover a quarter of every tile',
      ).toBeLessThanOrEqual(0.03);
      if (entry.measuredDepth === undefined)
        expect(entry.parallaxDark, `theta ${entry.theta} hides every floor`).toBeLessThanOrEqual(
          0.01,
        );
      else
        expect(
          Math.abs(entry.measuredDepth - PIT_DEPTH) / PIT_DEPTH,
          `theta ${entry.theta} depth ${entry.measuredDepth}`,
        ).toBeLessThanOrEqual(0.05);
    }
    expect(errors).toEqual([]);
    return facts;
  } finally {
    off();
    lease.dispose();
  }
}
