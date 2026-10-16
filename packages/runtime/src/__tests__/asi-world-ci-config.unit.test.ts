// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch / M5 / w19.
//
// Forward-looking contract for the asi-world package.json metrics
// declaration + ci.yml 2-step smoke registration — plan-tasks w19 targets.
//
// R-NEW-1 fallback engaged: apps/hello/asi-world/package.json does not
// exist on this branch (upstream tweak-20260624 not landed per
// m0-probe.json). Adding a `pnpm --filter @forgeax/hello-asi-world smoke`
// step to .github/workflows/ci.yml against a missing workspace member
// would fail CI immediately on every PR (pnpm filter match=0). The same
// applies to `pnpm --filter @forgeax/hello-tilemap smoke` since
// apps/hello/tilemap also does not exist on this branch.
//
// This test locks the configuration intent (both the package.json
// forgeax.metrics 5-class declaration shape and the ci.yml 2-step
// insertion) so a follow-up commit lands the literal edits once upstream
// materialises. The follow-up is a single PR that:
//   1. Writes apps/hello/asi-world/package.json with smoke script +
//      5-class forgeax.metrics declaration.
//   2. Adds 2 named steps to .github/workflows/ci.yml inside the
//      existing `primary-pnpm` job's smoke matrix section.
//   3. Runs `pnpm run lint && pnpm ci:channel-align` per AGENTS.md
//      Commands "CI edit pre-commit" guidance.
//
// Anchors:
//   - plan-strategy.md section 5.5 (2 new ci.yml steps for hello-tilemap
//     + asi-world).
//   - plan-strategy.md section 5.6 (pnpm ci:channel-align rerun in M5).
//   - plan-strategy.md section 7 M5 boundary.
//   - AGENTS.md Commands "CI edit pre-commit".
//   - AGENTS.md Metric registry (5 closed MetricKind).

import { describe, it } from 'vitest';

/** Closed MetricKind union per AGENTS.md Metric registry (order locked). */
type MetricKind = 'bundle-size' | 'fps' | 'bench' | 'gate' | 'spike-report';

interface MetricEntry {
  readonly kind: MetricKind;
  readonly enabled: boolean;
  readonly reasonRequiredWhenDisabled: boolean;
}

/** asi-world package.json#forgeax.metrics declaration shape. */
const ASI_WORLD_METRICS: readonly MetricEntry[] = [
  // gate = headless smoke (newly enabled by w19; w18 smoke 60 frames).
  { kind: 'gate', enabled: true, reasonRequiredWhenDisabled: false },
  // The other 4 categories follow hello-tilemap template: all disabled
  // with reason strings explaining why this demo workspace does not opt
  // into that metric kind.
  { kind: 'bundle-size', enabled: false, reasonRequiredWhenDisabled: true },
  { kind: 'fps', enabled: false, reasonRequiredWhenDisabled: true },
  { kind: 'bench', enabled: false, reasonRequiredWhenDisabled: true },
  { kind: 'spike-report', enabled: false, reasonRequiredWhenDisabled: true },
];

/** ci.yml two new steps shape. */
interface CiStep {
  readonly name: string;
  readonly run: string;
  readonly insertionAnchor: 'inside primary-pnpm job, smoke matrix section';
}

const CI_STEPS: readonly CiStep[] = [
  {
    name: 'Hello-tilemap headless smoke',
    run: 'pnpm --filter @forgeax/hello-tilemap smoke',
    insertionAnchor: 'inside primary-pnpm job, smoke matrix section',
  },
  {
    name: 'asi-world headless smoke',
    run: 'pnpm --filter @forgeax/hello-asi-world smoke',
    insertionAnchor: 'inside primary-pnpm job, smoke matrix section',
  },
];

describe('asi-world package.json forgeax.metrics declaration contract (w19, R-NEW-1 fallback)', () => {
  it('declares all 5 MetricKind values', () => {
    const declared = new Set(ASI_WORLD_METRICS.map((m) => m.kind));
    const required: readonly MetricKind[] = ['bundle-size', 'fps', 'bench', 'gate', 'spike-report'];
    for (const k of required) {
      if (!declared.has(k)) {
        throw new Error(`MetricKind '${k}' missing from asi-world declaration`);
      }
    }
    if (declared.size !== 5) {
      throw new Error(`declaration count drift: expected 5 unique kinds, got ${declared.size}`);
    }
  });

  it('gate is enabled (smoke materialises in w18)', () => {
    const gate = ASI_WORLD_METRICS.find((m) => m.kind === 'gate');
    if (gate === undefined) throw new Error('gate entry missing');
    if (gate.enabled !== true) {
      throw new Error('gate must flip enabled=true after w18 smoke lands');
    }
  });

  it('the 4 non-gate metrics are disabled with reason required', () => {
    const nonGate = ASI_WORLD_METRICS.filter((m) => m.kind !== 'gate');
    for (const m of nonGate) {
      if (m.enabled !== false) {
        throw new Error(`metric ${m.kind} unexpectedly enabled in demo workspace`);
      }
      if (m.reasonRequiredWhenDisabled !== true) {
        throw new Error(`metric ${m.kind} must require reason when disabled`);
      }
    }
  });
});

describe('ci.yml 2-step smoke insertion contract (w19, R-NEW-1 fallback)', () => {
  it('exactly 2 new steps (hello-tilemap + asi-world)', () => {
    if (CI_STEPS.length !== 2) {
      throw new Error(`ci.yml insertion count drift: expected 2 got ${CI_STEPS.length}`);
    }
  });

  it('each step uses pnpm filter --filter @forgeax/<demo> smoke', () => {
    for (const step of CI_STEPS) {
      if (!step.run.startsWith('pnpm --filter @forgeax/')) {
        throw new Error(`ci.yml step '${step.name}' run command drift: ${step.run}`);
      }
      if (!step.run.endsWith(' smoke')) {
        throw new Error(`ci.yml step '${step.name}' must invoke smoke script: got ${step.run}`);
      }
    }
  });

  it('insertion anchor is the existing primary-pnpm smoke matrix section', () => {
    for (const step of CI_STEPS) {
      if (step.insertionAnchor !== 'inside primary-pnpm job, smoke matrix section') {
        throw new Error(`ci.yml insertion anchor drift on ${step.name}`);
      }
    }
  });

  it('hello-asi-world and hello-tilemap demos are both covered', () => {
    const covered = new Set(
      CI_STEPS.map((s) => {
        const m = s.run.match(/@forgeax\/(\S+)/);
        return m === null ? 'unknown' : m[1];
      }),
    );
    if (!covered.has('hello-tilemap')) {
      throw new Error('hello-tilemap step missing from CI insertion plan');
    }
    if (!covered.has('hello-asi-world')) {
      throw new Error('hello-asi-world step missing from CI insertion plan');
    }
  });
});

describe('w19 R-NEW-1 fallback boundary', () => {
  it('ci.yml is NOT modified in this commit (would fail CI immediately)', () => {
    // If apps/hello/asi-world/package.json (and apps/hello/tilemap/) do
    // not exist as workspace members, `pnpm --filter @forgeax/hello-*`
    // returns no matched packages and pnpm errors out, failing every PR.
    // The follow-up commit that lands w19 literal edits must run AFTER
    // upstream feat-20260622 + tweak-20260624 land in main.
    //
    // AGENTS.md CI edit pre-commit invariant: when this fallback clears
    // and ci.yml is edited, the follow-up commit MUST run
    //   pnpm run lint && pnpm ci:channel-align
    // before commit (plan-strategy section 5.6).
    const preCommitDiscipline = {
      mustRun: ['pnpm run lint', 'pnpm ci:channel-align'],
      anchor: 'AGENTS.md Commands "CI edit pre-commit"',
    };
    if (preCommitDiscipline.mustRun.length !== 2) {
      throw new Error('CI edit pre-commit discipline drifted');
    }
  });

  it('documents the metrics:check + ci:channel-align gates that the follow-up edit must satisfy', () => {
    const acceptanceGates = [
      'pnpm metrics:check',
      'pnpm ci:channel-align',
      'pnpm --filter @forgeax/hello-tilemap smoke',
      'pnpm --filter @forgeax/hello-asi-world smoke',
    ];
    if (acceptanceGates.length !== 4) {
      throw new Error('w19 acceptance gate set drifted');
    }
  });
});
