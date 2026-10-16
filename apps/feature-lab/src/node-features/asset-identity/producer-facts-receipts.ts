import { validateProducerContract } from '@forgeax/engine/pack';
import { NativeCookerRegistry } from '@forgeax/engine/pack/native-cooker';
import { defineFeature } from '../../lab/feature';

const GUID = '01890000-0000-7000-8000-aaaaaaaaaa01';

const FACTS = {
  packageId: 'pkg/feature-lab',
  provenance: { provider: 'feature-lab', version: '1.0.0' },
  revision: { digest: 'sha256:lab', observedAt: 1, rootId: 'root-a' },
  diagnostics: [
    {
      code: 'lab-warning',
      severity: 'warning',
      subject: { type: 'package', id: 'pkg/feature-lab' },
    },
  ],
};

function code(value: unknown): string {
  const result = validateProducerContract(value);
  return result.ok ? 'ok' : result.error.code;
}

export default defineFeature({
  title: 'Producer facts/receipts',
  catalog: 'Producer facts/receipts',
  kind: 'headless',
  summary:
    'Producers publish provenance, revision, diagnostics, sourceKey outputs, and a cook receipt with fingerprints.',
  expect:
    'Complete facts validate; partial facts fail with invalid-producer-fact; receipts carry input fingerprint + output digest.',
  async run(checks) {
    checks.equal(
      'complete producer facts validate',
      code({ ...FACTS, guid: GUID, kind: 'host/blob', sourceKey: 'blob/main', sourceIndex: 0 }),
      'ok',
    );
    checks.equal(
      'incomplete revision is rejected',
      code({ ...FACTS, revision: { digest: 'sha256:lab' } }),
      'invalid-producer-fact',
    );
    checks.equal(
      'empty provenance is rejected',
      code({ ...FACTS, provenance: { provider: '', version: '1' } }),
      'invalid-producer-fact',
    );
    checks.equal(
      'blocking diagnostic without recovery hint is rejected',
      code({
        ...FACTS,
        diagnostics: [
          { code: 'lab-blocking', severity: 'blocking', subject: { type: 'package', id: 'p' } },
        ],
      }),
      'invalid-producer-fact',
    );
    checks.equal(
      'sourceIndex alone is never identity',
      code({ guid: GUID, kind: 'host/blob', sourceIndex: 0 }),
      'missing-source-key',
    );

    const registry = new NativeCookerRegistry();
    registry.register({
      key: 'lab-receipt',
      cook: (input: unknown) => ({
        guid: GUID,
        payload: { value: String(input) },
        refs: [],
        artifacts: {},
        inputFingerprint: `sha256:${String(input)}`,
      }),
    });
    const a = await registry.run('lab-receipt', 'alpha');
    const b = await registry.run('lab-receipt', 'alpha');
    const c = await registry.run('lab-receipt', 'beta');
    if (!a.ok || !b.ok || !c.ok) {
      checks.ok('native cook runs succeed', false);
      return;
    }
    checks.equal(
      'receipt records producer status and input fingerprint',
      [a.value.receipt.status, a.value.receipt.inputFingerprint],
      ['succeeded', 'sha256:alpha'],
    );
    checks.ok(
      'output digest is a sha256 fact',
      String(a.value.receipt.outputDigest).startsWith('sha256:'),
    );
    checks.equal('identical input reproduces the digest', b.value.digest, a.value.digest);
    checks.ok('changed input changes the digest', c.value.digest !== a.value.digest);
  },
});
