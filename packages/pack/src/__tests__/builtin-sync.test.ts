import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { BUILTIN_MESH_ASSETS, deriveBuiltin } from '../builtin.js';
import { AssetGuid, PackageId } from '../guid.js';

const namespace = Buffer.from('9a09805a7623482eb3229fc3591f2a38', 'hex');

it.each([
  '',
  ' ',
  ' HANDLE_CUBE ',
  'forgeax::msdf-text',
  '\u7f51\u683c',
  'e\u0301',
  '\u00e9',
])('derives arbitrary builtin name %j synchronously from exact UTF-8 bytes', (name) => {
  const digest = createHash('sha1').update(namespace).update(name, 'utf8').digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const actual = deriveBuiltin(name);
  expect(actual).toBeInstanceOf(Uint8Array);
  expect(Array.from(actual)).toEqual(Array.from(digest.subarray(0, 16)));
});

it('preserves every published builtin mesh identity', () => {
  expect(BUILTIN_MESH_ASSETS.map(({ guid }) => guid)).toEqual([
    'cbe42beb-8975-5096-b3a1-3dda4cb4c077',
    '22592f07-d967-5116-b29c-fa9781929ba8',
    '339338aa-a338-581c-9fc5-744267ef8a51',
    '95730fd2-9846-5f84-8658-0b3c971eb263',
    '692d38b4-8cac-5fb2-9dcf-f389e076d6bf',
    'ab20af21-0764-55be-a7f2-b80ab3d46a0a',
  ]);
});

it('keeps Pack source-key validation separate from builtin names', () => {
  const parsed = PackageId.parse('9a09805a-7623-482e-b322-9fc3591f2a38');
  if (!parsed.ok) throw parsed.error;
  expect(() => AssetGuid.derive(parsed.value, 'HANDLE_CUBE')).toThrow('invalid sourceKey');
  expect(() => AssetGuid.derive(new Uint8Array(15) as PackageId, 'mesh')).toThrow(
    '16-byte PackageId',
  );
  expect(AssetGuid.derive(parsed.value, 'mesh')).toEqual(deriveBuiltin('mesh'));
});
