import { ASSET_ERROR_HINTS, AssetError, err, ok, type Result } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

function parsePositive(value: number): Result<number, AssetError> {
  if (value > 0) return ok(value);
  return err(
    new AssetError({
      code: 'asset-invalid-value',
      expected: 'a positive number',
      hint: ASSET_ERROR_HINTS['asset-invalid-value'],
    }),
  );
}

export default defineFeature({
  title: 'POD Result and structured errors',
  catalog: 'POD/Result SSOT',
  kind: 'headless',
  summary:
    'ok/err from the types package carry expected failures as data; errors share code/expected/hint fields.',
  expect:
    'All checks pass: ok/err discriminate on .ok, unwrapOr falls back, unwrap rethrows the original error object.',
  run(checks) {
    const good = parsePositive(2);
    checks.ok('ok() has ok=true', good.ok);
    checks.equal('ok value', good.ok ? good.value : undefined, 2);
    checks.equal('ok unwrap', good.unwrap(), 2);
    checks.equal('ok unwrapOr ignores default', good.unwrapOr(9), 2);

    const bad = parsePositive(-1);
    checks.ok('err() has ok=false', !bad.ok);
    checks.equal('err unwrapOr returns default', bad.unwrapOr(7), 7);
    if (!bad.ok) {
      checks.equal('closed error code', bad.error.code, 'asset-invalid-value');
      checks.ok('error carries expected', bad.error.expected === 'a positive number');
      checks.ok('error carries hint from the shared table', bad.error.hint.length > 0);
      checks.ok('error is an Error instance', bad.error instanceof Error);
      let thrown: unknown;
      try {
        bad.unwrap();
      } catch (e) {
        thrown = e;
      }
      checks.ok('unwrap rethrows the same error object', thrown === bad.error);
    }
    const hintCodes = Object.keys(ASSET_ERROR_HINTS);
    checks.ok(
      'hint table covers asset-not-found',
      hintCodes.includes('asset-not-found'),
      `${hintCodes.length} codes`,
    );
    checks.ok(
      'Result survives JSON when value is POD',
      JSON.stringify({ ok: good.ok, value: good.ok ? good.value : 0 }) === '{"ok":true,"value":2}',
    );
  },
});
