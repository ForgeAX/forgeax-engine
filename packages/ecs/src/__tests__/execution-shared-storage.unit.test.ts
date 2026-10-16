import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

const Position = defineComponent('ExecutionSharedStoragePosition', { x: 'f32', y: 'f32' });

describe('shared World storage', () => {
  it('allocates dense numeric QuerySpan fields on SAB and preserves them through growth', () => {
    const world = new World({ storage: 'shared' });
    for (let index = 0; index < 80; index += 1) {
      world.spawn({ component: Position, data: { x: index, y: -index } }).unwrap();
    }
    const spans = [
      ...world
        .query({ write: [Position] })
        .unwrap()
        .spans()
        .unwrap(),
    ];
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.mut(Position).x.buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(span.mut(Position).y.buffer).toBeInstanceOf(SharedArrayBuffer);
    }
    expect(spans.reduce((sum, span) => sum + span.length, 0)).toBe(80);
  });

  it('keeps default World columns local', () => {
    const world = new World();
    world.spawn({ component: Position, data: { x: 1, y: 2 } }).unwrap();
    const span = [
      ...world
        .query({ read: [Position] })
        .unwrap()
        .spans()
        .unwrap(),
    ][0];
    expect(span?.get(Position).x.buffer).toBeInstanceOf(ArrayBuffer);
  });
});
