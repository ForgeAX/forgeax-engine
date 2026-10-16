import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as root from '../index';

const packageJsonPath = resolve(import.meta.dirname, '../../package.json');

describe('v7 public surface', () => {
  it('exposes protocol, index, model, and closed error roots', () => {
    expect(root.decodeTape).toBeTypeOf('function');
    expect(root.encodeTape).toBeTypeOf('function');
    expect(root.buildTapeIndex).toBeTypeOf('function');
    expect(root.buildFrameModel).toBeTypeOf('function');
    expect(root.buildResourceLifecycle).toBeTypeOf('function');
    expect(root.createRhiDebugError).toBeTypeOf('function');
  });

  it('declares only the v7 root and browser entry', () => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports['.']).toBeDefined();
    expect(manifest.exports['./browser']).toMatchObject({ import: './dist/browser.mjs' });
    expect(manifest.exports['./frame-model']).toBeUndefined();
    expect(manifest.exports['./resource-lifecycle']).toBeUndefined();
    expect(manifest.exports['./dev-routes']).toBeUndefined();
    expect(manifest.exports['./capture-browser']).toBeUndefined();
    expect(manifest.exports['./cli']).toBeUndefined();
    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './browser', './package.json']);
  });

  it('keeps the producer contract as the only model surface', () => {
    expect(root).not.toHaveProperty('buildViewerModel');
    expect(root).not.toHaveProperty('buildViewModel');
    expect(root).not.toHaveProperty('captureAndUpload');
    expect(root).not.toHaveProperty('uploadTape');
  });
});
