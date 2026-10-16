import { validateMaterialOutputs } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

function reason(outputs: unknown): string {
  const result = validateMaterialOutputs(outputs, 'lab::mrt', 'Forward');
  if (result.ok) return 'ok';
  return result.error.code === 'material-output-contract-invalid'
    ? String(result.error.detail.reason)
    : result.error.code;
}

export default defineFeature({
  title: 'Public material MRT',
  catalog: 'Public material MRT',
  kind: 'headless',
  summary:
    'MaterialPass.outputs maps WGSL @location(n) to ordered typed attachments; the declaration is admitted before any shader publication or GPU allocation.',
  expect:
    'All checks pass: a three-output declaration is accepted and duplicate names, non-color formats, blending an integer target, and out-of-range write masks are rejected with reasons.',
  run(checks) {
    checks.equal(
      'valid three outputs',
      reason([
        {
          name: 'color',
          format: 'rgba16float',
          blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: {} },
        },
        { name: 'normal', format: 'rgba8unorm', writeMask: 7 },
        { name: 'id', format: 'r32uint' },
      ]),
      'ok',
    );
    checks.equal('absent outputs keep the single-target default', reason(undefined), 'ok');
    checks.equal('empty list', reason([]), 'outputs must be non-empty');
    checks.equal(
      'bad identifier',
      reason([{ name: '0x', format: 'rgba8unorm' }]),
      'output name must be an identifier',
    );
    checks.equal(
      'duplicate name',
      reason([
        { name: 'a', format: 'rgba8unorm' },
        { name: 'a', format: 'rgba8unorm' },
      ]),
      'output names must be unique',
    );
    checks.equal(
      'depth format',
      reason([{ name: 'a', format: 'depth24plus' }]),
      'output format must be a color attachment format',
    );
    checks.equal(
      'integer blend',
      reason([{ name: 'id', format: 'r32uint', blend: { color: {}, alpha: {} } }]),
      'integer outputs cannot blend',
    );
    checks.equal(
      'write mask range',
      reason([{ name: 'a', format: 'rgba8unorm', writeMask: 16 }]),
      'writeMask must contain only RGBA bits',
    );
  },
});
