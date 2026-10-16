import { registerHooks } from 'node:module';

// A metadata/control client must not activate browser or build producers.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vite' || specifier === 'playwright' || specifier.startsWith('playwright/')) {
      throw new Error(
        `CLI control loaded an inactive producer: ${specifier} from ${context.parentURL}`,
      );
    }
    return nextResolve(specifier, context);
  },
});
