import type {
  DerivedPhysicsAdmissionGuard,
  DerivedPhysicsAdmissionState,
} from '@forgeax/engine-physics';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { derivedAdmissionFixture as fixture } from './fixtures/derived-admission.js';

function first<T>(rows: readonly T[]): T {
  const value = rows[0];
  if (value === undefined) throw Error('missing fixture row');
  return value;
}

describe('pre-Native derived batch admission', () => {
  it('preserves the old empty-batch Result error without invoking the guard', async () => {
    const { physics } = await fixture();
    let calls = 0;
    try {
      const old = physics.admitDerivedShapeCandidates([]);
      const guarded = physics.admitDerivedShapeCandidatesGuarded([], () => {
        calls++;
        return true;
      });
      expect(old.ok).toBe(false);
      expect(guarded.ok).toBe(false);
      expect(calls).toBe(0);
      if (!old.ok && !guarded.ok) expect(guarded.error.code).toBe(old.error.code);
    } finally {
      physics.dispose();
    }
  });
  it('rejects the original speed4 race using the complete current pre-mutation roster', async () => {
    const { physics, prepare } = await fixture();
    let calls = 0,
      commits = 0;
    let saved: readonly DerivedPhysicsAdmissionState[] | undefined;
    try {
      const candidates = prepare(),
        old = [1, 2].map((e) => physics.getDerivedPublication(e)),
        shapes = [1, 2].map((e) => physics.getDerivedShapes(e)),
        count = physics.raw.colliders.len();
      physics
        .admitDerivedShapeCandidatesGuarded(
          candidates,
          (states) => {
            calls++;
            saved = states;
            return states.every(
              (s) => s.bodyType === 'dynamic' && Math.hypot(...s.linearVelocity) < 0.08,
            );
          },
          () => {
            commits++;
            return ok(undefined);
          },
        )
        .unwrap();
      const motion = physics.getBodyMotion(1).unwrap();
      physics.setBodyMotion(1, { ...motion, linearVelocity: [4, 0, 0] }).unwrap();
      physics.step(1 / 60);
      expect([1, 2].map((e) => physics.getDerivedBodyType(e))).toEqual(['dynamic', 'dynamic']);
      expect(calls).toBe(1);
      expect(commits).toBe(0);
      expect(saved?.[0]?.linearVelocity).toEqual([4, 0, 0]);
      expect(saved?.[0]?.bodyType).toBe('dynamic');
      expect(physics.getBodyMotion(1).unwrap().linearVelocity[0]).toBe(4);
      expect([1, 2].map((e) => physics.getDerivedPublication(e))).toEqual(old);
      expect([1, 2].map((e) => physics.getDerivedShapes(e))).toEqual(shapes);
      expect(physics.raw.colliders.len()).toBe(count);
      expect(physics.getDerivedFailure(1)?.recovery).toBe('old-state-retained');
      expect(physics.getDerivedFailure(2)?.recovery).toBe('old-state-retained');
    } finally {
      physics.dispose();
    }
  });
  it('deep-freezes detached observations and fences managed writes, cancellation, dispose and step reentry', async () => {
    const { physics, prepare } = await fixture();
    let commits = 0;
    let saved: readonly DerivedPhysicsAdmissionState[] | undefined;
    try {
      const candidates = prepare();
      physics
        .admitDerivedShapeCandidatesGuarded(
          candidates,
          (states) => {
            saved = states;
            expect(states.map((s) => s.source)).toEqual([
              { sourceKey: 'body:1', revision: 1 },
              { sourceKey: 'body:2', revision: 1 },
            ]);
            expect(Object.isFrozen(states)).toBe(true);
            expect(Object.isFrozen(states[0]?.position)).toBe(true);
            expect(Object.isFrozen(states[0]?.source)).toBe(true);
            expect(() => physics.step(1 / 60)).toThrow(/reenter/);
            expect(() =>
              physics.setBodyMotion(1, { ...first(states), linearVelocity: [3, 0, 0] }),
            ).toThrow(/reenter/);
            expect(() => physics.cancelDerivedShapeCandidate(first(candidates))).toThrow(/reenter/);
            expect(() => physics.invalidateDerivedShapeCandidates()).toThrow(/reenter/);
            expect(() => physics.finalizeDerivedFixedStep()).toThrow(/reenter/);
            expect(() => physics.dispose()).toThrow();
            expect(physics.getDerivedAdmission()).toBeUndefined();
            return true;
          },
          () => {
            commits++;
            expect(() => physics.getBodyMotion(1)).toThrow();
            return ok(undefined);
          },
        )
        .unwrap();
      physics.step(1 / 60);
      expect(commits).toBe(1);
      expect([1, 2].map((e) => physics.getDerivedBodyType(e))).toEqual(['static', 'static']);
      expect(saved?.[0]?.bodyType).toBe('dynamic');
    } finally {
      physics.dispose();
    }
  });
  it.each([
    'false',
    'throw',
    'async',
  ] as const)('rejects %s without executing the later paired commit or losing retry ownership', async (mode) => {
    const { physics, prepare } = await fixture();
    let commits = 0;
    try {
      const guard = (() => {
        if (mode === 'throw') throw Error('veto');
        if (mode === 'async') return Promise.reject(Error('async veto'));
        return false;
      }) as unknown as DerivedPhysicsAdmissionGuard;
      physics
        .admitDerivedShapeCandidatesGuarded(prepare(), guard, () => {
          commits++;
          return ok(undefined);
        })
        .unwrap();
      physics.step(1 / 60);
      await Promise.resolve();
      expect(commits).toBe(0);
      expect(physics.getDerivedBodyType(1)).toBe('dynamic');
      expect(physics.getDerivedRecoveryState()).toBe('ready');
      physics
        .admitDerivedShapeCandidatesGuarded(
          prepare(),
          () => true,
          () => ok(undefined),
        )
        .unwrap();
      physics.step(1 / 60);
      expect(physics.getDerivedBodyType(1)).toBe('static');
    } finally {
      physics.dispose();
    }
  });
  it('refuses partial preparation rosters without consuming the complete group', async () => {
    const { physics, prepare } = await fixture();
    try {
      const candidates = prepare();
      expect(physics.admitDerivedShapeCandidatesGuarded([first(candidates)], () => true).ok).toBe(
        false,
      );
      expect(candidates.map((c) => c.state)).toEqual(['ready', 'ready']);
      physics.admitDerivedShapeCandidatesGuarded(candidates, () => true).unwrap();
      physics.step(1 / 60);
      expect([1, 2].map((e) => physics.getDerivedBodyType(e))).toEqual(['static', 'static']);
    } finally {
      physics.dispose();
    }
  });

  it('does not run a cancelled guard and preserves the later paired rollback boundary', async () => {
    const { physics, prepare } = await fixture();
    let calls = 0;
    try {
      const cancelled = prepare();
      physics
        .admitDerivedShapeCandidatesGuarded(cancelled, () => {
          calls++;
          return true;
        })
        .unwrap();
      physics.cancelDerivedShapeCandidate(first(cancelled)).unwrap();
      physics.step(1 / 60);
      expect(calls).toBe(0);
      physics
        .admitDerivedShapeCandidatesGuarded(
          prepare(),
          () => true,
          () => err(Error('late actor/wake veto')),
        )
        .unwrap();
      physics.step(1 / 60);
      expect([1, 2].map((e) => physics.getDerivedBodyType(e))).toEqual(['dynamic', 'dynamic']);
      expect(physics.getDerivedRecoveryState()).toBe('ready');
    } finally {
      physics.dispose();
    }
  });
});

it('admits a local body policy without enumerating unrelated committed sources', async () => {
  const { physics, prepare } = await fixture();
  const sources = (physics as unknown as { derivedBodySources: Map<number, unknown> })
    .derivedBodySources;
  const traversal = vi.spyOn(sources, Symbol.iterator);
  try {
    const candidates = prepare();
    physics.admitDerivedShapeCandidates(candidates).unwrap();
    physics.step(1 / 60);
    expect(physics.getDerivedBodyType(1)).toBe('static');
    expect(physics.getDerivedBodyType(2)).toBe('static');
    expect(traversal).not.toHaveBeenCalled();
  } finally {
    traversal.mockRestore();
    physics.dispose();
  }
});

it('publishes local bodies without scanning the resident body roster or consuming an unadmitted peer', async () => {
  const { physics, prepare } = await fixture(3);
  const peer = physics.getDerivedPublication(3);
  if (!peer) throw Error('Missing peer publication');
  const held = physics
    .prepareDerivedBodyTypeCandidates([{ publication: peer, bodyType: 'dynamic' }])
    .unwrap();
  const bodies = (physics as unknown as { derivedBodies: Map<number, unknown> }).derivedBodies;
  const traversal = vi.spyOn(bodies, 'values');
  try {
    physics.admitDerivedShapeCandidates(prepare()).unwrap();
    physics.step(1 / 60);
    expect(physics.getDerivedBodyType(1)).toBe('static');
    expect(physics.getDerivedBodyType(2)).toBe('static');
    expect(physics.getDerivedPublication(3)).toBe(peer);
    expect(traversal).not.toHaveBeenCalled();
    physics.admitDerivedShapeCandidates(held).unwrap();
    physics.step(1 / 60);
    expect(physics.getDerivedBodyType(3)).toBe('dynamic');
  } finally {
    traversal.mockRestore();
    physics.dispose();
  }
});

it('keeps an unchanged collision-isolation policy independent of the resident entity roster', async () => {
  const { physics } = await fixture();
  const entities = (physics as unknown as { entityMap: Map<number, unknown> }).entityMap;
  const traversal = vi.spyOn(entities, Symbol.iterator);
  try {
    physics.step(1 / 60);
    expect(traversal).not.toHaveBeenCalled();
  } finally {
    traversal.mockRestore();
    physics.dispose();
  }
});

it('preserves explicit Native sleep on a new body without an isolation policy change', async () => {
  const { physics } = await fixture();
  try {
    physics.ensureBody(
      3,
      {
        position: { x: 30, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      { type: 1, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
      undefined,
    );
    physics.raw.forEachRigidBody((body: { userData: unknown; sleep(): void }) => {
      if (body.userData === 3) body.sleep();
    });
    expect(physics.getBodyMotion(3).unwrap().sleeping).toBe(true);
    physics.step(1 / 60);
    expect(physics.getBodyMotion(3).unwrap().sleeping).toBe(true);
  } finally {
    physics.dispose();
  }
});
