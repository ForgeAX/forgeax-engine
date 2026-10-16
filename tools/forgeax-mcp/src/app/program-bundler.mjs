import { build } from 'esbuild';
import { linkPackProgram, packProgramModuleIdentity, verifyPackProgram } from '@forgeax/engine/pack/runtime';

import { PROGRAM_IMPORTS_SLOT } from '../contract.ts';

/** Compile only the admitted graph; never load files, network modules or replacement Engine copies. */
export async function bundlePackProgram(input) {
  if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024) throw new Error('Program transport byte bound exceeded');
  const program = verifyPackProgram(input.program).unwrap();
  packProgramModuleIdentity(program, input.imports).unwrap();
  const base = 'https://forgeax.program.invalid/';
  const bindings = Object.fromEntries(Object.entries(input.imports).map(([name, binding]) => [name,
    { ...binding, url: new URL(`imports/${encodeURIComponent(name)}.cjs`, base).href }]));
  const linked = linkPackProgram(program, new URL('modules/', base).href, bindings).unwrap();
  const sources = new Map(linked.files.map(file => [file.url, { contents: file.source, loader: 'js' }]));
  for (const name of Object.keys(program.imports ?? {})) {
    const names = input.exports[name];
    if (!Array.isArray(names) || names.length > 2048 || names.some(name => typeof name !== 'string' || name === '__esModule'))
      throw new Error('Invalid program import namespace');
    // CommonJS namespace getters preserve native export identity and live reads.
    const fields = names.map(key => `${JSON.stringify(key)}:{enumerable:true,get:()=>namespace[${JSON.stringify(key)}]}`);
    sources.set(bindings[name].url, { loader: 'js', contents:
      `const namespace=globalThis[Symbol.for(${JSON.stringify(PROGRAM_IMPORTS_SLOT)})].get(${JSON.stringify(input.bindingId)}).get(${JSON.stringify(name)});module.exports=Object.defineProperties(Object.create(null),{__esModule:{value:true},${fields.join(',')}});` });
  }
  const driverUrl = new URL('driver.js', base).href;
  sources.set(driverUrl, { loader: 'js', contents:
    `export function load(entry) { switch(entry) { ${Object.keys(program.modules).map(filename => `case ${JSON.stringify(filename)}: return require(${JSON.stringify(new URL(filename, new URL('modules/', base)).href)});`).join('')} default: throw new Error('Unknown Pack entry'); } }` });
  const result = await build({
    logOverride: { 'empty-import-meta': 'error' },
    entryPoints: [driverUrl], bundle: true, write: false, format: 'iife', globalName: '__forgeaxProgram', platform: 'browser', target: 'esnext',
    plugins: [{ name: 'admitted-pack-program', setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => {
        const path = new URL(args.path, args.pluginData?.url || base).href;
        if (!sources.has(path)) throw new Error(`Module outside admitted Pack graph: ${args.path}`);
        // Browser ESM namespaces must not acquire Node's .mjs/CommonJS default interop.
        return { path: `${encodeURIComponent(path)}.js`, namespace: 'pack-program', pluginData: { url: path } };
      });
      plugin.onLoad({ filter: /.*/, namespace: 'pack-program' }, args => ({ ...sources.get(args.pluginData.url), pluginData: args.pluginData }));
    } }],
  });
  return `${result.outputFiles[0].text}\nexport default Object.freeze(__forgeaxProgram);`;
}
