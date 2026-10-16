import { type EntityHandle, World } from '@forgeax/engine-ecs';
import {
  Camera,
  LineCapValue,
  Lines,
  LineWidthUnitsValue,
  Materials,
  MeshFilter,
  MeshRenderer,
  Points,
} from '@forgeax/engine-render';
import {
  addTypedOutputTransformPass,
  addTypedScenePass,
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipeline,
} from '@forgeax/engine-render/authoring';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  encodeTape,
  inspectBufferRecords,
  openReplay,
  replayDeviceRequest,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { type MaterialAsset, type MeshAsset, ok } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import threePixels from './continuous-lines-three.json';
import { renderValue } from './standard-gbuffer-replay.fixture';

/** The real retained -> prepare -> Standard scene draw, with no application shader. */
export async function verifyContinuousLines(options: {
  shaderManifestUrl: string;
  save(name: string, bytes: Uint8Array): void | Promise<void>;
}) {
  const errors: unknown[] = [];
  const width = 320;
  let height = 192;
  let surface: GPUTexture | undefined;
  let rawDevice: GPUDevice | undefined;
  const canvas = {
    width,
    height,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        rawDevice = config.device;
        rawDevice.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        surface?.destroy();
        surface = rawDevice.createTexture({
          size: [canvas.width, canvas.height],
          format: config.format,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: 0x11,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => surface,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const copies: Array<{ buffer: Buffer; device: RhiDevice }> = [];
  let observe = false;
  const stride = Math.ceil((width * 4) / 256) * 256;
  const pipeline: RenderPipeline = {
    build({ graph }, topology) {
      const color = createRenderPipelineTarget(graph, 'continuous-lines-color', {
        format: 'rgba8unorm',
        size: 'surface',
        usage: 0x15,
      }).unwrap();
      const depth = createRenderPipelineTarget(graph, 'continuous-lines-depth', {
        format: 'depth32float-stencil8',
        size: 'surface',
      }).unwrap();
      const scene = addTypedScenePass(graph, {
        name: 'continuous-lines',
        color,
        depth,
        selector: { LightMode: ['Forward'] },
        colorClearValues: [[0, 0, 0, 1]],
      });
      if (!scene.ok) return scene;
      const copied = graph.addCopyPass('continuous-lines-readback', {
        accesses: [{ resource: color.view, usage: 'copy-src' }],
        encode({ encoder, frame, resources }) {
          if (!observe) return;
          const buffer = frame.runtime.device
            .createBuffer({ size: stride * height, usage: 9 })
            .unwrap();
          encoder.copyTextureToBuffer(
            { texture: resources.texture(color.texture).unwrap() },
            { buffer, bytesPerRow: stride, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 },
          );
          copies.push({ buffer, device: frame.runtime.device });
        },
      });
      if (!copied.ok) return copied;
      const display = importRenderPipelineSurface(graph, topology).unwrap();
      return addTypedOutputTransformPass(graph, color, display.storage, {
        outputOnly: true,
        dither: false,
      });
    },
  };
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        pipeline,
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      },
      { shaderManifestUrl: options.shaderManifestUrl },
    ),
  );
  const { renderer } = host;
  // Replay borrows these devices. Keep them until the live journey ends,
  // then release their native shader/pipeline state as well as session resources.
  const replayDevices: GPUDevice[] = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  try {
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            projection: 1,
            left: 0,
            right: width,
            bottom: 0,
            top: height,
            near: 0.1,
            far: 10,
            antialias: 0,
            bloom: 0,
            tonemap: 0,
          },
        },
      )
      .unwrap();
    const entities: EntityHandle[] = [];
    const spawn = (
      positions: number[],
      topology: 'line-list' | 'line-strip' | 'point-list',
      color: readonly [number, number, number, number],
      style: {
        width?: number;
        widthUnits?: number;
        cap?: number;
        dashSize?: number;
        gapSize?: number;
        dashOffset?: number;
      } = {},
      indices?: number[],
      material: MaterialAsset = Materials.unlit(color),
    ) => {
      const vertices = new Float32Array(positions);
      const mesh: MeshAsset = {
        kind: 'mesh',
        vertices,
        attributes: { position: vertices },
        ...(indices ? { indices: new Uint16Array(indices) } : {}),
        submeshes: [
          {
            topology,
            vertexCount: positions.length / 3,
            indexOffset: 0,
            indexCount: indices?.length ?? 0,
            materialSlot: 0,
          },
        ],
        materialSlots: [{ slotName: 'default' }],
      };
      const entity = world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', mesh) } },
          {
            component: MeshRenderer,
            data: {
              materials: [world.allocSharedRef('MaterialAsset', material)],
            },
          },
        )
        .unwrap();
      if (topology === 'point-list')
        world.addComponent(entity, { component: Points, data: { sizePx: 10, shape: 1 } }).unwrap();
      else world.addComponent(entity, { component: Lines, data: { width: 8, ...style } }).unwrap();
      entities.push(entity);
      return entity;
    };
    // Red path: a right-angle join and a diagonal in a non-square viewport.
    spawn([20, 160, 0, 80, 160, 0, 80, 120, 0, 120, 100, 0], 'line-strip', [1, 0, 0, 1]);
    // Green path: a 27-unit first segment ensures phase cannot reset at its corner.
    const dashed = spawn([20, 80, 0, 47, 80, 0, 47, 20, 0], 'line-strip', [0, 1, 0, 1], {
      dashSize: 12,
      gapSize: 8,
    });
    // Closed indexed blue boundary; closure uses the same join as interior vertices.
    spawn(
      [170, 140, 0, 260, 140, 0, 260, 60, 0, 170, 60, 0],
      'line-strip',
      [0, 0, 1, 1],
      {},
      [0, 1, 2, 3, 0],
    );
    // Existing line-list and points remain visible with the canonical vertex stride.
    spawn([140, 30, 0, 200, 30, 0, 220, 30, 0, 280, 30, 0], 'line-list', [1, 1, 0, 1], {
      width: 4,
      dashSize: 10,
      gapSize: 10,
    });
    spawn([295, 165, 0], 'point-list', [1, 0, 1, 1]);
    // A path entering from behind the camera still joins at its visible corner.
    spawn([280, 80, 4, 280, 110, 0, 300, 110, 0], 'line-strip', [1, 1, 1, 1]);
    const lease = renderValue(renderer.attach(world));
    let frames = 0;
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const receipt = renderValue(
        renderer.draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
          geometryLane: 'direct',
        }),
      );
      renderValue(await receipt.completed);
      frames++;
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    for (let i = 0; i < 60; i++) {
      await draw();
    }
    type Pixel = (x: number, y: number) => number[];
    const capture = async (name: string, draws: number, check: (pixel: Pixel) => void) => {
      observe = true;
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      await draw();
      (await recorder.frameBoundary()).unwrap();
      const encoded = (await pending).unwrap();
      observe = false;
      await options.save(`${name}.rhitape`, encoded.bytes);
      const tape = decodeTape(encoded.bytes).unwrap();
      const model = buildFrameModel(tape);
      const works = model.works.filter((work) => work.kind === 'drawIndexed');
      expect(works).toHaveLength(draws);
      const work = works.at(-1);
      if (!work?.attachments) throw new Error('line draw attachments absent');
      const colorId = work.attachments.colorViewHandleIds[0];
      if (colorId === undefined) throw new Error('line color absent');
      const copy = copies.shift();
      if (!copy) throw new Error('live readback absent');
      const mapped = (await copy.buffer.mapAsync(1)).unwrap();
      const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
      const live = new Uint8Array(width * height * 4);
      for (let row = 0; row < height; row++)
        live.set(bytes.subarray(row * stride, row * stride + width * 4), row * width * 4);
      mapped.unmap();
      copy.device.destroyBuffer(copy.buffer).unwrap();
      await options.save(`${name}.rgba`, live);
      const pixel: Pixel = (x, y) => [
        ...live.slice(((height - 1 - y) * width + x) * 4, ((height - 1 - y) * width + x) * 4 + 3),
      ];
      check(pixel);
      // The replayed per-draw view UBO is the shader's actual style input.
      const styles: Array<{
        workIndex: number;
        style: number[];
        dash: number[];
        fragmentEntry: string | null | undefined;
      }> = [];
      for (const falsify of [false, true]) {
        const replayTape = falsify
          ? decodeTape(
              encodeTape({
                ...tape,
                events: tape.events.map((event) =>
                  event.kind === 'drawIndexed' ? { ...event, indexCount: 0 } : event,
                ),
              }).unwrap(),
            ).unwrap()
          : tape;
        const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const device = (
          await adapter.requestDevice(
            replayDeviceRequest(replayTape, adapter.features, adapter.limits),
          )
        ).unwrap();
        const rawReplayDevice = webgpu._internal_getRawDevice(device);
        if (rawReplayDevice === undefined) throw new Error('replay WebGPU device unavailable');
        replayDevices.push(rawReplayDevice);
        const replay = (
          await openReplay(replayTape, { device, createShaderModule: webgpu.createShaderModule })
        ).unwrap();
        try {
          if (!falsify) {
            for (const selected of works) {
              const inspection = (
                await replay.inspectWork(selected.workIndex, ['pipeline', 'bindings'])
              ).unwrap();
              await options.save(
                `${name}-work-${selected.workIndex}.json`,
                new TextEncoder().encode(JSON.stringify(inspection, null, 2)),
              );
              const ubo = selected.bindings.find(
                (binding) => binding.groupIndex === 0 && binding.binding === 10,
              );
              if (!ubo?.resourceId) throw new Error('points-lines view UBO absent');
              const offset = (ubo.bufferOffset ?? 0) + (ubo.dynamicOffset ?? 0);
              const records = (
                await inspectBufferRecords(
                  replay,
                  ubo.resourceId,
                  selected.workIndex,
                  { stride: 16, fields: [{ name: 'v', offset: 0, type: 'f32', components: 4 }] },
                  { first: offset / 16 + 9, count: 2 },
                )
              ).unwrap();
              const [style, dash] = records.records.map((record) => record.fields.v as number[]);
              if (!style || !dash) throw new Error('points-lines style records absent');
              // Round caps compile into their own fragment entry; butt draws keep fs_main.
              const fragmentEntry = selected.pipeline.shaders.find(
                (shader) => shader.stage === 'fragment',
              )?.entryPoint;
              styles.push({ workIndex: selected.workIndex, style, dash, fragmentEntry });
            }
          }
          const pixels = (await replay.readResourceAtWork(colorId, work.workIndex)).unwrap();
          if (falsify) expect(pixels.bytes.some((value, i) => value !== live[i])).toBe(true);
          else expect(pixels.bytes).toEqual(live);
        } finally {
          (await replay.dispose()).unwrap();
        }
      }
      await options.save(
        `${name}.json`,
        new TextEncoder().encode(
          JSON.stringify(
            {
              digest: tapeDigest(encoded.bytes),
              workIndex: work.workIndex,
              eventIndex: work.eventIndex,
              unseededResources: model.unseededResources,
              width,
              height,
              frames,
              liveReplayEqual: true,
              missingDrawFalsifier: true,
              styles,
              errors,
            },
            null,
            2,
          ),
        ),
      );
      return styles;
    };
    const checkOrthographic =
      (phase: number, solid = false) =>
      (pixel: Pixel) => {
        expect(pixel(40, 160)).toEqual([255, 0, 0]);
        expect(pixel(82, 162)).toEqual([255, 0, 0]);
        expect(pixel(80, 135)).toEqual([255, 0, 0]);
        expect(pixel(100, 110)).toEqual([255, 0, 0]);
        expect(pixel(100, 113)).toEqual([255, 0, 0]);
        expect(pixel(100, 115)).toEqual([0, 0, 0]);
        expect(pixel(167, 143)).toEqual([0, 0, 255]);
        expect(pixel(263, 143)).toEqual([0, 0, 255]);
        expect(pixel(295, 165)).toEqual([255, 0, 255]);
        expect(pixel(290, 160)).toEqual([0, 0, 0]);
        expect(pixel(277, 113)).toEqual([255, 255, 255]);
        expect(pixel(280, 100)).toEqual([255, 255, 255]);
        expect(pixel(280, 85)).toEqual([0, 0, 0]);
        expect(pixel(144, 30)).toEqual([255, 255, 0]);
        expect(pixel(154, 30)).toEqual([0, 0, 0]);
        // Sample interior pixels, away from joins/caps; every segment shares arc length.
        for (const y of [67, 57, 47, 37]) {
          const distance = 27 + 80 - (y + 0.5) + phase;
          const on = solid || ((distance % 20) + 20) % 20 < 12;
          for (const x of [44, 47, 49])
            expect(pixel(x, y), `dash at x=${x}, y=${y}, phase=${phase}`).toEqual(
              on ? [0, 255, 0] : [0, 0, 0],
            );
        }
        if (phase === 0 && !solid)
          for (const sample of threePixels.samples)
            expect(pixel(sample.x, sample.y)).toEqual(sample.rgb);
        if (solid) expect(pixel(52, 50)).toEqual([0, 255, 0]);
      };
    const pixelStyles = (
      styles: Array<{ style: number[]; dash: number[]; fragmentEntry: string | null | undefined }>,
    ) => {
      for (const { style, dash, fragmentEntry } of styles) {
        expect(style[3]).toBe(0);
        expect(dash[3]).toBe(0);
        expect(fragmentEntry).toBe('fs_main');
      }
    };
    pixelStyles(await capture('solid-dashed', 6, checkOrthographic(0)));
    world.set(dashed, Lines, { dashOffset: -7 }).unwrap();
    await draw();
    pixelStyles(await capture('offset-negative', 6, checkOrthographic(-7)));
    height = 256;
    canvas.height = height;
    world.set(camera, Camera, { top: height }).unwrap();
    world.set(dashed, Lines, { width: 12, gapSize: 0 }).unwrap();
    for (let i = 0; i < 3; i++) await draw();
    pixelStyles(await capture('solid-resized', 6, checkOrthographic(-7, true)));
    for (const entity of entities.splice(0)) world.despawn(entity).unwrap();
    world.set(camera, Camera, { projection: 0, fov: Math.PI / 4, aspect: width / height }).unwrap();
    const focal = height / (2 * Math.tan(Math.PI / 8));
    spawn([-1, 0, 1, 1, 0, -1], 'line-strip', [0, 1, 0, 1], {
      width: 8,
      dashSize: 0.25,
      gapSize: 0.25,
    });
    await draw();
    await capture('perspective', 1, (pixel) => {
      // Project a local segment whose endpoints have camera distances 2 and 4.
      // The inverse is analytical and independent of the shader's interpolation.
      for (let x = 30; x < 230; x += 3) {
        const rayX = (x + 0.5 - width / 2) / focal;
        const localT = (1 + 2 * rayX) / (2 - 2 * rayX);
        const distance = Math.sqrt(8) * localT;
        const phase = ((distance % 0.5) + 0.5) % 0.5;
        if (Math.min(phase, Math.abs(phase - 0.25), 0.5 - phase) < 0.015) continue;
        for (const y of [125, 128, 130])
          expect(pixel(x, y), `perspective dash at ${x},${y}`).toEqual(
            phase < 0.25 ? [0, 255, 0] : [0, 0, 0],
          );
        expect(pixel(x, 133)).toEqual([0, 0, 0]);
      }
    });
    for (const entity of entities.splice(0)) world.despawn(entity).unwrap();
    // World-unit widths shrink with camera distance (clip w); round caps and
    // joins are the union of per-segment capsules. Every pixel is compared to
    // that analytic coverage except a 1px band around each edge.
    const project = (x: number, y: number, z: number) => [
      width / 2 + (x * focal) / (3 - z),
      height / 2 + (y * focal) / (3 - z),
    ];
    const unproject = (x: number, y: number) => [
      ((x - width / 2) * 3) / focal,
      ((y - height / 2) * 3) / focal,
      0,
    ];
    const worldUnits = LineWidthUnitsValue.world;
    const round = LineCapValue.round;
    const capsule = spawn([-0.6, 0.35, 0, 0.6, 0.35, 0], 'line-strip', [1, 0, 0, 1], {
      width: 0.12,
      widthUnits: worldUnits,
      cap: round,
    });
    const far = spawn([-1.2, -0.2, -3, 1.2, -0.2, -3], 'line-list', [0, 1, 0, 1], {
      width: 0.14,
      widthUnits: worldUnits,
    });
    spawn([-0.6, -0.4, 1, 1.2, -0.8, -1], 'line-strip', [1, 1, 1, 1], {
      width: 0.1,
      widthUnits: worldUnits,
    });
    const joinPixels = [
      [40, 190],
      [120, 190],
      [120, 240],
      [200, 205],
    ] as const;
    const joinWidth = (18 * 3) / focal;
    const translucent = spawn(
      joinPixels.flatMap(([x, y]) => unproject(x, y)),
      'line-strip',
      [0, 0, 1, 0.5],
      { width: joinWidth, widthUnits: worldUnits, cap: round },
      undefined,
      Materials.unlit([0, 0, 1, 0.5], {
        renderState: {
          depthWriteEnabled: false,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        },
      }),
    );
    const segmentDistance = (
      px: number,
      py: number,
      [ax, ay]: readonly number[],
      [bx, by]: readonly number[],
    ) => {
      const dx = (bx ?? 0) - (ax ?? 0);
      const dy = (by ?? 0) - (ay ?? 0);
      const t = Math.min(
        1,
        Math.max(0, ((px - (ax ?? 0)) * dx + (py - (ay ?? 0)) * dy) / (dx * dx + dy * dy)),
      );
      return Math.hypot(px - (ax ?? 0) - t * dx, py - (ay ?? 0) - t * dy);
    };
    interface Shape {
      readonly name: string;
      readonly rgb: readonly number[];
      readonly sdf: (x: number, y: number) => number;
    }
    const capsuleShape = (): Shape => {
      const a = project(-0.6, 0.35, 0);
      const b = project(0.6, 0.35, 0);
      const radius = (0.06 * focal) / 3;
      return {
        name: 'round',
        rgb: [255, 0, 0],
        sdf: (x, y) => segmentDistance(x, y, a, b) - radius,
      };
    };
    const buttShape = (
      name: string,
      rgb: readonly number[],
      start: readonly [number, number, number],
      end: readonly [number, number, number],
      halfWidth: number,
    ): Shape => {
      const [x0 = 0, y0 = 0] = project(...start);
      const [x1 = 0] = project(...end);
      const r0 = (halfWidth * focal) / (3 - start[2]);
      const r1 = (halfWidth * focal) / (3 - end[2]);
      return {
        name,
        rgb,
        sdf: (x, y) => {
          const t = (x - x0) / (x1 - x0);
          return Math.max(Math.abs(y - y0) - (r0 + (r1 - r0) * t), x0 - x, x - x1);
        },
      };
    };
    const joinShape: Shape = {
      name: 'translucent-round-join',
      rgb: [0, 0, 128],
      sdf: (x, y) =>
        Math.min(
          ...joinPixels.slice(1).map((end, i) => segmentDistance(x, y, joinPixels[i] ?? end, end)),
        ) - 9,
    };
    const worldShapes = [
      capsuleShape(),
      buttShape('far-butt', [0, 255, 0], [-1.2, -0.2, -3], [1.2, -0.2, -3], 0.07),
      buttShape('tapered-butt', [255, 255, 255], [-0.6, -0.4, 1], [1.2, -0.8, -1], 0.05),
      joinShape,
    ];
    const compareWorld = (pixel: Pixel) => {
      const report = Object.fromEntries(
        [...worldShapes.map((shape) => shape.name), 'background'].map((name) => [
          name,
          { checked: 0, mismatched: 0 },
        ]),
      );
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const distances = worldShapes.map((shape) => shape.sdf(x + 0.5, y + 0.5));
          if (distances.some((distance) => Math.abs(distance) < 1)) continue;
          const inside = worldShapes.findIndex((_, i) => (distances[i] ?? 1) < 0);
          const shape = worldShapes[inside];
          const entry = report[shape?.name ?? 'background'];
          if (!entry) continue;
          entry.checked++;
          const actual = pixel(x, y);
          const expected = shape?.rgb ?? [0, 0, 0];
          if (actual.some((value, i) => Math.abs(value - (expected[i] ?? 0)) > 1))
            entry.mismatched++;
        }
      return report;
    };
    const worldReports: Record<string, unknown> = {};
    await draw();
    const worldStyles = await capture('world-round', 4, (pixel) => {
      const report = compareWorld(pixel);
      worldReports.world = report;
      for (const [name, entry] of Object.entries(report)) {
        expect(entry.checked, `${name} checked`).toBeGreaterThan(40);
        expect(entry, name).toEqual({ checked: entry.checked, mismatched: 0 });
      }
    });
    // Every world draw carries the projection focal factor; only round draws flag caps
    // and select the fs_round entry.
    const byWidth = new Map(worldStyles.map((entry) => [entry.style[0]?.toFixed(3), entry]));
    for (const [styleWidth, cap] of [
      [0.12, 1],
      [0.14, 0],
      [0.1, 0],
      [joinWidth, 1],
    ] as const) {
      const entry = byWidth.get(Math.fround(styleWidth).toFixed(3));
      expect(entry?.style[3]).toBeCloseTo(focal, 2);
      expect(entry?.dash[3]).toBe(cap);
      expect(entry?.fragmentEntry).toBe(cap === 1 ? 'fs_round' : 'fs_main');
    }
    // Falsifiers: butt caps and pixel widths must break the analytic match.
    world.set(capsule, Lines, { cap: LineCapValue.butt }).unwrap();
    world.set(translucent, Lines, { cap: LineCapValue.butt }).unwrap();
    world.set(far, Lines, { widthUnits: LineWidthUnitsValue.pixels }).unwrap();
    await draw();
    await capture('world-round-falsified', 4, (pixel) => {
      const report = compareWorld(pixel);
      worldReports.falsified = report;
      for (const name of ['round', 'far-butt', 'translucent-round-join'])
        expect(report[name]?.mismatched, `${name} falsifier`).toBeGreaterThan(0);
    });
    await options.save(
      'world-round-report.json',
      new TextEncoder().encode(JSON.stringify({ focal, ...worldReports }, null, 2)),
    );
    expect(errors).toEqual([]);
  } catch (error) {
    await options.save(
      'failure.json',
      new TextEncoder().encode(
        JSON.stringify(
          { error, errors },
          (_key, value) => (value instanceof Error ? { ...value, message: value.message } : value),
          2,
        ),
      ),
    );
    throw error;
  } finally {
    try {
      for (const copy of copies) copy.device.destroyBuffer(copy.buffer).unwrap();
      renderValue(await renderer.dispose());
    } finally {
      surface?.destroy();
      try {
        (await recorder.dispose()).unwrap();
      } finally {
        for (const device of replayDevices) device.destroy();
        rawDevice?.destroy();
      }
    }
  }
}
