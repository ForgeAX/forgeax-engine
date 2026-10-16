// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 2.lighting/3.materials. The demo owns the live pixel hook;
// the shared harness captures, replays on fresh dawn-node, and compares RTs.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const materialMetallic = process.env.VITE_FALSIFY_MATERIAL_METALLIC ?? '';
if (materialMetallic !== '' && !['metal', 'dielectric'].includes(materialMetallic)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_METALLIC=${materialMetallic}; expected metal or dielectric`,
  );
  process.exit(1);
}

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-2-lighting-3-materials',
  label: 'learn-render 2.3 materials',
  mode: materialMetallic === '' ? 'pixel' : 'structural',
  liveHook: materialMetallic === '' ? '__captureMaterials' : undefined,
  rtIdx: 0,
  appDir: dirname(here),
  assertTape:
    materialMetallic === ''
      ? undefined
      : ({ tape }) => {
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
          );
          const materialUpload = materialBuffer === undefined
            ? undefined
            : tape.events.find(
                (event) =>
                  event.kind === 'writeBuffer' &&
                  event.handleId === materialBuffer.handleId &&
                  event.bufferOffset === 0 &&
                  event.size === 512,
              );
          const materialData = materialUpload === undefined
            ? undefined
            : tape.blobPool.get(materialUpload.dataHash);
          if (materialData === undefined || materialData.byteLength < 80) {
            throw new Error('capture tape is missing the 512-byte Standard PBR material upload');
          }
          const actualMetallic = new Float32Array(materialData)[4];
          const expectedMetallic = materialMetallic === 'metal' ? 1.0 : 0.0;
          if (Math.abs(actualMetallic - expectedMetallic) > 1e-6) {
            throw new Error(
              `capture tape material metallic=${actualMetallic}; expected ${expectedMetallic} at global byte offset 16`,
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
          if (standardPipeline === undefined) {
            throw new Error('capture tape is missing the Standard PBR material pipeline');
          }
          const pipelineUse = tape.events.find(
            (event) =>
              event.kind === 'setPipeline' &&
              event.pipelineHandleId === standardPipeline.handleId,
          );
          if (pipelineUse === undefined) {
            throw new Error('capture tape Standard PBR material pipeline was never selected');
          }
          const drawUse = tape.events.find(
            (event) =>
              (event.kind === 'draw' || event.kind === 'drawIndexed') &&
              event.passHandleId === pipelineUse.passHandleId,
          );
          if (drawUse === undefined) {
            throw new Error('capture tape Standard PBR material pipeline has no draw use');
          }
          console.log(
            `[learn-render 2.3 materials] tape materialMetallic=${materialMetallic} metallic=${actualMetallic} materialUBO byteOffset=16 standardPipeline=${standardPipeline.handleId} drawCall=true`,
          );
        },
});
