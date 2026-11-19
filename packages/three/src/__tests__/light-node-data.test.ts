import * as THREE from '@forgeax/engine/three';
import { expect, it, vi } from 'vitest';

const value = (node: object, field: string) => Reflect.get(Reflect.get(node, field), 'value');

it('updates original analytic light color data from source edits under a caller-owned frame', () => {
  const frame = new THREE.NodeFrame();
  const cases = [
    new THREE.AnalyticLightNode(new THREE.PointLight()),
    new THREE.AmbientLightNode(new THREE.AmbientLight()),
    new THREE.DirectionalLightNode(new THREE.DirectionalLight()),
    new THREE.PointLightNode(new THREE.PointLight()),
    new THREE.SpotLightNode(new THREE.SpotLight()),
    new THREE.IESSpotLightNode(new THREE.IESSpotLight()),
  ];
  for (const node of cases) {
    expect(node).toBeInstanceOf(THREE.AnalyticLightNode);
    const light = node.light;
    if (light === null) throw Error('missing light');
    light.color.setRGB(0.2, 0.4, 0.6);
    light.intensity = 2;
    node.update(frame);
    expect(Reflect.get(node, 'color').toArray()).toEqual([0.4, 0.8, 1.2]);
    expect(Reflect.apply(node.getHash, node, [])).toBe(light.uuid);
    light.intensity = 3;
    node.update(frame);
    expect(Reflect.get(node, 'color').r).toBeCloseTo(0.6);
    const dispose = vi.fn();
    node.addEventListener('dispose', dispose);
    node.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    light.dispose();
  }
});

it('preserves spot falloff, hemisphere ground color and SH probe coefficients as mutable CPU data', () => {
  const frame = new THREE.NodeFrame();
  const spot = new THREE.SpotLight(0xffffff, 2, 7, 0.5, 0.2, 1.5),
    node = new THREE.SpotLightNode(spot);
  node.update(frame);
  expect(value(node, 'coneCosNode')).toBeCloseTo(Math.cos(0.5));
  expect(value(node, 'cutoffDistanceNode')).toBe(7);
  const hemi = new THREE.HemisphereLight(0xff0000, 0x00ff00, 2),
    hemisphere = new THREE.HemisphereLightNode(hemi);
  hemisphere.update(frame);
  expect(value(hemisphere, 'groundColorNode').toArray()).toEqual([0, 2, 0]);
  const probe = new THREE.LightProbe(undefined, 2),
    sh = new THREE.LightProbeNode(probe);
  probe.sh.coefficients[0]?.set(0.2, 0.3, 0.4);
  sh.update(frame);
  expect(
    (Reflect.get(Reflect.get(sh, 'lightProbe'), 'array') as THREE.Vector3[])[0]?.toArray(),
  ).toEqual([0.4, 0.6, 0.8]);
  for (const node of [hemisphere, sh]) node.dispose();
  node.dispose();
});

it('retains projector and rectangular light source identity without a native renderer', () => {
  const projector = new THREE.ProjectorLight();
  projector.aspect = 2;
  const projection = new THREE.ProjectorLightNode(projector);
  expect(projection.light).toBe(projector);
  expect(projection).toBeInstanceOf(THREE.SpotLightNode);
  const rect = new THREE.RectAreaLight(0xffffff, 2, 4, 6),
    node = new THREE.RectAreaLightNode(rect);
  rect.updateMatrixWorld(true);
  node.update(new THREE.NodeFrame());
  expect(value(node, 'halfWidth').toArray()).toEqual([2, 0, 0]);
  expect(value(node, 'halfHeight').toArray()).toEqual([0, 3, 0]);
  node.dispose();
  projection.dispose();
  rect.dispose();
  projector.dispose();
});
