import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import {
  type CustomStandardSurfaceOptions,
  type DefaultStandardOptions,
  Materials,
  type StandardOptions,
} from '../materials';

const parameters = [{ name: 'ironColor', type: 'color' as const }];
const values = { ironColor: [0.4, 0.45, 0.47, 1] as const };

describe('Standard Surface authoring union', () => {
  it('exposes one callable Parameters union for default and custom options', () => {
    const defaultOptions = { baseColor: [1, 1, 1, 1] as const } satisfies DefaultStandardOptions;
    const customOptions = {
      surfaceModule: 'game_3d::rusted_iron_surface',
      parameters,
      values,
    } satisfies CustomStandardSurfaceOptions;
    expectTypeOf<Parameters<typeof Materials.standard>[0]>().toEqualTypeOf<StandardOptions>();

    function acceptStandard<T extends StandardOptions>(options: T): T {
      return options;
    }

    acceptStandard(defaultOptions);
    acceptStandard(customOptions);
  });

  it('accepts a custom Surface without convenience fields', () => {
    const options = {
      surfaceModule: 'game_3d::rusted_iron_surface',
      parameters,
      values,
    } satisfies CustomStandardSurfaceOptions;
    const material = Materials.standard(options);
    expectTypeOf(material.passes?.[0]?.program.moduleSlots?.surface).toBeString;
  });

  it('keeps default and custom options mutually exclusive', () => {
    expectTypeOf<DefaultStandardOptions>().toHaveProperty('baseColor');
    Materials.standard({
      surfaceModule: 'game_3d::rusted_iron_surface',
      parameters,
      values,
      // @ts-expect-error Custom Surface options cannot add Standard convenience fields.
      baseColor: [1, 1, 1, 1],
    });
  });

  it('keeps custom Surface parameters sparse and root-owned', () => {
    const custom = Materials.standard({
      surfaceModule: 'game_3d::rusted_iron_surface',
      parameters,
      values,
    });
    expectTypeOf(custom.parameters).toEqualTypeOf<MaterialAsset['parameters']>();
    expectTypeOf(custom.values).toEqualTypeOf<MaterialAsset['values']>();
  });
});
