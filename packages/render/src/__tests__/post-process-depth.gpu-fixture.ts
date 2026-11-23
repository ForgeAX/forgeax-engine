import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createPlaneGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { buildFrameModel, decodeTape, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler/program';
import { ok } from '@forgeax/engine-types';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { ANTIALIAS_TAA, Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import type { RenderFeature } from '../features/types';
import { Materials } from '../materials';
import { computeProjectionMatrix } from '../record/helpers';
import type { CameraSnapshot } from '../render-contract';

const SIZE = 64;
const SHADER = 'test.post-process-depth';
const SOURCE = /* wgsl */ `
@group(1) @binding(3) var depth: texture_depth_2d;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let sample = textureLoad(depth, vec2i(position.xy), 0);
  return vec4f(sample, select(0.0, 1.0, sample > 0.0), 0.0, 1.0);
}`;

const feature: RenderFeature<undefined> = {
  identity: SHADER,
  placement: 'after-tonemap',
  requiredFullscreenPostProcesses: [{ identity: SHADER, source: SOURCE }],
  extract: () => ok(undefined),
  plan: (_data, context) =>
    ok({
      work: context.views.map((view) => ({
        scope: { view: view.identity },
        resources: [
          {
            kind: 'fullscreen-program',
            name: SHADER,
            source: SOURCE,
            reads: ['input', { key: 'depth', sampleType: 'depth' }],
          },
          {
            kind: 'graphics-program',
            name: 'depth',
            program: {
              shader: SHADER,
              preparePipelines: true,
              vertexLayout: 'none',
              colorFormats: ['rgba16float'],
              sampleCount: 1,
            },
          },
          {
            kind: 'graphics-bindings',
            name: 'depth-input',
            program: 'depth',
            values: { group: 1, fullscreen: true, shader: SHADER, depth: 'depth' },
            logicalTargets: { depth: 'depth' },
          },
        ],
        passes: [
          {
            kind: 'raster',
            name: 'depth-silhouette',
            sceneDepth: 'before-pass',
            colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
            sampledTargets: ['depth'],
            draws: [
              {
                program: 'depth',
                bindings: ['depth-input'],
                vertexData: [],
                vertexLayout: 'none',
                draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
              },
            ],
          },
        ],
      })),
    }),
};

/** The front box face has an independently projected rectangular silhouette. */
function expectedCoverage(projection: 'perspective' | 'orthographic'): Uint8Array {
  const matrix = computeProjectionMatrix(
    {
      projection,
      fov: 1,
      aspect: 1,
      near: 0.1,
      far: 100,
      orthoLeft: -2,
      orthoRight: 2,
      orthoBottom: -2,
      orthoTop: 2,
    } as CameraSnapshot,
    mat4.create(),
  );
  const w = (matrix[11] ?? 0) * -4.9 + (matrix[15] ?? 0);
  const px = (x: number) => ((((matrix[0] ?? 0) * (x - 0.11)) / w + 1) * SIZE) / 2;
  const py = (y: number) => ((1 - ((matrix[5] ?? 0) * (y - 0.03)) / w) * SIZE) / 2;
  const left = px(-0.65),
    right = px(0.65),
    top = py(0.65),
    bottom = py(-0.65);
  return Uint8Array.from({ length: SIZE * SIZE }, (_, index) => {
    const x = (index % SIZE) + 0.5,
      y = Math.floor(index / SIZE) + 0.5;
    return Number(x > left && x < right && y > top && y < bottom);
  });
}

interface DepthScenario {
  readonly projection: 'perspective' | 'orthographic';
  readonly lane?: 'direct' | 'scene-index';
}

async function verifyCoverageTape(
  recorder: RecorderAttachment,
  capture: ReturnType<RecorderAttachment['captureFrame']>,
  scenario: DepthScenario,
  inspectIndirectDraws: () => number | undefined,
) {
  (await recorder.frameBoundary()).unwrap();
  const tape = decodeTape((await capture).unwrap().bytes).unwrap();
  const model = buildFrameModel(tape);
  const coverage = model.passes.find((pass) => {
    const begin = tape.events[pass.beginEventIndex];
    return (
      begin?.kind === 'beginRenderPass' && begin.desc.label === 'standard-post-process-coverage'
    );
  });
  const gpu = 'lane' in scenario && scenario.lane === 'scene-index';
  const work = model.works.find(
    (work) =>
      work.passIndex === coverage?.passIndex &&
      work.kind.endsWith('Indirect') === gpu &&
      work.pipeline.shaders.some(({ entryPoint }) => entryPoint === 'fs_coverage'),
  );
  if (work === undefined)
    throw new Error(
      JSON.stringify({
        scenario,
        coverage,
        draws: model.works
          .filter((work) => work.passIndex === coverage?.passIndex)
          .map((work) => ({
            kind: work.kind,
            entries: work.pipeline.shaders.map((shader) => shader.entryPoint),
          })),
        submission: inspectIndirectDraws(),
      }),
    );
}

async function verifyCoveragePixels(
  native: GPUDevice | undefined,
  target: GPUTexture | undefined,
  scenario: DepthScenario,
  expected: Uint8Array,
  frames: number,
  failures: readonly unknown[],
) {
  if (native === undefined || target === undefined) throw new Error('Missing GPU surface');
  const buffer = native.createBuffer({
    size: SIZE * 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = native.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [SIZE, SIZE]);
    native.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(buffer.getMappedRange());
    for (const [index, coverage] of expected.entries()) {
      if (pixels[index * 4 + 1] !== coverage * 255)
        throw new Error(
          `${JSON.stringify(scenario)} frame ${frames}: depth silhouette differs at ${index % SIZE},${Math.floor(index / SIZE)}; expected=${coverage * 255}, actual=${pixels[index * 4 + 1]}; ${JSON.stringify({ channelMax: [0, 1, 2, 3].map((channel) => Math.max(...pixels.filter((_value, pixel) => pixel % 4 === channel))), failures })}`,
        );
    }
    buffer.unmap();
  } finally {
    buffer.destroy();
  }
}

/** Exercise real Standard geometry and after-tonemap depth through 60 jittered frames. */
export async function verifyPostProcessDepth(
  url = '/shaders/manifest.json',
  witness?: { recorder: RecorderAttachment; renderPath: 'forward' | 'deferred' },
) {
  const recorder = witness?.recorder;
  let native: GPUDevice | undefined, target: GPUTexture | undefined;
  const failures: unknown[] = [];
  const context = {
    configure(descriptor: GPUCanvasConfiguration) {
      native = descriptor.device;
      native.addEventListener('uncapturederror', (event) => failures.push(event.error.message));
      target?.destroy();
      target = native.createTexture({
        size: [SIZE, SIZE],
        format: descriptor.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: descriptor.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      if (target === undefined) throw new Error('Missing GPU surface');
      return target;
    },
    unconfigure() {},
  };
  const host = await createRenderer(
    {
      width: SIZE,
      height: SIZE,
      getContext: (kind: string) => (kind === 'webgpu' ? context : null),
    },
    { features: [feature] },
    { shaderManifestUrl: url, prepareShaderProgramCompiler },
    recorder?.backend ?? webgpu,
  );
  host.onError((error) => failures.push(error));
  const initialized = await host.initialization;
  if (!initialized.ok) {
    await host.dispose();
    throw initialized.error;
  }
  const renderer = exposeRenderer(host);
  const observations: { projection: string; frames: number }[] = [];
  try {
    if (witness !== undefined) {
      const configured = renderer.setProfile({
        ...renderer.inspect().profile,
        renderPath: witness.renderPath,
      });
      if (!configured.ok) throw configured.error;
    }
    const assets = host.assetRegistry,
      world = new World({ assets });
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const lease = attachment.value;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0.11, 0.03, 5] } },
        {
          component: Camera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_TAA,
            left: -2,
            right: 2,
            bottom: -2,
            top: 2,
          },
        },
      )
      .unwrap();
    const angle = 0.8;
    const displacement = 0.8;
    const geometry =
      recorder === undefined
        ? createBoxGeometry(1.3, 1.3, 0.2).unwrap()
        : createPlaneGeometry(2, 2, 8, 8).unwrap();
    const mesh = assets.create(geometry).unwrap();
    let meshWithLod = mesh;
    if (recorder !== undefined) {
      // The production indirect temporal/coverage lane owns multi-LOD rigid meshes.
      const lower = assets.create(createPlaneGeometry(2, 2).unwrap()).unwrap();
      meshWithLod = assets
        .create({
          ...geometry,
          lods: [{ mesh: lower, screenCoverage: 0.02 }],
        })
        .unwrap();
    }
    const height =
      recorder === undefined
        ? undefined
        : assets
            .create({
              kind: 'texture',
              shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
              format: 'rgba8unorm',
              colorSpace: 'linear',
              mips: { kind: 'none' },
              data: new Uint8Array([255, 255, 255, 255]),
            })
            .unwrap();
    const alpha =
      height === undefined
        ? undefined
        : assets
            .create({
              kind: 'texture',
              shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
              format: 'rgba8unorm',
              colorSpace: 'linear',
              mips: { kind: 'none' },
              data: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]),
            })
            .unwrap();
    const material = assets
      .create(
        height === undefined
          ? Materials.unlit([1, 0, 0, 1])
          : Materials.standard({
              baseColor: [1, 1, 1, 1],
              ...(alpha === undefined
                ? {}
                : {
                    alphaTexture: { texture: alpha },
                    alphaCutoff: 0.5,
                  }),
              displacementTexture: { texture: height },
              displacementScale: displacement,
            }),
      )
      .unwrap();
    if (recorder !== undefined)
      world
        .spawn({
          component: DirectionalLight,
          data: { direction: [0, 0, -1], intensity: 1 },
        })
        .unwrap();
    const object = world
      .spawn(
        {
          component: Transform,
          data:
            height === undefined
              ? {}
              : {
                  quat: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
                },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const scenarios =
      recorder === undefined
        ? ([
            { projection: 'perspective', code: 0 },
            { projection: 'orthographic', code: 1 },
          ] as const)
        : ([
            { projection: 'orthographic', code: 1, lane: 'direct' },
            { projection: 'orthographic', code: 1, lane: 'scene-index' },
          ] as const);
    const verifyScenarios = async () => {
      for (const scenario of scenarios) {
        const { projection, code } = scenario;
        if ('lane' in scenario && scenario.lane === 'scene-index')
          world.set(object, MeshFilter, { assetHandle: meshWithLod }).unwrap();
        world.set(camera, Camera, { projection: code }).unwrap();
        const expected =
          'lane' in scenario
            ? Uint8Array.from({ length: SIZE * SIZE }, (_, index) => {
                // Independent orthographic projection of the rotated, displaced plane.
                const x = (((index % SIZE) + 0.5) / SIZE - 0.5) * 4 + 0.11;
                const y = (0.5 - (Math.floor(index / SIZE) + 0.5) / SIZE) * 4 + 0.03;
                const localX = (x - displacement * Math.sin(angle)) / Math.cos(angle);
                return Number(localX > -1 && localX < 0 && Math.abs(y) < 1);
              })
            : expectedCoverage(projection);
        let frames = 0;
        let pending: unknown;
        const deadline = performance.now() + 45_000;
        while (frames < 60 && performance.now() < deadline) {
          world.update(1 / 60).unwrap();
          const capture =
            recorder !== undefined && frames === 59 ? recorder.captureFrame() : undefined;
          if (capture !== undefined) (await recorder?.frameBoundary())?.unwrap();
          const drawn = renderer.draw({
            source: lease,
            camera: { entityKey: camera },
            ...('lane' in scenario && scenario.lane === 'direct' ? { geometryLane: 'direct' } : {}),
          });
          if (!drawn.ok) throw new Error(JSON.stringify({ scenario, draw: drawn.error, failures }));
          const receipt = drawn.value;
          const completed = await receipt.completed;
          if (!completed.ok) throw completed.error;
          if (capture !== undefined && recorder !== undefined) {
            await verifyCoverageTape(
              recorder,
              capture,
              scenario,
              () => renderer.inspect().renderScene.gpuDriven?.indirectDrawCount,
            );
          }
          if (receipt.presentation !== 'ready') {
            pending = receipt.presentationPendingReason;
            await new Promise((resolve) => setTimeout(resolve, 16));
            continue;
          }
          await verifyCoveragePixels(native, target, scenario, expected, frames, failures);
          frames++;
        }
        if (frames !== 60)
          throw new Error(JSON.stringify({ projection, frames, pending, failures }));
        if (failures.length) throw new Error(JSON.stringify(failures));
        observations.push({ projection, frames });
      }
    };
    await verifyScenarios();
    return observations;
  } finally {
    await renderer.dispose().then((result) => {
      if (!result.ok) throw result.error;
    });
    target?.destroy();
  }
}
