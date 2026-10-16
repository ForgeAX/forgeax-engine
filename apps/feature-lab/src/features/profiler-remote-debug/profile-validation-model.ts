import { buildProfileModel, validateProfileCapture } from '@forgeax/engine/profiler';
import { defineFeature } from '../../lab/feature';
import { sampleCapture } from './_shared/sample-capture';

export default defineFeature({
  title: 'Profile validation and model',
  catalog: 'Profile validation/model',
  kind: 'headless',
  summary:
    'validateProfileCapture checks a versioned artifact; buildProfileModel projects frame and phase summaries without mutating it.',
  expect:
    'The sample validates, the model counts frames/records/p95, and malformed or future-version artifacts return structured codes.',
  run(checks) {
    const capture = sampleCapture('capture-0001', [100, 200, 300]);
    const frozen = JSON.stringify(capture);
    const valid = validateProfileCapture(capture);
    checks.ok('sample capture validates', valid.ok, valid.ok ? undefined : valid.error.code);
    const model = buildProfileModel(capture);
    if (!model.ok) {
      checks.ok('buildProfileModel ok', false, model.error.code);
      return;
    }
    checks.equal('model frameCount', model.value.summary.frameCount, 3);
    checks.equal('model recordCount', model.value.summary.recordCount, 3);
    checks.equal('model p95 is nearest-rank 300', model.value.summary.p95DurationMicros, 300);
    checks.equal('model frame range', model.value.summary.frameRange, { first: 1, last: 3 });
    checks.equal(
      'model phase frame-total count',
      model.value.phases.find((p) => p.phase === 'frame-total')?.count,
      3,
    );
    checks.ok('input artifact unchanged', JSON.stringify(capture) === frozen);

    const unknownPhase = {
      ...capture,
      records: [{ ...capture.records[0], phase: 'not-in-catalog' }],
    };
    const badPhase = validateProfileCapture(unknownPhase);
    checks.equal(
      'phase outside catalog -> profile-artifact-invalid',
      badPhase.ok ? 'ok' : badPhase.error.code,
      'profile-artifact-invalid',
    );
    const future = validateProfileCapture({ ...capture, schemaVersion: '9.0' });
    checks.equal(
      'future schemaVersion -> profile-artifact-incompatible',
      future.ok ? 'ok' : future.error.code,
      'profile-artifact-incompatible',
    );
    const notObject = validateProfileCapture('nope');
    checks.ok(
      'non-object rejected with a detail path',
      !notObject.ok && typeof notObject.error.detail.path === 'string',
    );
  },
});
