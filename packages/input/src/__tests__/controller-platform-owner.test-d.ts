/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ControllerPlatform } from '../controller-db.js';
import { platformFromUserAgent } from '../controller-db.js';

type ExpectedControllerPlatform = 'Windows' | 'Mac OS X' | 'Linux' | 'Android' | 'iOS';

const controllerDbSource = readFileSync(new URL('../controller-db.ts', import.meta.url), 'utf8');

describe('controller platform owner', () => {
  it('keeps the exact public membership and producer declaration', () => {
    expectTypeOf<ControllerPlatform>().toEqualTypeOf<ExpectedControllerPlatform>();
    expectTypeOf<ExpectedControllerPlatform>().toEqualTypeOf<ControllerPlatform>();
    expectTypeOf(platformFromUserAgent).toEqualTypeOf<
      (ua: string) => ControllerPlatform | undefined
    >();

    const acceptsPlatform = (platform: ControllerPlatform): ControllerPlatform => platform;
    acceptsPlatform('Windows');
    acceptsPlatform('Mac OS X');
    acceptsPlatform('Linux');
    acceptsPlatform('Android');
    acceptsPlatform('iOS');
    // @ts-expect-error unknown platform labels remain outside the closed union.
    acceptsPlatform('platform-not-real');
  });

  it('derives the public union and user-agent output from one private tuple', () => {
    expect(controllerDbSource).toContain(
      "const CONTROLLER_PLATFORMS = ['Windows', 'Mac OS X', 'Linux', 'Android', 'iOS'] as const;",
    );
    expect(controllerDbSource).toContain(
      'export type ControllerPlatform = (typeof CONTROLLER_PLATFORMS)[number];',
    );
    expect(controllerDbSource).toContain('return CONTROLLER_PLATFORMS[4];');
    expect(controllerDbSource).toContain('return CONTROLLER_PLATFORMS[3];');
    expect(controllerDbSource).toContain('return CONTROLLER_PLATFORMS[0];');
    expect(controllerDbSource).toContain('return CONTROLLER_PLATFORMS[1];');
    expect(controllerDbSource).toContain('return CONTROLLER_PLATFORMS[2];');
    expect(controllerDbSource).not.toContain(
      "export type ControllerPlatform = 'Windows' | 'Mac OS X' | 'Linux' | 'Android' | 'iOS';",
    );
  });
});
