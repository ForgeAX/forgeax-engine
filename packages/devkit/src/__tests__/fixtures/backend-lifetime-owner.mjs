import { register } from 'node:module';

const owner = new URL('../../backend-lifetime.ts', import.meta.url);
const sourceResolution = `
  export function resolve(specifier, context, nextResolve) {
    if (context.parentURL === ${JSON.stringify(owner.href)} && specifier === './filesystem-path.js')
      return nextResolve('./filesystem-path.ts', context);
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(sourceResolution)}`, import.meta.url);

const { retainBackendLifetime } = await import(owner.href);
await retainBackendLifetime(process.argv[2]);
process.send('retained');
setInterval(() => {}, 1000);
