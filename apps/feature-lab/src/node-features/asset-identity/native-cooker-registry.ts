import { type NativeCookDraft, NativeCookerRegistry } from '@forgeax/engine/pack/native-cooker';
import { defineFeature } from '../../lab/feature';

const GUID = '019e9c00-0000-7000-8000-00000000fe01';

function labCooker(key: string) {
  return {
    key,
    discover: (input: unknown) => {
      if (typeof input !== 'object' || input === null || !('source' in input))
        throw new Error('source is required');
      return { source: String(input.source) };
    },
    cook: (input: { readonly source: string }): NativeCookDraft<{ readonly source: string }> => {
      if (input.source === 'broken') throw { code: 'lab-schema-invalid', detail: 'missing field' };
      return {
        guid: GUID,
        payload: { source: input.source },
        refs: [],
        artifacts: {
          'lab/program.json': {
            mediaType: 'application/json',
            bytes: new TextEncoder().encode(input.source),
          },
        },
        inputFingerprint: `sha256:${input.source}`,
      };
    },
  };
}

export default defineFeature({
  title: 'Native cooker registry',
  catalog: 'Native cooker registry',
  kind: 'headless',
  summary:
    'NativeCookerRegistry maps a kind key to discover + cook; run() returns validated drafts or native-cook-failed.',
  expect:
    'Registered cooker yields artifact descriptors; missing/throwing cookers fail structurally; a bad candidate keeps last-known-good.',
  async run(checks) {
    const registry = new NativeCookerRegistry();
    const unregister = registry.register(labCooker('lab-effect'));
    let duplicate = false;
    try {
      registry.register(labCooker('lab-effect'));
    } catch (error) {
      duplicate = error instanceof TypeError;
    }
    checks.ok('duplicate key is rejected', duplicate);
    checks.equal('registered keys', registry.registeredCookers(), ['lab-effect']);

    const product = await registry.run('lab-effect', { source: 'fx.wgsl' });
    checks.ok('run succeeds', product.ok);
    if (product.ok) {
      const artifact = product.value.artifacts['lab/program.json'];
      checks.equal(
        'artifact bytes become a descriptor',
        artifact && { path: artifact.path, byteLength: artifact.byteLength },
        {
          path: 'lab/program.json',
          byteLength: 7,
        },
      );
    }

    const missing = await registry.run('not-registered', {});
    checks.equal(
      'missing cooker -> native-cook-failed (no fallback)',
      missing.ok ? 'ok' : `${missing.error.stage}/${missing.error.code}`,
      'native-cook/native-cook-failed',
    );
    const thrown = await registry.runDraft('lab-effect', { source: 'broken' });
    checks.ok(
      'thrown producer value is kept in detail',
      !thrown.ok &&
        String((thrown.error.detail as { producer?: unknown }).producer).includes(
          'lab-schema-invalid',
        ),
    );
    const undiscoverable = await registry.runDraft('lab-effect', {});
    checks.ok('discover failure is structured', !undiscoverable.ok);

    const first = await registry.runTransaction({ key: 'lab-effect', input: { source: 'v1' } });
    checks.ok('first transaction commits', first.ok && first.value.status === 'committed');
    if (first.ok) {
      const second = await registry.runTransaction({
        key: 'lab-effect',
        input: { source: 'broken' },
        previous: first.value,
      });
      checks.ok(
        'failed candidate recovers last-known-good',
        second.ok &&
          second.value.status === 'recovered' &&
          (second.value.lastKnownGood.payload as { source?: unknown }).source === 'v1',
      );
    }

    unregister();
    checks.equal('unregister removes the cooker', registry.get('lab-effect'), undefined);
  },
});
