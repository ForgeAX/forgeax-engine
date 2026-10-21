import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/app-game-capability-lab',
    // Keep this project narrowly scoped to authored Pack contracts; the
    // template's DOM tests are browser-owned elsewhere.
    include: [
      '__tests__/clearcoat-material.test.ts',
      '__tests__/vfx-effect-assets.test.ts',
      '__tests__/attack-presentation.test.ts',
      '__tests__/animated-target-material.test.ts',
      '__tests__/custom-projectile-mesh.test.ts',
      '__tests__/multi-world-overlay.test.ts',
      '__tests__/boss-lightning-vfx-assets.test.ts',
      '__tests__/ui-manifest.test.ts',
      '__tests__/asset-lab-actions.test.ts',
      '__tests__/target-profile-loop.test.ts',
      '__tests__/target-relay.test.ts',
      '__tests__/gameplay-state.test.ts',
      '__tests__/video-texture-panel.test.ts',
      '__tests__/gameplay-aim.test.ts',
      '__tests__/gameplay-input.integration.test.ts',
      '__tests__/counterattack.test.ts',
      '__tests__/health-pickup.test.ts',
      '__tests__/repair-cache.test.ts',
      '__tests__/energy-core-extraction.test.ts',
      '__tests__/reward-choice.test.ts',
      '__tests__/barrier-route.test.ts',
      '__tests__/sentinel-ranged-threat.test.ts',
      '__tests__/lighting-mode.test.ts',
      '__tests__/resonance-forge-scriptable-pack.test.ts',
    ],
    exclude: ['**/node_modules/**'],
  },
});
