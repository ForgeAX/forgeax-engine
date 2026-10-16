/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CanvasInputBoundary } from '../canvas-input-boundary.js';

type CanvasInputOwner = ReturnType<CanvasInputBoundary['owner']>;
type ExpectedCanvasInputOwner = 'editor' | 'game';

const canvasInputBoundarySource = readFileSync(
  new URL('../canvas-input-boundary.ts', import.meta.url),
  'utf8',
);

describe('canvas input owner', () => {
  it('keeps the public owner vocabulary exact and bilateral', () => {
    expectTypeOf<CanvasInputOwner>().toEqualTypeOf<ExpectedCanvasInputOwner>();
    expectTypeOf<ExpectedCanvasInputOwner>().toEqualTypeOf<CanvasInputOwner>();
    expectTypeOf<CanvasInputBoundary['owner']>().toEqualTypeOf<() => ExpectedCanvasInputOwner>();

    const acceptsOwner = (owner: CanvasInputOwner): CanvasInputOwner => owner;
    acceptsOwner('editor');
    acceptsOwner('game');
    // @ts-expect-error Unknown roles remain outside the closed owner vocabulary.
    acceptsOwner('preview');
  });

  it('derives both private consumer views from the public owner method', () => {
    expect(canvasInputBoundarySource).toContain(
      "type CanvasInputOwner = ReturnType<CanvasInputBoundary['owner']>;",
    );
    expect(canvasInputBoundarySource).toContain("let active: CanvasInputOwner = 'editor';");
    expect(canvasInputBoundarySource).toContain(
      'const routed = (consumer: CanvasInputOwner): InputBackend => ({',
    );
    expect(canvasInputBoundarySource).not.toContain("let active: 'editor' | 'game'");
    expect(canvasInputBoundarySource).not.toContain("const routed = (consumer: 'editor' | 'game')");
  });
});
