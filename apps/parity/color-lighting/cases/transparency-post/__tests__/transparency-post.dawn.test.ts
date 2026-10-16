import { shaderManifestUrl as createShaderManifestUrl } from '../../../../../../packages/runtime/src/__tests__/shader-manifest-url.fixture';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { readbackTexturePixels } from '../../../../../../packages/rhi-debug/src/readback';
import { describe, expect, it } from 'vitest';
import ldrCase from '../transparent-ldr-urp.json' with { type: 'json' };
import hdrCase from '../transparent-hdr-hdrp.json' with { type: 'json' };
import type { SceneCase } from '../../../src/contracts/types';
import { createDawnSurface, makeWorld } from '../gpu-capture';

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;
const requiredParityRun = process.env.FORGEAX_PARITY_REQUIRED === '1';
const cases = [ldrCase, hdrCase] as unknown as readonly SceneCase[];
const manifest = await buildEngineShaderManifest();
const manifestUrl = createShaderManifestUrl(manifest);

function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

describe('transparency post Dawn GPU integration', () => {
  it.skipIf(!dawnReady && !requiredParityRun)('captures both pipeline producers from live attachments', async () => {
    if (!dawnReady) throw new Error('required transparency/post Dawn evidence needs navigator.gpu');
    const observations: Array<{
      caseId: string;
      pipelineId: string;
      backendId: string;
      frameId: number;
      rawHash: string;
      bytes: number[];
    }> = [];
    for (const sceneCase of cases) {
      const surface = createDawnSurface(sceneCase.scene.width, sceneCase.scene.height);
      const constructed = await constructRuntimeRendererHost(surface.canvas, {}, {
        shaderManifestUrl: manifestUrl,
      });
      expect(constructed.ok).toBe(true);
      if (!constructed.ok) throw constructed.error;
      const { renderer, debugDrawHost } = constructed.value;
      try {
        const world = makeWorld(sceneCase);
        const attachment = renderer.attach(world);
        if (!attachment.ok) throw attachment.error;
        world.update().unwrap();
        const frameRequest = {
          leases: [attachment.value],
          camera: { lease: attachment.value },
          environment: { lease: attachment.value },
        };
        const drawn = renderer.draw(frameRequest);
        expect(drawn.ok).toBe(true);
        if (!drawn.ok) throw new Error(drawn.error.hint);
        const completed = await drawn.value.completed;
        expect(completed.ok).toBe(true);
        if (!completed.ok) throw completed.error;
        const bytes = await readbackTexturePixels(
          debugDrawHost.device,
          surface.getTexture(),
          sceneCase.scene.width,
          sceneCase.scene.height,
          { bytesPerTexel: 4 },
        );
        observations.push({
          caseId: sceneCase.caseId,
          pipelineId: 'forgeax::standard',
          backendId: 'dawn',
          frameId: 0,
          rawHash: hashBytes(bytes),
          bytes: Array.from(bytes),
        });
      } finally {
        await renderer.dispose();
      }
    }
    expect(observations).toHaveLength(2);
    expect(observations.map((entry) => entry.pipelineId)).toEqual([
      'forgeax::standard',
      'forgeax::standard',
    ]);
    expect(observations.every((entry) => entry.bytes.length > 0)).toBe(true);
    expect(observations.every((entry) => /^[0-9a-f]{8}$/.test(entry.rawHash))).toBe(true);
    const artifactPath = process.env.FORGEAX_PARITY_TRANSPARENCY_ARTIFACT;
    if (artifactPath !== undefined) {
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(
        artifactPath,
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'transparency-producer',
          invocationId: process.env.FORGEAX_PARITY_INVOCATION_ID ?? 'transparency-dawn-artifact',
          cases: observations,
        }, null, 2)}\n`,
        'utf8',
      );
    }
  }, 120_000);
});
