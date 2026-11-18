import type {
  LineBasicMaterial,
  LineDashedMaterial,
  Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PointsMaterial,
  SpriteMaterial,
} from 'three/src/Three.Core.js';

// Original NodeMaterial subclasses copy these same source-owned model flags.
export function isBasicMaterial(material: Material): material is MeshBasicMaterial {
  return 'isMeshBasicMaterial' in material && material.isMeshBasicMaterial === true;
}
export function isStandardMaterial(material: Material): material is MeshStandardMaterial {
  return 'isMeshStandardMaterial' in material && material.isMeshStandardMaterial === true;
}
export function isPhysicalMaterial(material: Material): material is MeshPhysicalMaterial {
  return 'isMeshPhysicalMaterial' in material && material.isMeshPhysicalMaterial === true;
}

export function isLambertMaterial(material: Material): material is MeshLambertMaterial {
  return 'isMeshLambertMaterial' in material && material.isMeshLambertMaterial === true;
}

export function isMatcapMaterial(material: Material): material is MeshMatcapMaterial {
  return 'isMeshMatcapMaterial' in material && material.isMeshMatcapMaterial === true;
}

export function isNormalMaterial(material: Material): material is MeshNormalMaterial {
  return 'isMeshNormalMaterial' in material && material.isMeshNormalMaterial === true;
}

export function isLineMaterial(material: Material): material is LineBasicMaterial {
  return 'isLineBasicMaterial' in material && material.isLineBasicMaterial === true;
}

export function isDashedMaterial(material: Material): material is LineDashedMaterial {
  return 'isLineDashedMaterial' in material && material.isLineDashedMaterial === true;
}

export function isPointsMaterial(material: Material): material is PointsMaterial {
  return 'isPointsMaterial' in material && material.isPointsMaterial === true;
}

export function isSpriteMaterial(material: Material): material is SpriteMaterial {
  return 'isSpriteMaterial' in material && material.isSpriteMaterial === true;
}
