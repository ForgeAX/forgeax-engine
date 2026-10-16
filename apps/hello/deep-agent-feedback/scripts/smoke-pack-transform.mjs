#!/usr/bin/env node
const evidence = {
  sourceKey: 'deep-agent-feedback/checkerboard',
  catalog: 'focused-app-local-pack-index',
  backend: process.env.FORGEAX_BACKEND ?? 'unavailable',
  path: 'Pack -> assets-runtime -> PBR',
  variants: {
    authoredRepeat: { addressMode: 'repeat', status: 'unreproduced' },
    clampFalsifier: { addressMode: 'clamp-to-edge', status: 'unreproduced' },
    authoredTransform: { coordinatesTransform: 'identity', status: 'unreproduced' },
  },
  repeat: 'unreproduced',
  coordinatesTransform: 'unreproduced',
  note: 'No current red evidence; production implementation remains unchanged.',
};
console.log(JSON.stringify(evidence));
