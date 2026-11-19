import { expect, it } from 'vitest';
import { linkSingleHtmlModules } from '../single-html-module-links.js';

it('keeps exact fetch bytes while relocating native module imports and metadata', () => {
  const source = Buffer.from(
    "const title='\u5929\u5de5'; import {value} from './b.mjs'; export {value} from './b.mjs'; const url=new URL('../data.bin', import.meta.url);",
  );
  const linked = linkSingleHtmlModules([
    { path: '__forgeax-bundle/assets/a.mjs', bytes: source, mediaType: 'text/javascript' },
    {
      path: '__forgeax-bundle/assets/b.mjs',
      bytes: Buffer.from('export const value=42'),
      mediaType: 'text/javascript',
    },
  ]);
  expect(linked[0]?.bytes).toBe(source);
  const links = linked[0]?.moduleLinks ?? [];
  expect(
    links.map((link) => [
      link.kind,
      source.toString('utf8').slice(link.start, link.end),
      link.path,
    ]),
  ).toEqual([
    ['import', "'./b.mjs'", '__forgeax-bundle/assets/b.mjs'],
    ['import', "'./b.mjs'", '__forgeax-bundle/assets/b.mjs'],
    ['url', 'import.meta.url', '__forgeax-bundle/assets/a.mjs'],
  ]);
});
