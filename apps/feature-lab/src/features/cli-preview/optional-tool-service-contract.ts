import { createServiceCapability } from '@forgeax/engine/tool-runtime';
import { defineFeature } from '../../lab/feature';

const expected = {
  toolId: 'asset.material.preview',
  descriptorDigest: 'sha256:descriptor',
  recipeDigest: 'sha256:recipe',
  workloadClass: 'studio-sphere',
  codeDigest: 'sha256:code',
  browserVersion: 'chromium-140',
  backend: 'webgpu',
} as const;

type Admission = NonNullable<Parameters<typeof createServiceCapability>[0]>;

function admission(overrides: Partial<Admission> = {}): Admission {
  return {
    schema: 'forgeax.tool-service-admission-ref.v1',
    reportDigest: `sha256:${'a'.repeat(64)}`,
    ...expected,
    frameCount: 300,
    samples: { privateCold: 30, privateWarm: 30, serviceCold: 30, serviceWarm: 30 },
    correctness: {
      terminalEquivalent: true,
      artifactIntegrity: true,
      freshReplay: true,
      hiddenParity: true,
      drawCalls: 4,
      nonBlackPixels: 1000,
    },
    performance: {
      privateMedianMs: 100,
      privateP95Ms: 120,
      privateMaxMs: 150,
      privateRssBytes: 1000,
      serviceMedianMs: 50,
      serviceP95Ms: 60,
      serviceMaxMs: 80,
      serviceRssBytes: 1000,
    },
    cleanupPassed: true,
    evictionPassed: true,
    ...overrides,
  };
}

function reason(result: ReturnType<typeof createServiceCapability>): string {
  return result.available ? 'available' : result.detail.reason;
}

export default defineFeature({
  title: 'Optional tool service contract',
  catalog: 'Optional tool service contract',
  kind: 'headless',
  summary:
    'createServiceCapability admits an acceleration service only for a workload-scoped admission report whose identity, 300-frame sample set, correctness, performance thresholds and cleanup all pass; everything else is the structured tool-service-capability-absent state.',
  expect:
    'no report is absent; a fully passing synthetic report is available with its digest; wrong tool, 299 frames, failed parity, a slow service and failed cleanup are each absent with a specific reason.',
  run(checks) {
    const none = createServiceCapability(undefined, expected);
    checks.equal(
      'no admission code',
      none.available ? 'available' : none.code,
      'tool-service-capability-absent',
    );
    checks.equal(
      'no admission reason',
      reason(none),
      'no workload-scoped admission report was supplied',
    );
    const pass = createServiceCapability(admission(), expected);
    checks.ok(
      'passing report admits',
      pass.available && pass.reportDigest === admission().reportDigest,
    );
    const cases: [string, Partial<Admission>, string][] = [
      ['wrong tool', { toolId: 'asset.mesh.preview' }, 'admission toolId does not match this run'],
      ['short workload', { frameCount: 299 }, 'admission workload ran fewer than 300 frames'],
      [
        'failed parity',
        { correctness: { ...admission().correctness, hiddenParity: false } },
        'admission correctness gate failed',
      ],
      [
        'slow service',
        { performance: { ...admission().performance, serviceMedianMs: 90 } },
        'admission performance threshold failed',
      ],
      ['cleanup failed', { cleanupPassed: false }, 'admission cleanup gate failed'],
    ];
    for (const [name, overrides, why] of cases) {
      checks.equal(name, reason(createServiceCapability(admission(overrides), expected)), why);
    }
  },
});
