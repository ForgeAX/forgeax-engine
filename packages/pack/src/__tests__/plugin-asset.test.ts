import { describe, expect, it } from 'vitest';
import { parsePackSourceJson, projectDirectPackJson } from '../pack-authoring.js';
import {
  lowerPluginConfig,
  lowerPluginToolContract,
  validatePluginAsset,
  validatePluginAssetSource,
} from '../plugin-asset.js';

const guid = '00000000-0000-4000-8000-000000000001';
const inlineTools = {
  schemaVersion: '1.0.0',
  commands: [
    {
      id: 'game.run',
      title: 'Run',
      summary: '',
      realm: 'engine',
      executor: './game.js',
      exportName: 'run',
    },
  ],
};

describe('plugin Pack source contract', () => {
  it('accepts the existing pure tool contract inline in a direct PluginAssetSource', () => {
    const source = {
      kind: 'plugin',
      module: { specifier: './game.js' },
      toolContract: inlineTools,
    };
    expect(validatePluginAssetSource(source).ok).toBe(true);
    expect(
      parsePackSourceJson({
        schemaVersion: '3.0.0',
        packageId: guid,
        assets: {
          game: { kind: 'plugin', payload: { module: source.module, toolContract: inlineTools } },
        },
      }).ok,
    ).toBe(true);
  });

  it('lowers named executors once while preserving declaration data and unavailable commands', () => {
    const source = validatePluginAssetSource({
      kind: 'plugin',
      module: { specifier: './game.js' },
      toolContract: inlineTools,
    }).unwrap();
    const contract = source.toolContract;
    if (!contract || 'specifier' in contract) throw new Error('expected inline contract');
    const references: unknown[] = [];
    const lowered = lowerPluginToolContract(
      {
        ...contract,
        commands: [
          ...contract.commands,
          { id: 'game.unavailable', title: 'Unavailable', summary: '', realm: 'engine' },
        ],
      },
      (reference) => {
        references.push(reference);
        return 'program:run';
      },
    ).unwrap();
    expect(references).toEqual([{ specifier: './game.js', export: 'run' }]);
    expect(lowered.commands[0]).toMatchObject({ executor: 'program:run' });
    expect(lowered.commands[0]).not.toHaveProperty('exportName');
    expect(lowered.commands[1]).not.toHaveProperty('executor');
    expect(contract.commands[0]?.executor).toBe('./game.js');
    expect(lowerPluginToolContract(contract, () => '').ok).toBe(false);
  });

  it.each([
    { ...inlineTools, specifier: './contract.js' },
    { ...inlineTools, commands: [...inlineTools.commands, ...inlineTools.commands] },
    { ...inlineTools, commands: [{ ...inlineTools.commands[0], executor: () => 42 }] },
    { ...inlineTools, schemaVersion: 'unknown' },
  ])('rejects ambiguous or invalid inline tool data: %s', (toolContract) => {
    expect(
      validatePluginAssetSource({
        kind: 'plugin',
        module: { specifier: './game.js' },
        toolContract,
      }).ok,
    ).toBe(false);
  });
  it('derives references from markers and leaves ordinary strings unchanged', () => {
    const config = { mesh: { $asset: guid }, repeated: [{ $asset: guid }], label: guid };
    expect(lowerPluginConfig(config).unwrap()).toEqual({
      config: { mesh: guid, repeated: [guid], label: guid },
      refs: [guid],
    });
    expect(config.mesh).toEqual({ $asset: guid });
  });

  it.each([
    NaN,
    Infinity,
    undefined,
    new Date(),
    () => 1,
    { nested: undefined },
    { $asset: guid, extra: true },
    { $asset: 'not-a-guid' },
    Object.defineProperty({}, 'value', { enumerable: true, get: () => 3 }),
  ])('rejects data that cannot survive the authoring boundary: %s', (config) => {
    expect(
      validatePluginAssetSource({ kind: 'plugin', module: { specifier: './game.ts' }, config }).ok,
    ).toBe(false);
  });

  it('rejects cycles and preserves omitted native config', () => {
    const config: Record<string, unknown> = {};
    config.self = config;
    expect(lowerPluginConfig(config).ok).toBe(false);
    const source = validatePluginAssetSource({
      kind: 'plugin',
      module: { specifier: './game.ts' },
    }).unwrap();
    expect(Object.hasOwn(source, 'config')).toBe(false);
  });

  it('parses direct plugin entries without a second authored refs list', () => {
    const document = {
      schemaVersion: '3.0.0',
      packageId: guid,
      assets: {
        'plugin/game': {
          kind: 'plugin',
          payload: {
            module: { specifier: './game.ts', export: 'game' },
            config: { mesh: { $asset: guid } },
          },
        },
      },
    };
    const parsed = parsePackSourceJson(document).unwrap();
    expect(parsed.format).toBe('direct');
    if (parsed.format !== 'direct') throw new Error('expected direct');
    const projected = projectDirectPackJson(parsed);
    expect(projected.assets[0]?.refs).toEqual([guid]);
    expect(projected.assets[0]?.guid).not.toBe(guid);
    expect(
      parsePackSourceJson({
        ...document,
        assets: {
          'plugin/game': { ...document.assets['plugin/game'], refs: [guid] },
        },
      }).ok,
    ).toBe(false);
  });

  it('keeps cooked definitions data-only and closed', () => {
    expect(
      validatePluginAsset({
        kind: 'plugin',
        program: 'project:game.ts#game',
        config: { mesh: guid },
      }).ok,
    ).toBe(true);
    expect(validatePluginAsset({ kind: 'plugin', program: 'game', apply() {} }).ok).toBe(false);
    expect(validatePluginAsset({ kind: 'plugin', module: { specifier: './game.ts' } }).ok).toBe(
      false,
    );
  });
});
