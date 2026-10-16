import { check, vfxProbe } from './support/probe';

export default vfxProbe(
  {
    title: 'VFX capability refusal',
    catalog: 'VFX capability refusal',
    summary:
      'The VFX RenderFeature declares requiredCapabilities [compute, indirectDrawing]; on a device missing either, the renderer disables it with render-feature-capability-missing instead of emulating on the CPU.',
    expect:
      'The feature declares exactly compute + indirectDrawing; this device reports both, so the renderer diagnostic for the VFX feature is active with no error. The missing-capability branch is a unit gate (see doc).',
  },
  async (vfx) => {
    const required = vfx.host.feature.requiredCapabilities ?? [];
    const inspection = vfx.app.renderer.inspect();
    const caps = inspection.capabilities as unknown as Record<string, unknown>;
    const diagnostic = inspection.featureDiagnostics.find(
      (entry) => entry.identity === vfx.host.feature.identity,
    );
    return [
      check(
        'declares compute + indirectDrawing',
        [...required].sort().join(',') === 'compute,indirectDrawing',
        required,
      ),
      check(
        'device reports every required capability',
        required.every((name) => caps[name] === true),
        required.map((name) => `${name}=${String(caps[name])}`),
      ),
      check(
        'VFX feature is registered',
        inspection.features.includes(vfx.host.feature.identity),
        inspection.features,
      ),
      check('capable device keeps the feature active', diagnostic?.status === 'active', diagnostic),
      check(
        'no capability-missing error',
        diagnostic?.latestError === undefined,
        diagnostic?.latestError,
      ),
    ];
  },
);
