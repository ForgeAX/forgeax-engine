import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const demoRoot = resolve(import.meta.dirname, '../..');
const dawnSmoke = readFileSync(resolve(demoRoot, 'scripts/smoke-dawn.mjs'), 'utf8');
const browserSmoke = readFileSync(resolve(demoRoot, 'scripts/smoke-browser.mjs'), 'utf8');

describe('Boss Lightning visual evidence contract', () => {
  it('keeps deterministic canvas evidence in both smoke paths', () => {
    expect(dawnSmoke).toContain('SEED = 42');
    expect(dawnSmoke).toContain('copyTextureToBuffer');
    expect(browserSmoke).toContain('seed: 42');
    expect(browserSmoke).toContain('boss-lightning');
  });

  it('declares all Batch B expectations and image-read fields', () => {
    for (const id of [
      'advanced-renderers-visible',
      'live-patch-continuity',
      'event-sub-emitter-visible',
      'hmr-last-known-good-visible',
    ]) {
      expect(browserSmoke).toContain(id);
    }
    expect(browserSmoke).toContain('observed');
    expect(browserSmoke).toContain('verdict');
    expect(browserSmoke).toContain('confidence');
    expect(browserSmoke).toContain('screenshot');
  });
});
