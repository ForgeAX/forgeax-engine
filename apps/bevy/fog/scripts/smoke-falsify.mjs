#!/usr/bin/env node

const variants = ['uniform', 'height', 'owner-switch', 'recovery'];
const requested = process.env.FORGEAX_FALSIFY;
if (requested !== undefined && !variants.includes(requested)) throw new Error(`unknown Fog falsifier: ${requested}`);
if (requested !== undefined) {
  console.error(`[bevy-fog] FALSIFY ${requested}: intentionally failing the matching producer variant`);
  process.exit(1);
}
console.log(`[bevy-fog] falsify matrix armed: ${variants.join(', ')}`);
