import { expect, it } from 'vitest';
import { operationCommandPath, operationMcpName } from '../src/index.js';

it('formats one public operation ID for CLI and MCP without renaming its resources or action', () => {
  for (const id of ['asset.source.instance.create', 'view.workspace.pack.reveal', 'engine.scene.tree.get']) {
    expect(operationCommandPath(id).join('.')).toBe(id);
    expect(operationMcpName(id)).toBe(`forgeax_${id.replaceAll('.', '_')}`);
  }
  expect(operationMcpName('asset.source.cold-cook')).toBe('forgeax_asset_source_cold_cook');
  for (const id of ['', 'inspect Pack', 'asset..inspect', 'asset_foo.inspect'])
    expect(() => operationCommandPath(id)).toThrow('invalid public operation ID');
});
