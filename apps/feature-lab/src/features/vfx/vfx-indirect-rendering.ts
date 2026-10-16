import { check, vfxProbe } from './support/probe';
import { LAB_DEFAULT_KINDS } from './support/vfx-stage';

export default vfxProbe(
  {
    title: 'VFX indirect rendering',
    catalog: 'VFX indirect rendering',
    summary:
      'Every particle renderer draws through GPU-written indirect arguments, so live counts never round-trip to the CPU.',
    expect:
      'With the default emitters on, every VFX raster draw is indirect (indirectDraws == subjectOutputs > 0); session-disabling every emitter drops indirect draws to 0.',
  },
  async (vfx, { frames }) => {
    const on = vfx.host.feature.inspect();
    const off = vfx.only([]);
    await frames(6);
    const disabled = vfx.host.feature.inspect();
    const restored = vfx.only();
    await frames(6);
    const back = vfx.host.feature.inspect();
    return [
      check(
        'indirect draws with all emitters on',
        on.indirectDraws >= LAB_DEFAULT_KINDS.length,
        on,
      ),
      check('every VFX draw is indirect', on.indirectDraws === on.subjectOutputs, on),
      check('disable all emitters accepted', off === undefined, off),
      check(
        'no indirect draws with every emitter disabled',
        disabled.indirectDraws === 0,
        disabled,
      ),
      check('re-enable accepted', restored === undefined, restored),
      check('indirect draws return', back.indirectDraws >= LAB_DEFAULT_KINDS.length, back),
    ];
  },
);
