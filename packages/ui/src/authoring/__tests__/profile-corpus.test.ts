import { describe, expect, it } from 'vitest';
import { classifyUiAuthoring, validateUiAuthoring } from '../index.js';
import {
  invalidProfileCorpus,
  profileCorpus,
  validProfileCorpus,
} from './fixtures/profile-corpus.js';

describe('UiAuthoringProfile corpus', () => {
  it('contains at least twenty valid and twenty invalid cases', () => {
    expect(validProfileCorpus.length).toBeGreaterThanOrEqual(20);
    expect(invalidProfileCorpus.length).toBeGreaterThanOrEqual(20);
  });

  it.each(profileCorpus)('classifies $name exactly once', (entry) => {
    const result = classifyUiAuthoring({
      sourcePath: `${entry.name}.ui.html`,
      html: entry.html,
      css: entry.css,
    });
    expect(result.category).toBe(entry.expectation);
    expect(result.blocking).toBe(entry.blocking);
    expect(new Set([result.category]).size).toBe(1);
  });

  it.each(validProfileCorpus)('keeps accepted source bytes unchanged for $name', async (entry) => {
    const result = await validateUiAuthoring({
      sourcePath: `${entry.name}.ui.html`,
      html: entry.html,
      css: entry.css,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.html).toBe(entry.html);
    expect(result.value.css).toBe(entry.css);
    expect(
      result.value.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
    ).toHaveLength(0);
  });

  it.each(
    invalidProfileCorpus,
  )('returns structured blocking diagnostics for $name', async (entry) => {
    const result = await validateUiAuthoring({
      sourcePath: `${entry.name}.ui.html`,
      html: entry.html,
      css: entry.css,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('source-validation-failed');
    expect('diagnostics' in result.error.detail).toBe(true);
    if (!('diagnostics' in result.error.detail)) return;
    expect(
      result.error.detail.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(result.error.detail))).toEqual(result.error.detail);
  });

  it('keeps quality warnings non-blocking', async () => {
    const warningCases = profileCorpus.filter((entry) => entry.warningCodes !== undefined);
    for (const entry of warningCases) {
      const result = await validateUiAuthoring({
        sourcePath: `${entry.name}.ui.html`,
        html: entry.html,
        css: entry.css,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(
        result.value.diagnostics
          .filter((diagnostic) => diagnostic.severity === 'warning')
          .map((diagnostic) => diagnostic.code),
      ).toEqual(expect.arrayContaining([...(entry.warningCodes ?? [])]));
    }
  });
});
