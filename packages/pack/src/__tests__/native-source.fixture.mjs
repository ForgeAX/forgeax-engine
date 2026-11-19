import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

const sourceRoot = new URL('../', import.meta.url).href;

// Native type stripping preserves ESM .js specifiers. Resolve only missing
// package-local source files; real JavaScript and dependency errors stay native.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code !== 'ERR_MODULE_NOT_FOUND' ||
        !context.parentURL?.startsWith(sourceRoot) ||
        !specifier.startsWith('.') ||
        !specifier.endsWith('.js')
      )
        throw error;
      const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (!source.href.startsWith(sourceRoot) || !existsSync(source)) throw error;
      return nextResolve(source.href, context);
    }
  },
});
