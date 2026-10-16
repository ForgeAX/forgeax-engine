import assert from 'node:assert/strict';

export function assertGame3dFalsifiers(evidence) {
  assert.equal(evidence.renderer, 'ready');
  assert.equal(evidence.input, 'observed');
  assert.equal(evidence.movement, 'observed');
  assert.equal(evidence.animation, 'observed');
  assert.equal(evidence.fixedTick, 'observed');
  assert.equal(evidence.projection, 'observed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertGame3dFalsifiers({
    renderer: 'ready',
    input: 'observed',
    movement: 'observed',
    animation: 'observed',
    fixedTick: 'observed',
    projection: 'observed',
  });
}
