/**
 * The frozen limit layout's one known interference pair (S7-MOTION.md, Status: frozen) and
 * its deepest penetration (m): a new pair or a deeper one fails; S4 v3 empties this list.
 */
export const FROZEN_PAIRS: Readonly<Record<string, number>> = {
  'front-fender-l / front-wishbones-l': 0.009,
  'front-fender-r / front-wishbones-r': 0.009,
  // At one pose the two leaves of each hinge lie flush on the same slab (depth = half the 4 mm leaf), which the detector used to pass at depth 0.
  'hinge-pelvis-flip-a / hinge-pelvis-flip-b': 0.002,
  'hinge-v12-flip-a / hinge-v12-flip-b': 0.002,
  'hinge-front-wheel-l-swing-a / hinge-front-wheel-l-swing-b': 0.002,
  'hinge-front-wheel-r-swing-a / hinge-front-wheel-r-swing-b': 0.002,
  'hinge-bumper-drop-a / hinge-bumper-drop-b': 0.002,
  'hinge-engine-cover-l-flip-a / hinge-engine-cover-l-flip-b': 0.002,
  'hinge-engine-cover-r-flip-a / hinge-engine-cover-r-flip-b': 0.002,
};
