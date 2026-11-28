import { shouldShrinkCapacity } from './dynamic-capacity';

import { FrameKeyRoster } from './frame-key-roster';

/** The owner keeps one bounded-up-to-live-demand workspace per key domain. Published rosters
 * can outlive a resource frame. They never come back through this workspace. */
export class GpuResourcePinWorkspace<Key, Version> {
  private idle: FrameKeyRoster<Key, Version> | undefined;
  private created = 0;
  private growths = 0;

  constructor(private readonly address: (key: Key) => number) {}

  borrow(source: FrameKeyRoster<Key, Version>): FrameKeyRoster<Key, Version> {
    let roster = this.idle;
    if (roster === undefined) {
      this.created++;
      roster = new FrameKeyRoster(this.address);
    } else this.idle = undefined;
    const capacity = roster.capacity;
    roster.copy(source);
    if (roster.capacity !== capacity) this.growths++;
    return roster;
  }

  add(roster: FrameKeyRoster<Key, Version>, key: Key, version: Version): void {
    const capacity = roster.capacity;
    roster.add(key, version);
    if (roster.capacity !== capacity) this.growths++;
  }

  release(roster: FrameKeyRoster<Key, Version>, live: number): void {
    roster.clear();
    if (live === 0 || shouldShrinkCapacity(live, roster.capacity)) return;
    if (this.idle === undefined || this.idle.capacity < roster.capacity) this.idle = roster;
  }

  trim(live: number): void {
    if (live === 0 || shouldShrinkCapacity(live, this.idle?.capacity ?? 0)) this.idle = undefined;
  }

  inspect() {
    return {
      created: this.created,
      growths: this.growths,
      idleCapacity: this.idle?.capacity ?? 0,
    };
  }
}
