#!/usr/bin/env node

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFrameModel } from '@forgeax/engine-rhi-debug';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/hello-boss-lightning',
  label: 'hello-boss-lightning',
  mode: 'structural',
  appDir: dirname(scriptsDir),
  warmupMs: 1400,
  assertTape: ({ tape }) => {
    const model = buildFrameModel(tape);
    const dispatches = model.works.filter(work =>
      work.pipeline?.shaders?.some(shader => shader.entryPoint?.startsWith('forgeax_vfx_'))
    );
    const draws = tape.events.filter(event =>
      event.kind === 'drawIndirect' || event.kind === 'drawIndexedIndirect'
    );
    if (draws.length < 5 || dispatches.length < 8) {
      throw new Error(
        `Boss Lightning capture is incomplete: draws=${draws.length} dispatches=${dispatches.length}`,
      );
    }
    const standard = work => work.pipeline?.shaders?.some(shader =>
      shader.source?.includes('evaluateStandardSurface'));
    const particle = model.works.find(work => work.kind === 'drawIndexedIndirect' && standard(work));
    const scene = model.works.find(work => work.kind === 'drawIndexed' && standard(work));
    if (particle === undefined || scene === undefined) {
      throw new Error('Capture must contain both Scene and particle Mesh using Standard surface');
    }
    const lighting = particle.bindings.filter(binding => binding.groupIndex === 2);
    if (lighting.length === 0 || lighting.some(binding => binding.binding < 3) ||
        particle.bindings.some(binding => binding.groupIndex === 3)) {
      throw new Error('Particle Standard lighting must not import scene Mesh/Instance tables');
    }
    for (const binding of lighting) {
      const shared = scene.bindings.find(candidate =>
        candidate.groupIndex === 2 && candidate.binding === binding.binding);
      if (shared?.resourceId !== binding.resourceId) {
        throw new Error(`Particle lighting binding ${binding.binding} diverged from the current Standard pipeline`);
      }
    }
    console.log(`[boss-lightning] shared Standard lighting: Scene work=${scene.workIndex} particle work=${particle.workIndex} bindings=${lighting.map(binding => binding.binding).join(',')}`);
  },
});
