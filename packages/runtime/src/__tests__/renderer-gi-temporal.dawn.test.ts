import { Materials } from '@forgeax/engine-render';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { captureStaticFieldSequence } from './gi-scene-temporal-capture.fixture';
import { SCENE_ENVIRONMENT, sceneGi, sceneHarness } from './gi-scenes.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

// A long, explicitly selected diagnostic. A green collection is never a temporal verdict.
const diagnostic = process.env.FORGEAX_GI_TEMPORAL_DIAGNOSTICS === '1' ? it : it.skip;
diagnostic(
  'records 256 static Field layer frames without classifying stability',
  {
    timeout: 1_800_000,
  },
  async () => {
    const manifest = shaderManifestUrl(await buildEngineShaderManifest());
    const h = await sceneHarness(manifest, 'temporal-static-plane-production-h05');
    try {
      h.setSun(0);
      const material = await h.publish(
        Materials.standard({
          baseColor: [0.3, 0.65, 0.12, 1],
          roughness: 1,
          specular: 0,
        }),
      );
      h.spawn(await h.slab(2.8, 1.8, 0.25), material, [0, 0, 0]);
      h.setGi(
        sceneGi('field', {
          environment: SCENE_ENVIRONMENT,
          hysteresis: 0.5,
          radiosity: false,
          raysPerProbe: 64,
          probeBudget: 512,
        }),
      );
      // No extra settling sweeps: record immediately after the first ready submission.
      await h.settle(0);
      const result = await captureStaticFieldSequence(h, 256, Math.max(...SCENE_ENVIRONMENT));
      expect(result.status).toBe('COLLECTED_UNASSESSED');
      expect(result.receipts).toHaveLength(256);
      expect(h.errors).toEqual([]);
    } catch (error) {
      await h.recordFailure(error);
      throw error;
    } finally {
      await h.dispose();
    }
  },
);
