import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RenderFeatureCapabilityMissingError,
  RenderFeaturePassOrderConflictError,
  RenderFeatureRegistrationConflictError,
  RenderFeatureStageFailedError,
} from '../errors/render';

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const renderReadme = read('../../README.md');
const runtimeReadme = read('../../../runtime/README.md');
const appSkill = read('../../../../skills/forgeax-engine-app/SKILL.md');

const firstReadHeading = '## RenderFeature: the producer seam (first-read index)';
const firstReadStart = renderReadme.indexOf(firstReadHeading);
const firstReadEnd = renderReadme.indexOf('\n## ', firstReadStart + firstReadHeading.length);
const topSurface = renderReadme.slice(
  firstReadStart,
  firstReadEnd === -1 ? undefined : firstReadEnd,
);
const searchableTopSurface = topSurface.replace(/\s+/g, ' ');

describe('RenderFeature documentation surface', () => {
  it('keeps the first-read public route and four-term vocabulary indexable', () => {
    for (const token of [
      '## RenderFeature: the producer seam',
      'type FrameData',
      'createRenderer(canvas, { features: [feature] })',
      'plan(data, context)',
      'named resources and passes',
      'active RenderGraph',
      'RenderFeature',
      'Standard Pipeline',
      'RenderGraph pass',
    ]) {
      expect(searchableTopSurface).toContain(token);
    }
    expect(searchableTopSurface).not.toContain('passContext.commands');
    expect(searchableTopSurface).not.toContain('context.staging.addPass');
    expect(searchableTopSurface).not.toContain('graph-only Wave 1 feature');
    expect(runtimeReadme).toContain('createRenderer(canvas, options?, bundler?)');
    expect(appSkill).toContain('Renderer feature assembly');
  });

  it('indexes capability, structured error, recovery, disposal, and pipeline switching', () => {
    const surface = `${renderReadme}\n${runtimeReadme}\n${appSkill}`;
    for (const token of [
      'Readonly<RhiCaps>',
      'RenderError',
      'error.code',
      'error.hint',
      'error.detail',
      'renderer.subscribe()',
      'renderer.inspect()',
      'renderer.recover()',
      'renderer.dispose()',
      'RenderFeaturePlan',
    ]) {
      expect(surface).toContain(token);
    }
  });

  it('keeps the error hint actions aligned with the recovery matrix', () => {
    const cases = [
      {
        error: new RenderFeatureRegistrationConflictError('test.feature', 1, 0),
        recoveryToken: 'registration',
      },
      {
        error: new RenderFeatureStageFailedError('test.feature', 1, 'prepare', 'next-frame'),
        recoveryToken: 'next frame',
      },
      {
        error: new RenderFeatureCapabilityMissingError('test.feature', 1, 'compute'),
        recoveryToken: 'capability',
      },
      {
        error: new RenderFeaturePassOrderConflictError('test.feature', 1, 'overlay', 'main'),
        recoveryToken: 'reorder',
      },
    ];

    for (const { error, recoveryToken } of cases) {
      expect(error.hint.toLowerCase()).toContain(recoveryToken);
      expect(`${renderReadme}\n${runtimeReadme}\n${appSkill}`.toLowerCase()).toContain(
        recoveryToken,
      );
    }
  });
});
