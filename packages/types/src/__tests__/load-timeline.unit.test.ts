import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindLoadProgressScope } from '../load-progress.js';
import {
  beginLoadTimeline,
  collectLoadTimeline,
  LOAD_TIMELINE_CAPACITY,
  type LoadTimelineRealmSnapshot,
  markLoadTimeline,
  recordLoadTimeline,
  snapshotLoadTimeline,
} from '../load-timeline.js';

type TimelineGlobal = typeof globalThis & {
  __forgeaxLoadTimelineBuffer?: { channel?: { close(): void }; records: unknown[] };
  __forgeaxLoadTimeline?: unknown;
  __forgeaxLoadProgress?: { channel?: { close(): void } };
};

afterEach(() => {
  const scope = globalThis as TimelineGlobal;
  scope.__forgeaxLoadTimelineBuffer?.channel?.close();
  delete scope.__forgeaxLoadTimelineBuffer;
  delete scope.__forgeaxLoadTimeline;
  scope.__forgeaxLoadProgress?.channel?.close();
  delete scope.__forgeaxLoadProgress;
  vi.unstubAllGlobals();
});

describe('load timeline', () => {
  it('records marks and spans on one epoch clock and installs the inspection global', () => {
    const before = performance.timeOrigin + performance.now();
    markLoadTimeline('home-ready', { screen: 'home' });
    const end = beginLoadTimeline('pipeline', 'gbuffer', { mode: 'async' });
    end(undefined, { kind: 'render' });
    end(); // A second completion never records twice.
    const snapshot = snapshotLoadTimeline();
    expect(snapshot.realm).toBe('worker');
    expect(snapshot.records.map((r) => [r.kind, r.name])).toEqual([
      ['mark', 'home-ready'],
      ['pipeline', 'gbuffer'],
    ]);
    const [mark, pipeline] = snapshot.records;
    expect(mark?.start).toBe(mark?.end);
    expect(mark?.start).toBeGreaterThanOrEqual(before);
    expect(pipeline?.detail).toEqual({ mode: 'async', kind: 'render' });
    expect((globalThis as TimelineGlobal).__forgeaxLoadTimeline).toMatchObject({
      collect: collectLoadTimeline,
      mark: markLoadTimeline,
    });
  });

  it('bounds each realm and counts dropped records instead of growing', () => {
    for (let index = 0; index < LOAD_TIMELINE_CAPACITY + 3; index++) {
      recordLoadTimeline('fetch', `u${index}`, 0, 1, 10);
    }
    const snapshot = snapshotLoadTimeline();
    expect(snapshot.records).toHaveLength(LOAD_TIMELINE_CAPACITY);
    expect(snapshot.dropped).toBe(3);
  });

  it('omits non-finite byte counts', () => {
    recordLoadTimeline('fetch', 'a', 0, 1, Number.NaN);
    expect('bytes' in (snapshotLoadTimeline().records[0] ?? {})).toBe(false);
  });

  it('records unscoped native work without opening a channel', async () => {
    const Channel = vi.fn(() => ({ onmessage: null, postMessage() {}, close() {} }));
    vi.stubGlobal('BroadcastChannel', Channel);
    markLoadTimeline('native');
    expect((await collectLoadTimeline({ timeoutMs: 10 })).realms).toHaveLength(1);
    expect(Channel).not.toHaveBeenCalled();
  });

  it('collects its page realms and excludes another page on the same origin', async () => {
    // Worker imports can record work before the page binds its existing progress scope.
    markLoadTimeline('before-binding');
    bindLoadProgressScope('timeline-page-a');
    markLoadTimeline('local');
    const remote = new BroadcastChannel('forgeax:load-timeline:timeline-page-a');
    const otherPage = new BroadcastChannel('forgeax:load-timeline:timeline-page-b');
    const unscopedPage = new BroadcastChannel('forgeax:load-timeline');
    const snapshot: LoadTimelineRealmSnapshot = {
      realm: 'forgeax-render',
      timeOrigin: 1,
      dropped: 0,
      records: [
        { kind: 'shader', name: 'm', realm: 'forgeax-render', start: 2, end: 3, bytes: 40 },
      ],
    };
    remote.onmessage = (event: { readonly data: { type: string; id: string } }) => {
      if (event.data.type === 'collect')
        remote.postMessage({ type: 'snapshot', id: event.data.id, snapshot });
    };
    const unrelated = (channel: BroadcastChannel) => {
      channel.onmessage = (event: { readonly data: { type: string; id: string } }) => {
        if (event.data.type === 'collect')
          channel.postMessage({
            type: 'snapshot',
            id: event.data.id,
            snapshot: { ...snapshot, realm: 'unrelated-page' },
          });
      };
    };
    unrelated(otherPage);
    unrelated(unscopedPage);
    try {
      const collected = await collectLoadTimeline({ timeoutMs: 100 });
      expect(collected.version).toBe(1);
      expect(collected.realms.map((realm) => realm.realm)).toEqual(['worker', 'forgeax-render']);
      expect(collected.realms[1]?.records[0]?.bytes).toBe(40);
      expect(collected.realms[0]?.records.map((record) => record.name)).toEqual([
        'before-binding',
        'local',
      ]);
    } finally {
      remote.close();
      otherPage.close();
      unscopedPage.close();
    }
  });

  it('returns only the local realm when collection is not awaited', async () => {
    markLoadTimeline('local');
    const collected = await collectLoadTimeline({ timeoutMs: 0 });
    expect(collected.realms).toHaveLength(1);
  });
});
