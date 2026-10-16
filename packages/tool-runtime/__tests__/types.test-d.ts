import { defineToolCapability } from '../src/index.js';
import { expectTypeOf } from 'vitest';
import type {
  ArtifactRef,
  SnapshotRef,
  ToolCapabilityResult,
  ToolContribution,
  ToolRuntimeError,
  ToolTerminal,
} from '../src/index.js';

const answer = defineToolCapability<{ readonly value: number }>('fixture.answer');
declare const resolution: ToolCapabilityResult<{ readonly value: number }>;
if (resolution.ok) {
  expectTypeOf(resolution.value.value).toEqualTypeOf<number>();
}
expectTypeOf(answer.id).toEqualTypeOf<string>();

type Success = Extract<ToolTerminal<string>, { outcome: 'succeeded' }>;

const snapshot: SnapshotRef = { revision: 1, digest: 'sha256:snapshot' };
const artifact: ArtifactRef = {
  kind: 'rhi-tape',
  digest: 'sha256:tape',
  uri: 'file:///tmp/tape.json',
};
const terminal: Success = {
  outcome: 'succeeded',
  result: 'ok',
  snapshotAfter: snapshot,
  artifacts: [artifact],
};

expectTypeOf<ToolContribution<string, string>['descriptor']['id']>().toEqualTypeOf<string>();
expectTypeOf<ToolContribution<string, string>['execute']>().parameter(0).toEqualTypeOf<string>();
expectTypeOf(terminal.result).toEqualTypeOf<string>();
expectTypeOf(terminal.artifacts).toEqualTypeOf<readonly ArtifactRef[]>();
expectTypeOf<ToolRuntimeError['code']>().toEqualTypeOf<
  | 'tool-invalid-args'
  | 'tool-capability-unavailable'
  | 'tool-snapshot-stale'
  | 'tool-artifact-incomplete'
  | 'tool-run-cancelled'
  | 'tool-run-timeout'
  | 'tool-run-disconnected'
  | 'tool-run-terminal'
  | 'tool-catalog-stale'
  | 'tool-cleanup-failed'
  | 'tool-domain-failed'
  | 'tool-bootstrap-not-clone-safe'
  | 'tool-migration-live-state'
  | 'tool-artifact-manifest-invalid'
>();
