import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  commitProbeFilterStep,
  createProbeFilterState,
  type ProbeFilterState,
  probeFilterIsSteady,
} from '../reflection/filter';

const renderSystemSource = readFileSync(new URL('../render-system.ts', import.meta.url), 'utf8');
const recordOwnerPath = fileURLToPath(new URL('../reflection/record-owner.ts', import.meta.url));
const recordOwnerSource = existsSync(recordOwnerPath) ? readFileSync(recordOwnerPath, 'utf8') : '';
const inlineOwnerStart = renderSystemSource.indexOf('class ReflectionProbeRecordOwner');
const inlineOwnerEnd = renderSystemSource.indexOf(
  'export function createRenderSystem',
  inlineOwnerStart,
);
const inlineOwnerSource = renderSystemSource.slice(inlineOwnerStart, inlineOwnerEnd);
const ownerSource = recordOwnerSource.includes('class ReflectionProbeRecordOwner')
  ? recordOwnerSource
  : inlineOwnerSource;
const ownerContractsSource = `${renderSystemSource}\n${ownerSource}`;

describe('ReflectionProbeRecordOwner characterization', () => {
  it('keeps candidate resources invisible until an active generation exists', () => {
    expect(ownerSource).toContain('class ReflectionProbeRecordOwner');
    expect(ownerContractsSource).toContain('active: ProbeCubeSet | undefined;');
    expect(ownerContractsSource).toContain('candidate: ProbeCubeSet;');
    expect(ownerContractsSource).toContain('spare: ProbeCubeSet | undefined;');
    expect(ownerSource).toContain('const active = resource.activeFact?.center.every');
    expect(ownerSource).toContain('if (active === undefined) return undefined;');
    expect(ownerSource).toContain('filteredView: active.cubeView');
  });

  it('publishes only through the accepted submission completion boundary', () => {
    expect(ownerSource).toContain('resource.pending = { rawCaptureFace, step };');
    expect(ownerSource).toContain(
      'completeSubmission: (submitted, completed, fallbackOutput, fallbackRequested = true) =>',
    );
    expect(ownerSource).toContain('if (!submitted || pending === undefined) continue;');
    expect(ownerSource).toContain('resource.rawFaceCursor = Math.min(');
    expect(ownerSource).toContain(
      'resource.filter = commitProbeFilterStep(resource.filter, true);',
    );
    expect(ownerSource).toContain('resource.active = resource.candidate;');
    expect(ownerSource).toContain(
      'resource.candidate = resource.spare ?? previous ?? resource.candidate;',
    );
  });

  it('discards failed completion and preserves incremental filter state', () => {
    expect(ownerSource).toContain('fallbackRequested,');
    expect(ownerSource).toMatch(
      /if \(fallbackRequested\)\s+await this\.completeFallbackSubmission\(/,
    );
    expect(ownerSource).toContain('if (pending.step === undefined) continue;');
    expect(ownerSource).toContain('if (resource.pending !== undefined) continue;');

    const initial = createProbeFilterState({ probeIndex: 2, mipCount: 2 });
    expect(commitProbeFilterStep(initial, false)).toEqual(initial);
    const first = commitProbeFilterStep(initial, true);
    expect(first.cursor).toBe(1);
    expect(first.activeGeneration).toBe(0);
    expect(probeFilterIsSteady(first)).toBe(false);
    const complete = Array.from({ length: 11 }).reduce<ProbeFilterState>(
      (state) => commitProbeFilterStep(state, true),
      first,
    );
    expect(probeFilterIsSteady(complete)).toBe(true);
    expect(complete.activeGeneration).toBe(1);
  });

  it('resets capture work on revision changes while retaining active generation identity', () => {
    expect(ownerSource).toContain('existing.captureFact.revision !== fact.revision');
    expect(ownerSource).toContain('activeGeneration: existing.filter.activeGeneration');
    expect(ownerSource).toContain('existing.rawFaceCursor = 0;');
    expect(ownerSource).toContain('this.resources.clear();');
    expect(ownerSource).toContain('this.pipelineWarmup = undefined;');
  });

  it('does not derive one fallback snapshot from the sorted first probe', () => {
    expect(ownerSource).not.toContain('const selectedProbe = [...selections.values()]');
    expect(ownerSource).toContain('fallbackProjections');
    expect(ownerSource).toContain('renderableKey');
    expect(ownerSource).toContain('sourceKey');
    expect(ownerSource).toContain('producerId');
    expect(ownerSource).toContain('rendererId');
    expect(ownerSource).toContain('deviceGeneration');
    expect(ownerSource).toContain('frameId');
    expect(ownerSource).not.toContain('const first = this.fallbackReceipts.values()');
    expect(ownerSource).toContain('reflectionFallbackReadback');
  });

  it('selects the committed neutral row when the environment source disappears', () => {
    expect(ownerSource).toContain(
      'this.selectFallbackReceiptKey(tickets, skylight !== undefined);',
    );
    expect(ownerSource).toContain("if (!skylightAvailable && this.lastSelection.kind !== 'probe')");
    expect(ownerSource).toContain("pending.projection.source === 'neutral'");
  });

  it('keeps fallback capability and recovery facts on the same owner', () => {
    expect(ownerSource).toContain('private fallbackFormatAvailable: boolean;');
    expect(ownerSource).toContain('this.refreshFallbackCapabilities(frameId);');
    expect(ownerSource).toContain('reflection-fallback-format-unavailable');
    expect(ownerSource).toContain('retireFallbackState(frameId);');
    expect(ownerSource).toContain('reflectionFallbackInspection');
    expect(ownerSource).toContain('this.clearFallbackFailure();');
  });
});
