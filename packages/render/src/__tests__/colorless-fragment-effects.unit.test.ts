import { createMaterialShaderProgram } from '@forgeax/engine-shader';
import type { MaterialProgramAbi } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { colorlessFragmentEntry } from '../material-stage-constants';

const receipt = { materialRow: { fields: [] } } as unknown as MaterialProgramAbi;
const clear = {
  mayDiscard: false,
  writesDepth: false,
  writesSampleMask: false,
  writesStorage: false,
};
const selected = (effects?: typeof clear) =>
  createMaterialShaderProgram('', [
    {
      name: 'fs_ao_input',
      stage: 'fragment',
      bindings: [],
      ...(effects === undefined ? {} : { effects }),
    },
    // A different entry's effects cannot disqualify this selected entry.
    { name: 'fs_main', stage: 'fragment', bindings: [], effects: { ...clear, mayDiscard: true } },
  ]);
const fragment = (program: ReturnType<typeof selected>) =>
  colorlessFragmentEntry(true, 'ALPHA_MASK=false', receipt, 0, 'fs_ao_input', program);

describe('colorless prepass native fragment effects', () => {
  it('requires known native effects before dropping a fragment stage', () => {
    expect(fragment(selected())).toBe('fs_ao_input');
    expect(fragment(selected(clear))).toBeNull();
  });

  it('keeps a fragment stage when fixed-function alpha-to-coverage is enabled', () => {
    expect(
      colorlessFragmentEntry(
        true,
        'ALPHA_MASK=false',
        receipt,
        0,
        'fs_ao_input',
        selected(clear),
        true,
      ),
    ).toBe('fs_ao_input');
  });

  it.each([
    'mayDiscard',
    'writesDepth',
    'writesSampleMask',
    'writesStorage',
  ] as const)('retains a selected entry that can %s', (effect) => {
    expect(fragment(selected({ ...clear, [effect]: true }))).toBe('fs_ao_input');
  });
});
