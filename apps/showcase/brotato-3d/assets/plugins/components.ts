import { defineComponent } from '@forgeax/engine-ecs';

export const BrotatoPlayer = defineComponent('Brotato3dPlayer', {});

export const BrotatoWeapon = defineComponent('Brotato3dWeapon', {});

export const BrotatoEnemy = defineComponent('Brotato3dEnemy', {});

export const BrotatoProjectileTag = defineComponent('Brotato3dProjectile', {});

export const BrotatoPickupTag = defineComponent('Brotato3dPickup', {});

export const BrotatoVfxCarrier = defineComponent('Brotato3dVfxCarrier', {
  ttl: 'f32',
});

export const BrotatoInput = defineComponent('Brotato3dInput', {
  moveX: 'f32',
  moveZ: 'f32',
  fire: 'f32',
});

export const BrotatoStats = defineComponent('Brotato3dStats', {
  health: 'f32',
  maxHealth: 'f32',
  invulnerability: 'f32',
});

export const BrotatoEnemyStats = defineComponent('Brotato3dEnemyStats', {
  health: 'f32',
  maxHealth: 'f32',
  speed: 'f32',
  attackCooldown: 'f32',
});

export const BrotatoProjectileMotion = defineComponent('Brotato3dProjectileMotion', {
  vx: 'f32',
  vz: 'f32',
  damage: 'f32',
  lifetime: 'f32',
});

export const BrotatoPickupMotion = defineComponent('Brotato3dPickupMotion', {
  value: 'f32',
  spin: 'f32',
});

export const BROTATO_COMPONENTS = [
  BrotatoPlayer,
  BrotatoWeapon,
  BrotatoEnemy,
  BrotatoProjectileTag,
  BrotatoPickupTag,
  BrotatoVfxCarrier,
  BrotatoInput,
  BrotatoStats,
  BrotatoEnemyStats,
  BrotatoProjectileMotion,
  BrotatoPickupMotion,
] as const;
