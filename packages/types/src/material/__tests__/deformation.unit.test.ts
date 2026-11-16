import { describe, expect, it } from 'vitest';
import {
  isMaterialDeformationDeclaration,
  isMaterialDeformationProgramAbi,
  type MaterialDeformationProgramAbi,
  WATER_DEFORMATION_INPUTS,
  WATER_DEFORMATION_VERSION,
  waterDeformationInputLayout,
  waterDeformationInputLayoutHash,
} from '../deformation.js';

function programAbi(): MaterialDeformationProgramAbi {
  return {
    module: 'game::water_deformation',
    version: WATER_DEFORMATION_VERSION,
    inputs: WATER_DEFORMATION_INPUTS,
    inputLayout: waterDeformationInputLayout(),
    inputLayoutHash: waterDeformationInputLayoutHash(),
    outputAbi: 'WaterDeformationOutput',
    variants: ['color', 'depth', 'shadow', 'velocity'],
  };
}

describe('Water deformation ABI admission', () => {
  it('keeps source flow units and target wave identity explicit in the canonical layout', () => {
    const fields = waterDeformationInputLayout().fields;
    expect(fields.find((field) => field.name === 'vertexFlowMPerSec')?.type).toBe('vec2<f32>');
    expect(fields.find((field) => field.name === 'waveBodyRenderIndex')?.type).toBe('u32');
    expect(fields.find((field) => field.name === 'bodyRenderIndex')?.type).toBe('u32');
  });

  it('admits the canonical layout after JSON publication', () => {
    expect(isMaterialDeformationProgramAbi(JSON.parse(JSON.stringify(programAbi())))).toBe(true);
  });

  it('admits equivalent layout and field objects regardless of JSON key order', () => {
    const abi = programAbi();
    const reordered = {
      ...abi.inputLayout,
      fields: abi.inputLayout.fields.map((field) =>
        Object.fromEntries(Object.entries(field).reverse()),
      ),
    };
    const inputLayout: unknown = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(reordered).reverse())),
    );
    expect(inputLayout).toEqual(abi.inputLayout);
    expect(JSON.stringify(inputLayout)).not.toBe(JSON.stringify(abi.inputLayout));
    expect(isMaterialDeformationProgramAbi({ ...abi, inputLayout })).toBe(true);
  });

  it('rejects a cyclic layout without throwing', () => {
    const abi = programAbi();
    const inputLayout: Record<string, unknown> = { ...abi.inputLayout };
    inputLayout.fields = [inputLayout];
    expect(isMaterialDeformationProgramAbi({ ...abi, inputLayout })).toBe(false);
  });

  it('rejects a BigInt layout value without throwing', () => {
    const abi = programAbi();
    expect(
      isMaterialDeformationProgramAbi({
        ...abi,
        inputLayout: { ...abi.inputLayout, stride: 128n },
      }),
    ).toBe(false);
  });

  it.each([
    ['one comma-delimited variant', ['color,depth,shadow,velocity']],
    ['a comma-delimited tail', ['color', 'depth', 'shadow,velocity']],
    ['a missing variant', ['color', 'depth', 'shadow']],
    ['an extra variant', ['color', 'depth', 'shadow', 'velocity', 'color']],
    ['reordered variants', ['depth', 'color', 'shadow', 'velocity']],
    ['a sparse tuple', new Array(4)],
  ])('rejects %s', (_name, variants) => {
    expect(isMaterialDeformationProgramAbi({ ...programAbi(), variants })).toBe(false);
  });

  it.each([
    'name',
    'stride',
    'maxRecords',
    'maxDomains',
    'maxPageBytes',
    'maxBindings',
    'maxEventsPerSample',
    'identity',
  ] as const)('rejects a changed layout %s', (key) => {
    const abi = programAbi();
    const value = abi.inputLayout[key];
    const inputLayout = {
      ...abi.inputLayout,
      [key]: typeof value === 'number' ? value + 1 : `${value}-changed`,
    };
    expect(isMaterialDeformationProgramAbi({ ...abi, inputLayout })).toBe(false);
  });

  it.each([
    'name',
    'type',
    'offset',
    'size',
    'alignment',
  ] as const)('rejects a changed field %s', (key) => {
    const abi = programAbi();
    const inputLayout = {
      ...abi.inputLayout,
      fields: abi.inputLayout.fields.map((field, index) => {
        const value = field[key];
        return index === 0
          ? { ...field, [key]: typeof value === 'number' ? value + 1 : `${value}-changed` }
          : field;
      }),
    };
    expect(isMaterialDeformationProgramAbi({ ...abi, inputLayout })).toBe(false);
  });

  it('rejects missing, reordered and additional layout fields', () => {
    const abi = programAbi();
    for (const fields of [
      abi.inputLayout.fields.slice(1),
      [...abi.inputLayout.fields].reverse(),
      [...abi.inputLayout.fields, ...abi.inputLayout.fields],
      new Array(abi.inputLayout.fields.length),
    ]) {
      expect(
        isMaterialDeformationProgramAbi({ ...abi, inputLayout: { ...abi.inputLayout, fields } }),
      ).toBe(false);
    }
  });

  it('rejects unknown layout and field properties', () => {
    const abi = programAbi();
    const inputLayouts = [
      { ...abi.inputLayout, extra: true },
      {
        ...abi.inputLayout,
        fields: abi.inputLayout.fields.map((field) => ({ ...field, extra: true })),
      },
    ];
    for (const inputLayout of inputLayouts) {
      expect(isMaterialDeformationProgramAbi({ ...abi, inputLayout })).toBe(false);
    }
  });

  it('rejects a changed layout hash, version and output contract', () => {
    const abi = programAbi();
    expect(isMaterialDeformationProgramAbi({ ...abi, inputLayoutHash: 'sha256-stale' })).toBe(
      false,
    );
    expect(isMaterialDeformationProgramAbi({ ...abi, version: 'water-deformation/2' })).toBe(false);
    expect(isMaterialDeformationProgramAbi({ ...abi, outputAbi: 'OtherOutput' })).toBe(false);
  });

  it('preserves strict declaration input properties', () => {
    const abi = programAbi();
    const declaration = { module: abi.module, version: abi.version, inputs: abi.inputs };
    expect(isMaterialDeformationDeclaration(declaration)).toBe(true);
    const inputs = declaration.inputs.map((field) => ({ ...field, extra: true }));
    expect(isMaterialDeformationDeclaration({ ...declaration, inputs })).toBe(false);
    expect(isMaterialDeformationProgramAbi({ ...abi, inputs })).toBe(false);
  });

  it('rejects sparse inputs at both declaration and program boundaries', () => {
    const abi = programAbi();
    const inputs = new Array(WATER_DEFORMATION_INPUTS.length);
    expect
      .soft(isMaterialDeformationDeclaration({ module: abi.module, version: abi.version, inputs }))
      .toBe(false);
    expect.soft(isMaterialDeformationProgramAbi({ ...abi, inputs })).toBe(false);
  });

  it('rejects arrays masquerading as input fields at both boundaries', () => {
    const abi = programAbi();
    const inputs = WATER_DEFORMATION_INPUTS.map((field) => Object.assign([], field));
    expect
      .soft(isMaterialDeformationDeclaration({ module: abi.module, version: abi.version, inputs }))
      .toBe(false);
    expect.soft(isMaterialDeformationProgramAbi({ ...abi, inputs })).toBe(false);
  });
});
