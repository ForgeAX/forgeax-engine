import { encodePng } from '@forgeax/engine-image/png';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  Camera,
  type Renderer,
  type RenderFeature,
} from '@forgeax/engine-render';
import { createFullscreenRenderFeature } from '@forgeax/engine-render/authoring';
import { buildFrameModel, decodeTape, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { ok } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { compactTape } from './compact-tape.fixture';
import {
  createDisplayP3Scene,
  DISPLAY_P3_SIZE,
  maxError,
  pixelAt,
  QUADRANTS,
  type Save,
} from './display-p3.fixture';

export function postEffectFixture() {
  const state = { enabled: false };
  const features = [
    'vec3f(color.b, color.r, color.g)',
    'vec3f(color.r, 0.5 * color.g, 1.0 - color.b)',
    'vec3f(color.g, color.b, color.r)',
  ].map((rgb, index) =>
    createFullscreenRenderFeature({
      identity: `test.encoded-chain.${index}`,
      enabled: () => state.enabled,
      reads: ['input'],
      source: /* wgsl */ `
@group(1) @binding(0) var scene: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) id: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((id << 1u) & 2u), f32(id & 2u));
  return vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let color = textureLoad(scene, vec2i(position.xy), 0);
  return vec4f(${rgb}, color.a);
}`,
    }),
  );
  return { features, state };
}

export async function verifyEncodedPostEffects(
  renderer: Renderer,
  recorder: RecorderAttachment,
  state: ReturnType<typeof postEffectFixture>['state'],
  save: Save,
) {
  const errors: unknown[] = [];
  const scene = createDisplayP3Scene(renderer, errors);
  const camera = [...scene.world.query({ with: [Camera] }).unwrap()][0]?.entity;
  if (camera === undefined) throw new Error('missing camera');
  const report = [];
  try {
    renderer.setOutputColorSpace('srgb').unwrap();
    for (const [suffix, antialias] of [
      ['grade', ANTIALIAS_NONE],
      ['fxaa', ANTIALIAS_FXAA],
    ] as const) {
      scene.world.set(camera, Camera, { antialias }).unwrap();
      state.enabled = false;
      const bypass = await scene.readFinal();
      expect(
        renderer.inspect().perFramePassNames.some((name) => name.startsWith('post-effect-')),
      ).toBe(false);
      state.enabled = true;
      for (let frame = 0; frame < 29; frame++) await scene.drawReady();
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const output = await scene.readFinal();
      (await recorder.frameBoundary()).unwrap();
      const capture = (await pending).unwrap();
      const tape = decodeTape(capture.bytes).unwrap();
      const model = buildFrameModel(tape);
      const names = renderer.inspect().perFramePassNames;
      const labelOf = (pass: (typeof model.passes)[number]) => {
        const begin = tape.events[pass.beginEventIndex];
        return begin?.kind === 'beginRenderPass' ? begin.desc.label : undefined;
      };
      const workFor = (name: string) => {
        const pass = model.passes.find((item) => labelOf(item) === name);
        if (pass === undefined) throw new Error(`missing pass ${name}`);
        const work = model.works.find((item) => item.passIndex === pass.passIndex);
        if (work === undefined) throw new Error(`missing draw ${name}`);
        return work;
      };
      const producer = names.includes('standard-final')
        ? 'standard-final'
        : names.includes('standard-grade')
          ? 'standard-grade'
          : names.includes('fxaa')
            ? 'fxaa'
            : 'output-transform';
      const chain = [producer, 'post-effect-0', 'post-effect-1', 'post-effect-2'];
      const format = renderer.inspect().output.surfaceStorage;
      const bindings = chain.map((name) => {
        const work = workFor(name);
        expect(work.pipeline.descriptor, name).toMatchObject({
          desc: { fragment: { targets: [{ format }] } },
        });
        return {
          name,
          input: work.bindings.find(({ groupIndex, binding }) => groupIndex === 1 && binding === 0)
            ?.resourceId,
          output: work.attachments?.colorViewHandleIds[0],
        };
      });
      const steps = QUADRANTS.map(({ name, pixel }) => {
        const [r, g, b] = pixelAt(bypass.rgba, pixel);
        const expected = [Math.round(r * 0.5), 255 - g, b] as const;
        const actual = pixelAt(output.rgba, pixel);
        return { name, actual, expected, error: maxError(actual, expected) };
      });
      for (const step of steps) expect(step.error, `${suffix}:${step.name}`).toBeLessThanOrEqual(1);
      for (let i = 3; i < output.rgba.length; i += 4) expect(output.rgba[i]).toBe(bypass.rgba[i]);
      const snapshot = {
        mode: suffix,
        format,
        passes: names,
        bindings,
        steps,
        digest: capture.digest,
      };
      report.push(snapshot);
      await save(`${suffix}.rhitape`, compactTape(capture).bytes);
      await save(`${suffix}.rgba`, output.rgba);
      await save(`${suffix}.png`, encodePng(DISPLAY_P3_SIZE, DISPLAY_P3_SIZE, output.rgba));
      await save(`${suffix}.json`, new TextEncoder().encode(JSON.stringify(snapshot, null, 2)));
    }
    expect(errors).toEqual([]);
    expect(
      report.every(({ passes }) => !passes.some((name) => name.startsWith('post-effect-copy-'))),
    ).toBe(true);
    for (const { bindings } of report) {
      for (let index = 1; index < bindings.length; index++) {
        expect(bindings[index]?.input).toBeDefined();
        expect(bindings[index]?.input).toBe(bindings[index - 1]?.output);
        expect(bindings[index]?.input).not.toBe(bindings[index]?.output);
      }
    }
  } finally {
    scene.dispose();
  }
}

const OVERLAY = 'test.after-tonemap-overlay';
const CURRENT = 'test.after-tonemap-current';

export function afterTonemapFixture() {
  const state = { overlay: false, current: false };
  const feature = (identity: string, enabled: () => boolean): RenderFeature<boolean> => {
    const direct = identity === OVERLAY;
    const targetName = direct ? 'swapchain' : 'color';
    const source = /* wgsl */ `
@group(1) @binding(0) var neutral: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) id: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((id << 1u) & 2u), f32(id & 2u));
  return vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let white = textureLoad(neutral, vec2i(0), 0);
  if (white.a < 0.5 || position.y < 8.0 || position.y >= 24.0 || position.x < 24.0 || position.x >= 40.0) {
    discard;
  }
  return ${direct ? 'vec4f(0.0, 1.0, 0.0, 0.5)' : 'vec4f(1.0, 0.0, 0.0, 1.0)'};
}`;
    return {
      identity,
      placement: 'after-tonemap',
      requiredFullscreenPostProcesses: [{ identity, source, reads: ['input'] }],
      extract: () => ok(enabled()),
      plan: (active, context) =>
        ok({
          work: active
            ? context.views.map((view) => {
                const output = view.targets.find(({ name }) => name === targetName);
                if (output === undefined) throw new Error(`Missing ${targetName} attachment`);
                return {
                  scope: { view: view.identity },
                  resources: [
                    {
                      kind: 'fullscreen-program',
                      name: identity,
                      source,
                      reads: ['input'],
                    },
                    {
                      kind: 'graphics-program',
                      name: 'overlay',
                      program: {
                        shader: identity,
                        preparePipelines: true,
                        vertexLayout: 'none',
                        colorFormats: [output.format],
                        sampleCount: 1,
                      },
                    },
                    {
                      kind: 'graphics-bindings',
                      name: 'neutral',
                      program: 'overlay',
                      values: { group: 1, fullscreen: true, shader: identity, input: false },
                    },
                  ],
                  passes: [
                    {
                      kind: 'raster',
                      name: direct ? 'display-overlay' : 'current-color-overlay',
                      colorAttachments: [{ target: targetName, loadOp: 'load', storeOp: 'store' }],
                      draws: [
                        {
                          program: 'overlay',
                          bindings: ['neutral'],
                          vertexData: [],
                          vertexLayout: 'none',
                          draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
                        },
                      ],
                    },
                  ],
                };
              })
            : [],
        }),
    };
  };
  // Register the endpoint overlay first. It still loads the terminal color
  // after any float current-color writers have completed.
  return {
    state,
    features: [feature(OVERLAY, () => state.overlay), feature(CURRENT, () => state.current)],
  };
}

export async function verifyAfterTonemapOutput(
  renderer: Renderer,
  recorder: RecorderAttachment,
  state: ReturnType<typeof afterTonemapFixture>['state'],
  save: Save,
  rawOnly = false,
) {
  const errors: unknown[] = [];
  const scene = createDisplayP3Scene(renderer, errors);
  try {
    const bypass = (await scene.readFinal()).rgba;
    state.overlay = true;
    for (const mode of ['direct', 'observed', 'mixed'] as const) {
      const observe = mode !== 'direct';
      state.current = mode === 'mixed';
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      if (!observe) await scene.drawReady();
      const pixelRead = observe ? await scene.readFinal() : undefined;
      (await recorder.frameBoundary()).unwrap();
      const capture = (await pending).unwrap();
      const tape = decodeTape(capture.bytes).unwrap();
      const model = buildFrameModel(tape);
      const names = renderer.inspect().perFramePassNames;
      const labelOf = (pass: (typeof model.passes)[number]) => {
        const begin = tape.events[pass.beginEventIndex];
        return begin?.kind === 'beginRenderPass' ? begin.desc.label : undefined;
      };
      const producer = names.includes('post-effect-2')
        ? 'post-effect-2'
        : names.includes('standard-grade')
          ? 'standard-grade'
          : 'output-transform';
      const work = (passName: string) => {
        const pass = model.passes.find((row) => labelOf(row)?.split(' + ').includes(passName));
        const row = model.works.find((item) => item.passIndex === pass?.passIndex);
        if (row === undefined) throw new Error(`Missing ${passName}: ${names.join(', ')}`);
        return row;
      };
      const attachment = (pass: string) => work(pass).attachments?.colorViewHandleIds[0];
      expect(names.includes('standard-current-output-present')).toBe(state.current);
      expect(names.includes('standard-observed-present')).toBe(rawOnly && observe);
      const overlay = attachment('display-overlay');
      expect(overlay).toBeDefined();
      if (state.current) {
        expect(attachment(producer)).toBe(attachment('current-color-overlay'));
        expect(attachment(producer)).not.toBe(overlay);
        expect(attachment('standard-current-output-present')).toBe(overlay);
      } else {
        expect(attachment(producer)).toBe(overlay);
      }
      if (rawOnly && observe) expect(attachment('standard-observed-present')).not.toBe(overlay);
      if (pixelRead !== undefined) {
        expect(pixelAt(pixelRead.rgba, [32, 16])).toEqual([0, 255, 0]);
        expect(pixelRead.rgba[(16 * DISPLAY_P3_SIZE + 32) * 4 + 3]).toBe(128);
        for (const { pixel } of QUADRANTS) {
          expect(
            maxError(pixelAt(pixelRead.rgba, pixel), pixelAt(bypass, pixel)),
          ).toBeLessThanOrEqual(1);
        }
        await save(
          `after-tonemap-${mode}.png`,
          encodePng(DISPLAY_P3_SIZE, DISPLAY_P3_SIZE, pixelRead.rgba),
        );
      }
      await save(`after-tonemap-${mode}.rhitape`, compactTape(capture).bytes);
      await save(
        `after-tonemap-${mode}.json`,
        new TextEncoder().encode(
          JSON.stringify({ mode, names, digest: capture.digest, producer, overlay }, null, 2),
        ),
      );
    }
    expect(errors).toEqual([]);
  } finally {
    scene.dispose();
  }
}
