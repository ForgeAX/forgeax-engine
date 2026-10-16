import assert from 'node:assert/strict';

export function assertBrotatoFalsifiers(evidence) {
  assert.equal(evidence.renderer, 'ready');
  assert.ok(evidence.spawnedEntities >= 1);
  assert.ok(evidence.fixedTicks >= 1);
  assert.ok(evidence.hudVisible);
  assert.ok(evidence.combatObserved);
}
