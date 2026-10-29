import {
  addLoadWork,
  beginLoadSession,
  collectLoadTimeline,
  describeLoadProgress,
  endLoadSession,
  markLoadTimeline,
  readLoadProgress,
} from '@forgeax/engine/app';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Load progress and timeline',
  catalog: 'Load progress and timeline',
  kind: 'headless',
  summary:
    'One loading capability exposes measured work counters for UI progress and timestamped marks for diagnosis. This example reports its own work through the public App API.',
  expect:
    'Checks pass: counters and bytes are retained, discovering work never moves progress backwards, completion reaches 100%, and timeline collection contains the example marks. Cross-realm producer admission remains covered by owner gates.',
  async run(checks) {
    const session = 'feature-lab-loading';
    beginLoadSession(session, [
      { id: 'lab-downloads', weight: 2, bounded: true },
      { id: 'lab-assets', weight: 1, bounded: true },
    ]);
    markLoadTimeline('feature-lab-load-start', { session });
    try {
      addLoadWork('lab-downloads', {
        total: 4,
        done: 1,
        totalBytes: 100,
        bytes: 25,
        item: 'demo.pack',
      });
      const first = readLoadProgress();
      if (first === undefined) throw new Error('Load session was not published');
      const downloads = first.phases.find((phase) => phase.id === 'lab-downloads');
      checks.equal('work counters are retained', [downloads?.total, downloads?.done], [4, 1]);
      checks.equal(
        'byte counters are retained',
        [downloads?.totalBytes, downloads?.bytes],
        [100, 25],
      );
      checks.equal(
        'UI view describes the session',
        typeof describeLoadProgress(first).activity,
        'string',
      );
      checks.ok(
        'partial progress is between zero and one',
        first.fraction > 0 && first.fraction < 1,
      );
      addLoadWork('lab-downloads', { total: 4 });
      checks.ok(
        'newly discovered work does not regress progress',
        (readLoadProgress()?.fraction ?? -1) >= first.fraction,
      );
      addLoadWork('lab-downloads', { done: 7, bytes: 75 });
      addLoadWork('lab-assets', { total: 1, done: 1 });
      markLoadTimeline('feature-lab-load-ready', { session });
      const timeline = await collectLoadTimeline({ timeoutMs: 0 });
      const marks = timeline.realms
        .flatMap((realm) => realm.records)
        .filter((record) => record.detail?.session === session)
        .slice(-2);
      checks.equal(
        'timeline retains ordered marks',
        marks.map((record) => record.name),
        ['feature-lab-load-start', 'feature-lab-load-ready'],
      );
      checks.ok(
        'marks share an epoch clock',
        marks.length === 2 && (marks[1]?.start ?? -1) >= (marks[0]?.end ?? 0),
      );
      checks.ok(
        'instant marks have no duration',
        marks.every((record) => record.kind === 'mark' && record.start === record.end),
      );
    } finally {
      endLoadSession(session);
    }
    checks.equal('finished session reaches 100%', readLoadProgress()?.fraction, 1);
    checks.equal('finished state is explicit', readLoadProgress()?.finished, true);
  },
});
