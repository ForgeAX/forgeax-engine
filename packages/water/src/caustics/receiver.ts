import {
  type RenderFeature,
  type RenderFeatureTextureReference,
  type RenderFeatureWork,
  SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
} from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { WATER_CAUSTICS_REACTIVITY_OUTPUT } from './field.js';

import { type WaterCausticsReceiverSettings, waterCausticsReceiverValues } from './settings.js';

const RECEIVER_DEFAULTS = new Uint8Array(80);

export interface WaterCausticsReceiverOptions {
  readonly producerIdentity: string;
  readonly field: string;
  /** Composed shader bytes supplied by the ordinary material/shader build pipeline. */
  readonly shaders: { readonly composite: string; readonly copy: string };
  readonly identity?: string;
}

/** Deferred opaque receivers, before water/transparent media, with optional TAA reactivity. */
export function createWaterCausticsReceiverFeature(options: WaterCausticsReceiverOptions) {
  const identity = options.identity ?? `${options.producerIdentity}-receivers`;
  let parameters: (() => WaterCausticsReceiverSettings | undefined) | undefined;
  let submitted: readonly number[] | undefined;
  const feature: RenderFeature<readonly number[] | undefined> = {
    identity,
    placement: 'before-medium',
    extract() {
      const settings = parameters?.();
      if (settings === undefined) return ok(undefined);
      const values = waterCausticsReceiverValues(settings);
      const changed =
        submitted === undefined ||
        values.some((value, index) => index !== 13 && value !== submitted?.[index]);
      return ok([
        ...values,
        submitted?.[13] ?? values[13] ?? 0,
        Number(submitted === undefined || values[13] !== submitted[13]),
        Number(changed),
        0,
      ]);
    },
    plan(frame, context) {
      if (frame === undefined) return ok({ work: [] });
      const work: RenderFeatureWork[] = [];
      for (const view of context.views) {
        if (!view.render) continue;
        const color = view.targets.find((target) => target.kind === 'color');
        if (color === undefined || color.sampleCount !== 1) continue;
        const temporal = view.targets.find((target) => target.name === 'temporal-reactivity');
        const normal = view.sceneData.require(SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA);
        const depth = view.sceneData.require(SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA);
        const field: RenderFeatureTextureReference = {
          kind: 'feature-texture',
          featureIdentity: options.producerIdentity,
          name: options.field,
          viewIdentity: view.identity,
          format: 'rgba16float',
          sampleCount: 1,
        };
        const data = new Uint8Array(new Float32Array(frame).buffer);
        const source = `${options.producerIdentity}-composite`;
        const copy = `${options.producerIdentity}-copy`;
        work.push({
          scope: { view: view.identity },
          placement: 'before-medium',
          resources: [
            {
              kind: 'graph-texture',
              name: 'caustics-lit-opaque',
              allocationKey: 'caustics-lit-opaque',
              descriptor: {
                format: color.format,
                sampleCount: 1,
                size: {
                  width: view.frame.width ?? 1,
                  height: view.frame.height ?? 1,
                  depthOrArrayLayers: 1,
                },
              },
            },
            {
              kind: 'fullscreen-program',
              name: source,
              source: options.shaders.composite,
              fragmentEntryPoint: temporal === undefined ? 'fs_main' : 'fs_temporal',
              usesView: true,
              reads: [
                'input',
                { key: 'depth', sampleType: 'depth' },
                { key: 'normal', sampleType: 'uint' },
                'field',
              ],
              params: { byteSize: 80, defaultValue: RECEIVER_DEFAULTS },
              frameParams: data,
            },
            {
              kind: 'fullscreen-program',
              name: copy,
              source: options.shaders.copy,
              reads: ['input'],
            },
            ...[source, copy].map((name) => ({
              kind: 'graphics-program' as const,
              name: `${name}.pipeline`,
              program: {
                shader: name,
                vertexLayout: 'none',
                colorFormats:
                  name === source && temporal !== undefined
                    ? [color.format, temporal.format]
                    : [color.format],
                sampleCount: 1 as const,
                ...(name === source && temporal !== undefined
                  ? {
                      renderState: {
                        outputs: [
                          { name: 'color', format: color.format },
                          WATER_CAUSTICS_REACTIVITY_OUTPUT,
                        ],
                      },
                    }
                  : {}),
              },
            })),
            {
              kind: 'graphics-bindings',
              name: 'receiver.view',
              program: `${source}.pipeline`,
              values: { group: 0, view: true },
            },
            {
              kind: 'graphics-bindings',
              name: 'receiver.inputs',
              program: `${source}.pipeline`,
              logicalTargets: { input: color.name },
              values: {
                group: 1,
                fullscreen: true,
                shader: source,
                input: color.name,
                depth,
                additionalTextures: [normal, field],
              },
            },
            {
              kind: 'graphics-bindings',
              name: 'copy.empty',
              program: `${copy}.pipeline`,
              logicalTargets: { input: 'caustics-lit-opaque' },
              values: { group: 0, fullscreen: true, shader: copy },
            },
            {
              kind: 'graphics-bindings',
              name: 'copy.inputs',
              program: `${copy}.pipeline`,
              logicalTargets: { input: 'caustics-lit-opaque' },
              values: { group: 1, fullscreen: true, shader: copy },
            },
          ],
          passes: [
            {
              kind: 'raster',
              name: `${options.producerIdentity}-receive`,
              colorAttachments: [
                { target: 'caustics-lit-opaque', loadOp: 'clear', storeOp: 'store' },
                ...(temporal === undefined
                  ? []
                  : [
                      { target: temporal.name, loadOp: 'load' as const, storeOp: 'store' as const },
                    ]),
              ],
              sampledTargets: [color.name, depth, normal, field],
              draws: [
                {
                  program: `${source}.pipeline`,
                  bindings: ['receiver.view', 'receiver.inputs'],
                  vertexData: [],
                  vertexLayout: 'none',
                  draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
                },
              ],
            },
            {
              kind: 'raster',
              name: `${options.producerIdentity}-compose`,
              colorAttachments: [{ target: color.name, loadOp: 'load', storeOp: 'store' }],
              sampledTargets: ['caustics-lit-opaque'],
              draws: [
                {
                  program: `${copy}.pipeline`,
                  bindings: ['copy.empty', 'copy.inputs'],
                  vertexData: [],
                  vertexLayout: 'none',
                  draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
                },
              ],
            },
          ],
        });
      }
      return ok({ work });
    },
    onFrameSubmitted(frame, submission) {
      if (submission !== undefined) submitted = frame;
    },
  };
  return {
    feature,
    readParameters: () => parameters?.(),
    configure(value: NonNullable<typeof parameters>) {
      parameters = value;
    },
  };
}
