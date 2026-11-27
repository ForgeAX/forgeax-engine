import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  Materials,
  type StandardIrradianceFieldGi,
  type StandardScreenProbeGi,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { assert } from 'vitest';
import { observeSceneFieldCommands } from './gi-scene-field-commands.fixture';
import {
  type SceneProbeReadback,
  sceneProbeReadbackLayout,
} from './gi-scene-probe-readback.fixture';
import { sceneSupportForReceipt } from './gi-scene-support-readback.fixture';
import {
  createIrradianceFieldHarness,
  irradianceFieldGi,
} from './renderer-irradiance-field.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

export const SCENE_WIDTH = 96;
export const SCENE_HEIGHT = 64;
export const SCENE_ENVIRONMENT = [0.24, 0.4, 0.16] as const;
export const PANEL_COLORS = [
  [0.8, 0.12, 0.05],
  [0.08, 0.7, 0.16],
  [0.12, 0.2, 0.9],
] as const;
export const PANEL_CENTERS = [-1.1, 0, 1.1] as const;
export const SCENE_ROTATIONS = [
  { name: 'axis', yaw: 0, roll: 0 },
  { name: 'roll-27', yaw: 0, roll: (27 * Math.PI) / 180 },
  { name: 'yaw-31', yaw: (31 * Math.PI) / 180, roll: 0 },
  { name: 'yaw-roll', yaw: (-23 * Math.PI) / 180, roll: (19 * Math.PI) / 180 },
] as const;
type Rotation = (typeof SCENE_ROTATIONS)[number];
export type SceneHarness = Awaited<ReturnType<typeof sceneHarness>>;
export interface SceneImage {
  /** Absent on an average; present only for a single completed observation. */
  readonly frameId?: number;
  readonly rgb: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly support?: Float32Array;
  readonly transport?: Float32Array;
  readonly covered?: Uint8Array;
  readonly probeState?: SceneProbeReadback;
}

interface ScenePixelReadback {
  readonly bytes: Uint8Array;
  readonly metadata: { readonly bytesPerRow: number };
}

function scenePixels(read: ScenePixelReadback, visible: ScenePixelReadback) {
  const rgb = new Float32Array(SCENE_WIDTH * SCENE_HEIGHT * 3);
  const data = new DataView(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
  const visibleData = new DataView(
    visible.bytes.buffer,
    visible.bytes.byteOffset,
    visible.bytes.byteLength,
  );
  const covered = new Uint8Array(SCENE_WIDTH * SCENE_HEIGHT);
  for (let p = 0; p < SCENE_WIDTH * SCENE_HEIGHT; p++) {
    const x = p % SCENE_WIDTH,
      y = Math.floor(p / SCENE_WIDTH);
    for (let c = 0; c < 3; c++)
      rgb[p * 3 + c] = halfFloat.f16ToF32(
        data.getUint16(y * read.metadata.bytesPerRow + x * 8 + c * 2, true),
      );
    covered[p] = visibleData.getUint32(y * visible.metadata.bytesPerRow + x * 16 + 12, true) & 1;
  }
  return { rgb, covered };
}

/** Independent rigid transform: R_y(yaw) R_z(roll), xyzw quaternion. */
export function sceneRotation(rotation: Pick<Rotation, 'yaw' | 'roll'>) {
  const cy = Math.cos(rotation.yaw),
    sy = Math.sin(rotation.yaw);
  const cr = Math.cos(rotation.roll),
    sr = Math.sin(rotation.roll);
  return {
    point: ([x, y, z]: readonly number[]) => [
      cy * (cr * (x ?? 0) - sr * (y ?? 0)) + sy * (z ?? 0),
      sr * (x ?? 0) + cr * (y ?? 0),
      -sy * (cr * (x ?? 0) - sr * (y ?? 0)) + cy * (z ?? 0),
    ],
    quat: [
      Math.sin(rotation.yaw / 2) * Math.sin(rotation.roll / 2),
      Math.sin(rotation.yaw / 2) * Math.cos(rotation.roll / 2),
      Math.cos(rotation.yaw / 2) * Math.sin(rotation.roll / 2),
      Math.cos(rotation.yaw / 2) * Math.cos(rotation.roll / 2),
    ],
  };
}

export function sceneGi(
  mode: 'field' | 'screen',
  options: {
    clipLevels?: number;
    radiosity?: boolean;
    environment?: readonly [number, number, number];
    raysPerProbe?: number;
    probeSpacing?: number;
    probeBudget?: number;
    hysteresis?: number;
  } = {},
): StandardIrradianceFieldGi | StandardScreenProbeGi {
  const field = irradianceFieldGi({
    environment: options.environment ?? SCENE_ENVIRONMENT,
    resolution: 'full',
    hysteresis: options.hysteresis ?? 0.5,
    raysPerProbe: options.raysPerProbe ?? 64,
    probeBudget: options.probeBudget ?? 512,
    radiosity: options.radiosity ?? false,
    ...(options.clipLevels === undefined
      ? {}
      : { clipmap: { levels: options.clipLevels, dimensions: [6, 6, 6] } }),
  });
  const commonField = { ...field.field, probeSpacing: options.probeSpacing ?? 1 };
  return mode === 'field'
    ? { ...field, field: commonField }
    : {
        gather: 'screen-probe',
        maxDistance: field.maxDistance,
        environment: field.environment,
        field: commonField,
        probes: {
          downsample: 8,
          adaptiveFraction: 0.5,
          importance: 'uniform',
          screenTrace: { maxSteps: 32, thickness: 0.02 },
          filterPasses: 2,
          shortRangeAo: 0,
          maxFrames: 8,
        },
      };
}

export async function sceneHarness(
  manifest: string,
  id: string,
  diagnostics?: { readonly softwareField: boolean },
) {
  const root = process.env.FORGEAX_GI_SCENE_ARTIFACTS ?? 'artifacts/gi-scenes';
  const directory = join(root, id);
  mkdirSync(directory, { recursive: true });
  const recorder = attachRecorder(webgpu).unwrap();
  const h = await createIrradianceFieldHarness({
    rhi: recorder.backend.rhi,
    manifest,
    instrumentation: {
      resolveSurfaceDevice: (
        device: Parameters<typeof recorder.backend.unwrapDeviceForSurface>[0],
      ) => ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
  });
  h.canvas.width = SCENE_WIDTH;
  h.canvas.height = SCENE_HEIGHT;
  h.world.set(h.camera, Camera, { aspect: SCENE_WIDTH / SCENE_HEIGHT }).unwrap();
  h.world.despawn(h.wall).unwrap();
  h.setGi(undefined);
  // Runtime creates/configures its native surface lazily on the first draw.
  // Observe buffers only after that owner has initialized the real device.
  await h.draw();
  const sceneBuffers = new Map<string, GPUBuffer>();
  const bufferIdentities = new WeakMap<GPUBuffer, number>();
  let bufferIdentity = 0;
  const native = h.native();
  assert(native);
  const originalCreateBuffer = native.createBuffer;
  const createBuffer = originalCreateBuffer.bind(native);
  native.createBuffer = (descriptor) => {
    const buffer = createBuffer(descriptor);
    if (
      descriptor.label?.startsWith('screen-probe.') ||
      descriptor.label?.startsWith('irradiance-field.')
    ) {
      sceneBuffers.set(descriptor.label, buffer);
      bufferIdentities.set(buffer, ++bufferIdentity);
    }
    return buffer;
  };
  const files: { name: string; sha256: string; bytes: number }[] = [];
  const save = (name: string, value: unknown) => {
    const bytes = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value, null, 2));
    writeFileSync(join(directory, name), bytes);
    files.push({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
    });
  };
  let fieldCommands: ReturnType<typeof observeSceneFieldCommands> | undefined;
  try {
    if (diagnostics?.softwareField)
      fieldCommands = observeSceneFieldCommands(native, (sha256, bytes) => {
        save(`field-module-${sha256}.json`, { sha256, bytes: bytes.byteLength });
      });
  } catch (error) {
    native.createBuffer = originalCreateBuffer;
    sceneBuffers.clear();
    try {
      await h.dispose();
    } finally {
      (await recorder.dispose()).unwrap();
    }
    throw error;
  }
  function probeBuffers(probeLayout: ReturnType<typeof sceneProbeReadbackLayout> | undefined) {
    const meta = probeLayout ? sceneBuffers.get('irradiance-field.meta') : undefined;
    const list = probeLayout ? sceneBuffers.get('irradiance-field.probe-list') : undefined;
    if (probeLayout) {
      assert(meta && list, 'Missing current probe metadata or list');
      assert(
        meta.label === 'irradiance-field.meta' && list.label === 'irradiance-field.probe-list',
      );
      assert(meta.size === probeLayout.metaBytes && list.size === probeLayout.listBytes);
      assert((meta.usage & 4) !== 0 && (list.usage & 4) !== 0);
    }
    return { meta, list };
  }
  function saveFieldDispatches(
    name: string | undefined,
    state: ReturnType<typeof h.renderer.inspect>['diffuseGi'],
    commandStart: number | undefined,
    frameId: number,
  ) {
    if (fieldCommands && commandStart !== undefined) {
      assert(state && 'gather' in state && state.gather === 'irradiance-field');
      assert(state.traversal === 'global-sdf');
      assert(state.traversalFallback === 'hardware-ray-query-disabled');
      if (name !== undefined)
        save(`${name}-field-dispatches.json`, fieldCommands.completed(commandStart, frameId));
    }
  }
  const image = async (
    name?: string,
    options?: { readonly probeState: boolean },
  ): Promise<SceneImage> => {
    const commandStart = fieldCommands?.cursor();
    const previousGi = h.renderer.inspect().diffuseGi;
    const receipt = await h.draw(['linear-hdr', 'visible-surface']);
    const observations = renderValue(
      await h.renderer.observe(receipt, { include: ['linear-hdr', 'visible-surface'] }),
    ).observations;
    const read = observations?.find((item) => item.domain === 'linear-hdr');
    const visible = observations?.find((item) => item.domain === 'visible-surface');
    assert(read && visible, 'HDR and visible surface must belong to the same completed receipt');
    assert(
      read.metadata.frameId === receipt.frameId && visible.metadata.frameId === receipt.frameId,
    );
    const { rgb, covered } = scenePixels(read, visible);
    let support: Float32Array | undefined;
    let transport: Float32Array | undefined;
    let probeState: SceneProbeReadback | undefined;
    const state = h.renderer.inspect().diffuseGi;
    if (options?.probeState)
      assert(
        state && 'gather' in state && state.gather === 'irradiance-field',
        'Probe diagnostics require a live Field',
      );
    if (
      state &&
      'gather' in state &&
      (state.gather === 'screen-probe' || state.gather === 'irradiance-field')
    ) {
      const label =
        state.gather === 'screen-probe' ? 'screen-probe.integrated' : 'irradiance-field.gathered';
      const values = await sceneSupportForReceipt(
        previousGi,
        state,
        SCENE_WIDTH * SCENE_HEIGHT,
        async () => {
          const probeLayout =
            options?.probeState && state.gather === 'irradiance-field'
              ? sceneProbeReadbackLayout(
                  previousGi,
                  state,
                  state.probes?.count ?? 0,
                  state.probes?.perFrame ?? 0,
                )
              : undefined;
          const source = sceneBuffers.get(label);
          assert(source, `Missing production support buffer ${label}`);
          assert(
            source.size === SCENE_WIDTH * SCENE_HEIGHT * 16,
            `${label} must be full resolution`,
          );
          const { meta, list } = probeBuffers(probeLayout);
          const staging = native.createBuffer({
            size: source.size + (probeLayout?.metaBytes ?? 0) + (probeLayout?.listBytes ?? 0),
            usage: 9,
          });
          try {
            const encoder = native.createCommandEncoder();
            encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
            if (probeLayout && meta && list) {
              encoder.copyBufferToBuffer(meta, 0, staging, source.size, probeLayout.metaBytes);
              encoder.copyBufferToBuffer(
                list,
                0,
                staging,
                source.size + probeLayout.metaBytes,
                probeLayout.listBytes,
              );
            }
            native.queue.submit([encoder.finish()]);
            await staging.mapAsync(1);
            const bytes = staging.getMappedRange().slice(0);
            const values = new Float32Array(probeLayout ? bytes.slice(0, source.size) : bytes);
            if (probeLayout && meta && list && state.gather === 'irradiance-field') {
              probeState = {
                meta: new Uint8Array(bytes.slice(source.size, source.size + probeLayout.metaBytes)),
                list: new Uint8Array(bytes.slice(source.size + probeLayout.metaBytes)),
                metaIdentity: bufferIdentities.get(meta) ?? 0,
                listIdentity: bufferIdentities.get(list) ?? 0,
                count: state.probes?.count ?? 0,
                capacity: state.probes?.perFrame ?? 0,
              };
            }
            staging.unmap();
            return values;
          } finally {
            staging.destroy();
          }
        },
      );
      transport = values;
      support = Float32Array.from(
        { length: SCENE_WIDTH * SCENE_HEIGHT },
        (_, p) => values[p * 4 + 3] ?? NaN,
      );
      if (name !== undefined) save(`${name}-signal.f32`, new Uint8Array(values.buffer));
    }
    if (options?.probeState) {
      assert(probeState, 'No current probe producer readback');
      saveFieldDispatches(name, state, commandStart, receipt.frameId);
    }
    if (name !== undefined) {
      save(`${name}.f32`, new Uint8Array(rgb.buffer));
      save(`${name}-visible.u8`, covered);
      save(`${name}-visible.rgba32uint`, visible.bytes);
      if (visible.domain === 'visible-surface')
        save(`${name}-visible-records.u32`, new Uint8Array(visible.records.buffer));
      if (probeState) {
        save(`${name}-probe-meta.u32`, probeState.meta);
        save(`${name}-probe-list.u32`, probeState.list);
      }
      save(`${name}-observation.json`, {
        frameId: receipt.frameId,
        hdr: read.metadata,
        visible: visible.metadata,
        gi: state,
        ...(probeState
          ? {
              probeState: {
                count: probeState.count,
                capacity: probeState.capacity,
                metaIdentity: probeState.metaIdentity,
                listIdentity: probeState.listIdentity,
                metaLabel: 'irradiance-field.meta',
                listLabel: 'irradiance-field.probe-list',
                metaBytes: probeState.meta.byteLength,
                listBytes: probeState.list.byteLength,
              },
            }
          : {}),
      });
    }
    return {
      rgb,
      frameId: receipt.frameId,
      width: SCENE_WIDTH,
      height: SCENE_HEIGHT,
      covered,
      ...(support ? { support } : {}),
      ...(transport ? { transport } : {}),
      ...(probeState ? { probeState } : {}),
    };
  };
  return {
    ...h,
    image,
    save,
    directory,
    async captureFrameImage(name: string) {
      const capture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const sample = await image(name);
      (await recorder.frameBoundary()).unwrap();
      const tape = (await capture).unwrap();
      save(`${name}.rhitape`, tape.bytes);
      return sample;
    },
    async captureAcceptance(expectedResolveMarker?: string) {
      const capture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      await image('acceptance-after-measurement');
      (await recorder.frameBoundary()).unwrap();
      const tape = (await capture).unwrap();
      const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
      const resolve = model.works.find((work) =>
        work.pipeline?.shaders.some((shader) => shader.entryPoint === 'resolveProbeRays'),
      );
      if (expectedResolveMarker)
        assert(
          resolve?.pipeline?.shaders.some((shader) =>
            shader.source?.includes(expectedResolveMarker),
          ),
          'The actual selected resolve shader must carry the expected sampling contract',
        );
      const generate = model.works.find((work) =>
        work.pipeline?.shaders.some((shader) => shader.entryPoint === 'generateProbeRays'),
      );
      const expectedAngular = process.env.FORGEAX_GI_EXPECT_ANGULAR_SAMPLE;
      if (expectedResolveMarker && expectedAngular)
        assert(
          generate?.pipeline?.shaders.some((shader) => shader.source?.includes(expectedAngular)),
          'The actual selected generator must carry progressive angular rotation',
        );
      const world = model.works.find((work) =>
        work.pipeline?.shaders.some((shader) => shader.entryPoint === 'traceWorldProbes'),
      );
      if (expectedResolveMarker && process.env.FORGEAX_GI_EXPECT_SOFTWARE_FIELD_ORIGIN === '1')
        assert(
          world?.pipeline?.shaders.some(
            (shader) =>
              shader.source?.includes('return position + normal * fieldBias;') &&
              shader.source.includes('if(status!=0u&&status!=1u&&status!=2u)') &&
              !shader.source.includes('exactReceiver'),
          ),
          'The selected world shader must use software field clearance and reject unknown query outcomes',
        );
      save('acceptance.rhitape', tape.bytes);
      save('acceptance-source.json', {
        digest: tape.digest,
        expectedResolveMarker,
        expectedAngular,
        resolveWork: resolve?.workIndex,
        generateWork: generate?.workIndex,
        worldWork: world?.workIndex,
        expectedSoftwareFieldOrigin: process.env.FORGEAX_GI_EXPECT_SOFTWARE_FIELD_ORIGIN === '1',
        scope:
          'One real frame recorded after the stated measurement window; proves executed source identity, not another measurement-window average.',
      });
    },
    async captureFailure() {
      const capture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const failing = await image('failure-reproduced');
      (await recorder.frameBoundary()).unwrap();
      const tape = (await capture).unwrap();
      save('failure.rhitape', tape.bytes);
      return failing;
    },
    async recordFailure(error: unknown) {
      save('failure.json', {
        message: String(error),
        inspection: h.renderer.inspect(),
        errors: h.errors,
      });
      try {
        await this.captureFailure();
      } catch (captureError) {
        save('capture-failure.json', { message: String(captureError) });
      }
    },
    async dispose() {
      // Return the borrowed device method and release observed native buffers
      // before retiring the Renderer; observation owns no device lifetime.
      native.createBuffer = originalCreateBuffer;
      sceneBuffers.clear();
      if (fieldCommands) save('field-command-observer.json', fieldCommands.dispose());
      const info = h.native()?.adapterInfo;
      save('manifest.json', {
        id,
        dimensions: [SCENE_WIDTH, SCENE_HEIGHT],
        engine: process.env.FORGEAX_GI_SCENE_ENGINE,
        adapter: info
          ? {
              vendor: info.vendor,
              architecture: info.architecture,
              device: info.device,
              description: info.description,
            }
          : { unavailable: true },
        files,
        inspection: h.renderer.inspect(),
        errors: h.errors,
      });
      await h.dispose();
      (await recorder.dispose()).unwrap();
    },
  };
}

export async function coloredPanels(h: SceneHarness, rotation: Rotation) {
  const transform = sceneRotation(rotation);
  const panels = [];
  const mesh = await h.slab(1, 2.5, 0.25);
  for (const [i, color] of PANEL_COLORS.entries()) {
    const material = await h.publish(
      Materials.standard({ baseColor: [...color, 1], roughness: 1, specular: 0 }),
    );
    const entity = h.spawn(mesh, material, [0, 0, 0]);
    h.world
      .set(entity, Transform, {
        pos: transform.point([PANEL_CENTERS[i] ?? 0, 0, -3]),
        quat: transform.quat,
      })
      .unwrap();
    panels.push(entity);
  }
  h.world.set(h.camera, Transform, { quat: transform.quat }).unwrap();
  return panels;
}

/** Analytic primary-ray/box front-face mask; a margin excludes raster edges. */
export function panelPixels(panel: number, cameraX = 0, cameraY = 0): number[] {
  const pixels: number[] = [];
  const tangent = Math.tan(Math.PI / 6);
  for (let y = 0; y < SCENE_HEIGHT; y++)
    for (let x = 0; x < SCENE_WIDTH; x++) {
      const wx =
        cameraX +
        (((x + 0.5) / SCENE_WIDTH) * 2 - 1) * tangent * (SCENE_WIDTH / SCENE_HEIGHT) * 2.875;
      const wy = cameraY + (1 - ((y + 0.5) / SCENE_HEIGHT) * 2) * tangent * 2.875;
      if (Math.abs(wx - (PANEL_CENTERS[panel] ?? 0)) < 0.36 && Math.abs(wy) < 1.08)
        pixels.push(y * SCENE_WIDTH + x);
    }
  return pixels;
}

export function channelMeans(image: SceneImage, pixels: readonly number[]): number[] {
  assert(pixels.length > 16);
  return [0, 1, 2].map(
    (c) => pixels.reduce((s, p) => s + (image.rgb[p * 3 + c] ?? NaN), 0) / pixels.length,
  );
}

export function difference(a: SceneImage, b: SceneImage): SceneImage {
  return { ...a, rgb: Float32Array.from(a.rgb, (v, i) => v - (b.rgb[i] ?? NaN)) };
}

/** Geometry ownership supplies this mask; black radiance never hides a hole. */
export function visibleSupport(image: SceneImage) {
  assert(image.covered && image.support);
  let visible = 0,
    missing = 0,
    incomplete = 0;
  for (let p = 0; p < image.covered.length; p++)
    if (image.covered[p]) {
      visible++;
      if (!((image.support[p] ?? NaN) > 0.99)) missing++;
      if ((image.support[p] ?? NaN) < 0) incomplete++;
    }
  assert(visible > 0);
  return { visible, missing, incomplete, missingFraction: missing / visible };
}

/** Pair support with that observation's visibility before extending the union.
 * Earlier visible observations without support remain unknown, including when
 * the first support array arrives later. Unobserved pixels have no valid domain. */
function accumulateFrameSupport(
  sample: SceneImage,
  covered: Uint8Array,
  minimum: Float32Array | undefined,
): Float32Array | undefined {
  if (sample.support && !minimum) minimum = new Float32Array(covered.length).fill(NaN);
  for (let pixel = 0; pixel < covered.length; pixel++) {
    if (sample.covered?.[pixel] && minimum) {
      const value = sample.support?.[pixel] ?? NaN;
      minimum[pixel] = covered[pixel] ? Math.min(minimum[pixel] ?? NaN, value) : value;
    }
    covered[pixel] = (covered[pixel] ?? 0) | (sample.covered?.[pixel] ?? 0);
  }
  return minimum;
}

export async function averageFrames(
  h: Pick<SceneHarness, 'image' | 'captureFrameImage' | 'save'>,
  name: string,
  count: number,
): Promise<SceneImage> {
  const rgb = new Float32Array(SCENE_WIDTH * SCENE_HEIGHT * 3);
  let minimumSupport: Float32Array | undefined;
  const covered = new Uint8Array(SCENE_WIDTH * SCENE_HEIGHT);
  const captureFrames = process.env.FORGEAX_GI_CAPTURE_PHASE_WINDOWS === '1';
  for (let frame = 0; frame < count; frame++) {
    const label = captureFrames ? `${name}-frame-${frame}` : undefined;
    const sample =
      label !== undefined && frame === count - 1
        ? await h.captureFrameImage(label)
        : await h.image(label);
    minimumSupport = accumulateFrameSupport(sample, covered, minimumSupport);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (rgb[i] ?? 0) + (sample.rgb[i] ?? NaN) / count;
  }
  h.save(`${name}.f32`, new Uint8Array(rgb.buffer));
  h.save(`${name}-visible.u8`, covered);
  if (minimumSupport) h.save(`${name}-minimum-support.f32`, new Uint8Array(minimumSupport.buffer));
  return {
    rgb,
    width: SCENE_WIDTH,
    height: SCENE_HEIGHT,
    covered,
    ...(minimumSupport ? { support: minimumSupport } : {}),
  };
}

export async function twoRooms(h: SceneHarness, rotation: Rotation) {
  const transform = sceneRotation(rotation);
  const spawn = async (
    dimensions: readonly [number, number, number],
    position: readonly number[],
    material = h.white,
  ) => {
    const entity = h.spawn(await h.slab(...dimensions), material, [0, 0, 0]);
    h.world
      .set(entity, Transform, { pos: transform.point(position), quat: transform.quat })
      .unwrap();
    return entity;
  };
  await spawn([8, 8, 0.25], [0, 0, -3]);
  await spawn([8, 0.25, 8], [0, -1.5, -1]);
  const divider = await spawn([0.25, 8, 4], [0, 0, -1]);
  const source = await h.publish(
    Materials.standard({
      baseColor: [0, 0, 0, 1],
      specular: 0,
      roughness: 1,
      emissive: [1, 0.3, 0.7],
      emissiveIntensity: 4,
    }),
  );
  await spawn([0.25, 2, 1.5], [-2.5, 0, 0.3], source);
  h.world
    .set(h.camera, Transform, { pos: transform.point([0, 0, 2]), quat: transform.quat })
    .unwrap();
  return { divider, restoreDivider: () => spawn([0.25, 8, 4], [0, 0, -1]) };
}

/** Back-wall rectangles expressed in camera-local coordinates before rotation. */
export function roomPixels(side: 'left' | 'right'): number[] {
  const pixels: number[] = [];
  for (let y = 0; y < SCENE_HEIGHT; y++)
    for (let x = 0; x < SCENE_WIDTH; x++) {
      const wx =
        (((x + 0.5) / SCENE_WIDTH) * 2 - 1) *
        Math.tan(Math.PI / 6) *
        (SCENE_WIDTH / SCENE_HEIGHT) *
        4.875;
      const wy = (1 - ((y + 0.5) / SCENE_HEIGHT) * 2) * Math.tan(Math.PI / 6) * 4.875;
      if (Math.abs(wy) < 0.8 && (side === 'left' ? wx > -1.8 && wx < -0.6 : wx > 0.6 && wx < 1.8))
        pixels.push(y * SCENE_WIDTH + x);
    }
  return pixels;
}

/** Exact polygon form factor, independent of Engine traversal and estimators.
 * Stokes' theorem: integral(n dot omega dOmega) = 1/2 sum(edgeAngle *
 * n dot normalized(a cross b)), where a/b are unit corner directions.
 * Only the two visible faces of the convex emitter contribute to these ROIs. */
function faceFormFactor(point: readonly number[], face: readonly (readonly number[])[]): number {
  const directions = face.map((corner) => {
    const delta = corner.map((v, c) => v - (point[c] ?? NaN));
    const length = Math.hypot(...delta);
    return delta.map((v) => v / length);
  });
  let edgeSum = 0;
  for (let edge = 0; edge < 4; edge++) {
    const a = directions[edge],
      b = directions[(edge + 1) % 4];
    if (!a || !b) throw new Error('Four polygon directions required');
    const cross = [
      (a[1] ?? NaN) * (b[2] ?? NaN) - (a[2] ?? NaN) * (b[1] ?? NaN),
      (a[2] ?? NaN) * (b[0] ?? NaN) - (a[0] ?? NaN) * (b[2] ?? NaN),
      (a[0] ?? NaN) * (b[1] ?? NaN) - (a[1] ?? NaN) * (b[0] ?? NaN),
    ];
    const sine = Math.hypot(...cross);
    const cosine = a.reduce((s, v, c) => s + v * (b[c] ?? NaN), 0);
    edgeSum += (Math.atan2(sine, cosine) * (cross[2] ?? NaN)) / sine;
  }
  return Math.abs(edgeSum) * 0.5;
}

export function roomAnalyticReference(state: 'closed' | 'open'): SceneImage {
  const rgb = new Float32Array(SCENE_WIDTH * SCENE_HEIGHT * 3).fill(NaN);
  const faces = [
    [
      [-2.375, -1, -0.45],
      [-2.375, 1, -0.45],
      [-2.375, 1, 1.05],
      [-2.375, -1, 1.05],
    ],
    [
      [-2.625, -1, -0.45],
      [-2.375, -1, -0.45],
      [-2.375, 1, -0.45],
      [-2.625, 1, -0.45],
    ],
  ];
  for (const side of ['left', 'right'] as const)
    for (const p of roomPixels(side)) {
      const x = p % SCENE_WIDTH,
        y = Math.floor(p / SCENE_WIDTH);
      const point = [
        (((x + 0.5) / SCENE_WIDTH) * 2 - 1) * Math.tan(Math.PI / 6) * 1.5 * 4.875,
        (1 - ((y + 0.5) / SCENE_HEIGHT) * 2) * Math.tan(Math.PI / 6) * 4.875,
        -2.875,
      ];
      let irradiance = 0;
      if (state === 'open' || side === 'left')
        for (const face of faces) {
          irradiance += faceFormFactor(point, face);
        }
      for (const [c, emission] of [4, 1.2, 2.8].entries())
        rgb[p * 3 + c] = (emission * irradiance) / Math.PI;
    }
  return { rgb, width: SCENE_WIDTH, height: SCENE_HEIGHT };
}

export function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor((ordered.length - 1) * fraction)] ?? NaN;
}
