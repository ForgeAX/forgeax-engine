import { parseWaterContentArgs, prepareWaterContent } from './prepare-water-content.mjs';

// Keep preparation and the package's maintained tsup configuration in one lifecycle.
await prepareWaterContent(parseWaterContentArgs(process.argv.slice(2)));
const { build } = await import('tsup');
await build({ config: true });
