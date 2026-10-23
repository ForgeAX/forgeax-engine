import { describe, expect, it } from 'vitest';
import { CATALOG_ROWS } from '../src/lab/catalog';
import { collectFeatures } from '../src/lab/registry';

// collectFeatures already rejects a feature whose `catalog` names no row; this closes the
// other direction so a new catalog row cannot land without its Lab feature.
const features = collectFeatures({
  ...import.meta.glob('../src/features/*/*.ts', { eager: true }),
  ...import.meta.glob('../src/node-features/*/*.ts', { eager: true }),
});

/**
 * Rows proved by their own CI or release gate rather than a Lab page: they need a Worker
 * tier, a second process, a packaged SDK, a native host or an external agent the Lab
 * cannot host. The tester manual names each row's gate.
 */
const GATE_PROVED_ROWS = new Set([
  // Renderer internals observed only through perf and pixel-parity gates.
  'Render bundle reuse',
  'Custom ShadowCaster pass',
  // Fresh-device field composition and native contact replay, documented in README.
  'Managed scene SDF collision',
  'GPU-driven custom Surface ABI',
  'Native wgpu/Ray Query spike',
  // Worker execution tiers and frame pacing.
  'Engine-worker tier',
  'Shared tier',
  'One-credit Worker frame pacing',
  'Explicit Worker World rebuild',
  'Realm bootstrap',
  'Static plugin programs',
  // Native Host/Worker and producer-served Range fixtures; see README gate routes.
  'Gamepad feedback',
  // Native PCM, sample-clock and bus-ramp fixtures need their owning Host gates.
  'Acoustic regions',
  'Quantized layered music',
  'Long audio windows',
  // Project asset-library mount; DevKit asset-libraries integration, content unit and template tests.
  'Engine Content library',
  // Preview and workspace hosts.
  'Tool Preview Host',
  'Resident Host Pack selection',
  'Bound Preview host',
  'Project preview',
  'Cached asset thumbnails',
  'Material preview',
  'Mesh preview',
  'Texture preview',
  'VFX preview',
  'Engine workspace provider',
  'Current-project Editor Play',
  'Unified live game iteration',
  'Browser loopback relay',
  // Browser capture and inspection viewers.
  'Browser compositor capture',
  'Borrowed browser Page capture',
  'Persistent playthrough capture',
  'RHI debug viewer',
  // DeepSeek Harness federation.
  'DSH Engine panel',
  'DSH Activity provider',
  // Native PCM output and real bounded Range responses use the owning HTTP fixture.
  'Long audio windows',
  // Packaging, SDK and release.
  'Single-HTML offline delivery',
  'Player Asset Bundles',
  'Asset/format producers',
  'Shader check',
  'SDK archive build',
  'SDK source mode',
  'SDK ZIP offline bootstrap',
  'SDK npm carrier bootstrap',
  '`game-3d` starter',
  'SDK agent onboarding',
  'SDK update discovery',
  'Verified Candidate / Promotion',
  'Concurrent focused npm publish',
  'Maintenance CLI',
]);

describe('feature catalog coverage', () => {
  const covered = new Set(features.map((feature) => feature.definition.catalog));

  it('gives every catalog row a Lab feature or a named owning gate', () => {
    const orphans = [...CATALOG_ROWS.keys()].filter(
      (row) => !covered.has(row) && !GATE_PROVED_ROWS.has(row),
    );
    expect(orphans, 'add a Lab feature for each new catalog row').toEqual([]);
  });

  it('keeps the gate-proved list to live rows without a Lab feature', () => {
    const stale = [...GATE_PROVED_ROWS].filter((row) => !CATALOG_ROWS.has(row) || covered.has(row));
    expect(stale, 'remove these from GATE_PROVED_ROWS').toEqual([]);
  });
});
