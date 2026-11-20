#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFrameModel, verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/bevy-clearcoat',
  label: 'bevy clearcoat',
  mode: 'structural',
  appDir: dirname(scriptsDir),
  waitForPackIndex: true,
  waitForAppScene: true,
  assertTape({ tape }) {
    const sphere = buildFrameModel(tape).works.find(({ pipeline, drawCall }) =>
      (drawCall?.kind === 'drawIndexed' || drawCall?.kind === 'drawIndexedIndirect') &&
      pipeline.shaders?.some(({ stage, source }) => stage === 'fragment' && source?.includes('.clearcoatRoughness')),
    )?.drawCall;
    let indexCount;
    if (sphere?.kind === 'drawIndexed') indexCount = sphere.indexCount;
    if (sphere?.kind === 'drawIndexedIndirect') {
      const buffer = tape.bootstrap.find(({ handleId }) => handleId === sphere.indirectBufferHandleId);
      const range = buffer?.initialData?.find(({ byteOffset, byteLength }) =>
        byteOffset <= sphere.indirectOffset && byteOffset + byteLength >= sphere.indirectOffset + 4,
      );
      const bytes = range === undefined ? undefined : tape.blobPool.get(range.hash);
      if (bytes) {
        indexCount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          .getUint32(sphere.indirectOffset - range.byteOffset, true);
      }
    }
    if (indexCount !== 8928) throw new Error('the clearcoat shader must draw the 8,928-index sphere');
  },
});
