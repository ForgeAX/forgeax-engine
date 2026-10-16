import { parseParticleEffectSourceV3 } from '@forgeax/engine/vfx';
import { type CheckList, defineFeature } from '../../lab/feature';
import { LAB_EFFECT_SOURCE } from './support/lab-effect';

function refusal(
  checks: CheckList,
  name: string,
  source: unknown,
  code: string,
  path: string,
): void {
  const parsed = parseParticleEffectSourceV3(source);
  checks.equal(`${name}: code`, parsed.ok ? 'ok' : parsed.error.code, code);
  checks.equal(`${name}: detail.path`, parsed.ok ? '' : parsed.error.detail.path, path);
}

export default defineFeature({
  title: 'Code-first VFX source',
  catalog: 'Code-first VFX source',
  kind: 'headless',
  summary:
    'Schema-v3 emitter metadata (GPU backend, fixed bounds, schedule, program module, renderer GUIDs) is validated by parseParticleEffectSourceV3; behavior lives in WGSL, not in the source.',
  expect:
    'The lab source with five emitters parses; unknown fields, schemaVersion 2, a CPU backend, missing bounds and a ribbon without stripKey fail closed with a code and a JSON path.',
  run(checks) {
    const parsed = parseParticleEffectSourceV3(LAB_EFFECT_SOURCE);
    checks.ok('lab source parses', parsed.ok, parsed.ok ? undefined : parsed.error.hint);
    if (parsed.ok) {
      checks.equal('five emitters', parsed.value.emitters.length, 5);
      checks.ok('parsed source is frozen', Object.isFrozen(parsed.value));
      checks.equal(
        'program module kept',
        parsed.value.emitters[0]?.program.module,
        'lab-billboard.vfx.wgsl',
      );
    }
    const first = LAB_EFFECT_SOURCE.emitters[0];
    const withFirst = (patch: Record<string, unknown>) => ({
      schemaVersion: 3,
      emitters: [{ ...first, ...patch }],
    });
    refusal(
      checks,
      'unknown root field',
      { ...LAB_EFFECT_SOURCE, graph: {} },
      'vfx-source-invalid',
      'graph',
    );
    refusal(
      checks,
      'schemaVersion 2',
      { ...LAB_EFFECT_SOURCE, schemaVersion: 2 },
      'vfx-source-version-unsupported',
      'schemaVersion',
    );
    refusal(
      checks,
      'emitter typo field',
      withFirst({ spawnRate: 3 }),
      'vfx-source-invalid',
      'emitters[0].spawnRate',
    );
    refusal(
      checks,
      'CPU backend',
      withFirst({ backend: { required: 'cpu' } }),
      'vfx-source-invalid',
      'emitters[0].backend',
    );
    refusal(
      checks,
      'missing bounds',
      withFirst({ bounds: undefined }),
      'vfx-source-invalid',
      'emitters[0].bounds',
    );
    refusal(
      checks,
      'ribbon without stripKey',
      withFirst({ renderers: [{ kind: 'ribbon', material: 'x', capacity: 4 }] }),
      'vfx-source-renderer-invalid',
      'emitters[0].renderers[0]',
    );
    refusal(
      checks,
      'no emitters',
      { schemaVersion: 3, emitters: [] },
      'vfx-source-invalid',
      'emitters',
    );
  },
});
