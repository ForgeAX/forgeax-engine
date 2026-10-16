// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 2.lighting/4.lighting-maps (static scene: diffuse+specular maps
// on a lit cube, first-person controls input-gated so no motion without input).
// Delegates to the shared harness; this file only supplies the demo identity +
// its live-pixel hook (window.__captureLightingMaps, installed by src/index.ts).
//
// pixel mode: capture a frame -> replay on a fresh dawn-node device -> compare
// the replayed RT against the live canvas readback (mean/maxChannel/coveredMean).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FALSIFY_NO_LIGHT = process.env.FALSIFY_NO_LIGHT === '1';
const FALSIFY_NO_SPECULAR_MAP = process.env.FALSIFY_NO_SPECULAR_MAP === '1';
if (FALSIFY_NO_LIGHT && FALSIFY_NO_SPECULAR_MAP) {
  throw new Error('choose one Browser falsifier at a time');
}

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-2-lighting-4-lighting-maps',
  label: 'learn-render 2.4 lighting-maps',
  mode: 'pixel',
  liveHook: '__captureLightingMaps',
  rtIdx: 0,
  appDir: dirname(here),
  navigationWaitUntil: 'domcontentloaded',
  warmupMs: 10000,
  allowEmptyFrame: FALSIFY_NO_LIGHT,
  urlSuffix: FALSIFY_NO_LIGHT
    ? '?rhi-debug-no-light=1'
    : FALSIFY_NO_SPECULAR_MAP
      ? '?rhi-debug-no-specular-map=1'
      : '',
  assertTape: ({ tape }) => {
    const diffuseTexture = tape.events.find(
      (event) =>
        event.kind === 'createTexture' &&
        event.desc?.size?.width === 512 &&
        event.desc?.size?.height === 512 &&
        event.desc?.format === 'rgba8unorm-srgb' &&
        event.desc?.usage === 23,
    );
    const specularTexture = tape.events.find(
      (event) =>
        event.kind === 'createTexture' &&
        event.desc?.size?.width === 500 &&
        event.desc?.size?.height === 500 &&
        event.desc?.format === 'rgba8unorm' &&
        event.desc?.usage === 23,
    );
    const viewFor = (texture) =>
      texture === undefined
        ? undefined
        : tape.events.find(
            (event) =>
              event.kind === 'createTextureView' &&
              event.sourceHandleId === texture.handleId,
          )?.resultHandleId;
    const diffuseView = viewFor(diffuseTexture);
    const specularView = viewFor(specularTexture);
    if (diffuseView === undefined || (!FALSIFY_NO_SPECULAR_MAP && specularView === undefined)) {
      throw new Error(
        FALSIFY_NO_SPECULAR_MAP
          ? 'capture tape no-specular falsifier is missing the diffuse texture view'
          : 'capture tape is missing diffuse/specular texture views',
      );
    }

    const materialGroup = tape.events.find(
      (event) =>
        event.kind === 'createBindGroup' &&
        event.entries?.length === 20 &&
        event.resourceHandleIds?.[2] === diffuseView,
    );
    if (materialGroup === undefined) {
      throw new Error(
        FALSIFY_NO_SPECULAR_MAP
          ? 'capture tape no-specular falsifier still binds the specular view at binding 4'
          : 'capture tape Standard PBR material bind group does not bind diffuse/specular maps at bindings 2/4',
      );
    }
    const specularBindingMatches = materialGroup.resourceHandleIds?.[4] === specularView;
    if (
      (!FALSIFY_NO_SPECULAR_MAP && !specularBindingMatches) ||
      (FALSIFY_NO_SPECULAR_MAP && specularBindingMatches)
    ) {
      throw new Error(
        FALSIFY_NO_SPECULAR_MAP
          ? 'capture tape no-specular falsifier retained the specular view at binding 4'
          : 'capture tape Standard PBR material bind group does not bind the specular view at binding 4',
      );
    }

    const standardPipeline = tape.events.find(
      (event) =>
        event.kind === 'createRenderPipeline' &&
        event.desc?.fragment?.targets?.[0]?.format === 'rgba16float' &&
        event.desc?.vertex?.buffers?.[0]?.attributes?.some(
          (attribute) => attribute.shaderLocation === 1,
        ),
    );
    const pipelineUse =
      standardPipeline === undefined
        ? undefined
        : tape.events.find(
            (event) =>
              event.kind === 'setPipeline' &&
              event.pipelineHandleId === standardPipeline.handleId,
          );
    const materialUse = tape.events.find(
      (event) =>
        event.kind === 'setBindGroup' &&
        event.index === 1 &&
        event.bindGroupHandleId === materialGroup.handleId &&
        event.passHandleId === pipelineUse?.passHandleId,
    );
    const drawUse = tape.events.find(
      (event) =>
        (event.kind === 'draw' || event.kind === 'drawIndexed') &&
        event.passHandleId === pipelineUse?.passHandleId,
    );
    if (standardPipeline === undefined || pipelineUse === undefined || materialUse === undefined || drawUse === undefined) {
      throw new Error('capture tape diffuse/specular material group was not consumed by a Standard PBR draw');
    }
    console.log(
      `[learn-render-lighting-maps] tape diffuse=${diffuseTexture.handleId} ` +
        `specular=${specularTexture?.handleId ?? '<omitted>'} ` +
        `materialBindings=${FALSIFY_NO_SPECULAR_MAP ? '2/no-specular' : '2/4'} ` +
        `pipeline=${standardPipeline.handleId} drawCall=true falsifier=${FALSIFY_NO_LIGHT ? 'no-light' : FALSIFY_NO_SPECULAR_MAP ? 'no-specular-map' : 'none'}`,
    );
  },
  assertPixels: FALSIFY_NO_LIGHT
    ? ({ pixels, width, height }) => {
        const x = Math.floor(width / 2);
        const y = Math.floor(height / 2);
        const offset = (y * width + x) * 4;
        const center = [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
        if (Math.max(...center) > 32) {
          throw new Error(
            `no-light falsifier lit the cube center: rgb=${center.join(',')} at ${x},${y}`,
          );
        }
        console.log(`[learn-render-lighting-maps] no-light center=${center.join(',')}`);
      }
    : undefined,
});
