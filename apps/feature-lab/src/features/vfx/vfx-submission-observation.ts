import { check, vfxProbe } from './support/probe';

export default vfxProbe(
  {
    title: 'VFX submission observation',
    catalog: 'VFX submission observation',
    summary:
      'host.feature.inspect() returns a bounded receipt of VFX work that actually reached render-graph submission: frame number, compute dispatches, indirect draws and raster outputs.',
    expect:
      'The receipt frame number advances with renderer frames and its counters are non-negative integers with work present.',
  },
  async (vfx, { frames }) => {
    const first = vfx.host.feature.inspect();
    await frames(5);
    const second = vfx.host.feature.inspect();
    const counts = [second.dispatches, second.indirectDraws, second.subjectOutputs];
    return [
      check('frame number advances', second.frameNumber > first.frameNumber, {
        first: first.frameNumber,
        second: second.frameNumber,
      }),
      check(
        'counters are non-negative integers',
        counts.every((value) => Number.isInteger(value) && value >= 0),
        second,
      ),
      check(
        'receipt shows submitted work',
        second.dispatches > 0 && second.subjectOutputs > 0,
        second,
      ),
      check('receipt is frozen', Object.isFrozen(second)),
    ];
  },
);
