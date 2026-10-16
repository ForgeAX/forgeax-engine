import { compareProfileCaptures } from '@forgeax/engine/profiler';
import { defineFeature } from '../../lab/feature';
import { sampleCapture } from './_shared/sample-capture';

export default defineFeature({
  title: 'Profile comparison',
  catalog: 'Profile comparison',
  kind: 'headless',
  summary:
    'compareProfileCaptures projects two validated captures into side summaries and a deterministic phase union.',
  expect:
    'Left/right summaries match their inputs, frame-total appears once with a delta, and an invalid side names left or right.',
  run(checks) {
    const left = sampleCapture('capture-0001', [100, 100]);
    const right = sampleCapture('capture-0002', [150, 250]);
    const result = compareProfileCaptures(left, right);
    if (!result.ok) {
      checks.ok(
        'comparison ok',
        false,
        `${result.error.code} ${JSON.stringify(result.error.detail)} ${result.error.hint}`,
      );
      return;
    }
    checks.equal('left captureId', result.value.left.summary.captureId, 'capture-0001');
    checks.equal('right captureId', result.value.right.summary.captureId, 'capture-0002');
    const rows = result.value.phases.filter((row) => row.identity.phase === 'frame-total');
    checks.equal('frame-total appears once in the union', rows.length, 1);
    checks.ok(
      'row carries both sides and a delta',
      rows[0]?.left !== undefined && rows[0]?.right !== undefined && rows[0]?.delta !== undefined,
      JSON.stringify(rows[0]?.delta),
    );
    const again = compareProfileCaptures(left, right);
    checks.ok(
      'comparison is deterministic',
      again.ok && JSON.stringify(again.value) === JSON.stringify(result.value),
    );
    const broken = compareProfileCaptures(left, { ...right, timeUnit: 'seconds' });
    checks.equal(
      'invalid right side is named',
      broken.ok ? 'ok' : broken.error.detail.side,
      'right',
    );
  },
});
