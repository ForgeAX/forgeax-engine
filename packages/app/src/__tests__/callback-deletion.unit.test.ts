import { describe, expectTypeOf, it } from 'vitest';
import type { GameHost } from '../game-context';
import type { App, AppAssembleArgs, CreateAppOptions } from '../types';

describe('app callback and phantom surface deletion', () => {
  it('omits callbacks and phantom scheduling fields from public app contracts', () => {
    expectTypeOf<App>().not.toHaveProperty('registerUpdate');
    expectTypeOf<GameHost>().not.toHaveProperty('registerUpdate');
    expectTypeOf<AppAssembleArgs>().not.toHaveProperty('schedule');
    expectTypeOf<AppAssembleArgs>().not.toHaveProperty('maxDt');
    expectTypeOf<CreateAppOptions>().not.toHaveProperty('schedule');
    expectTypeOf<CreateAppOptions>().not.toHaveProperty('maxDt');
  });
});
