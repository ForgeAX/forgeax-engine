import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Atmosphere, Skylight, type Renderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

/** Ordinary World/profile authoring controls; App remains the frame owner. */
export function installSurfaceControls(parent: HTMLElement, world: World, renderer: Renderer, object?: EntityHandle, skylight?: EntityHandle) {
  const controls = document.createElement('div');
  controls.className = 'surface-controls';
  controls.innerHTML = `<label>AO <select id="surface-ao"><option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
    <label><input id="surface-sky" type="checkbox"> Atmosphere sky</label>
    <label>Haze <input id="surface-haze" type="range" min="2" max="8" step="0.25" value="2" disabled></label>`;
  const ao = controls.querySelector<HTMLSelectElement>('#surface-ao')!;
  ao.addEventListener('change', () => {
    const quality = ao.value as 'off' | 'low' | 'medium' | 'high';
    const result = renderer.setProfile({ ...renderer.inspect().profile,
      ssao: quality === 'off' ? false : { quality, radius: 0.5, intensity: 1 } });
    if (!result.ok) throw result.error;
  });
  const sky = controls.querySelector<HTMLInputElement>('#surface-sky')!;
  const haze = controls.querySelector<HTMLInputElement>('#surface-haze')!;
  let atmosphere: EntityHandle | undefined;
  const skyColor = skylight === undefined ? undefined : Array.from(world.get(skylight, Skylight).unwrap().color);
  sky.addEventListener('change', () => {
    if (sky.checked) atmosphere = world.spawn({ component: Atmosphere, data: { mieScattering: Number(haze.value) * 2e-6 } }).unwrap();
    else if (atmosphere !== undefined) {
      world.despawn(atmosphere).unwrap();
      atmosphere = undefined;
    }
    if (skylight !== undefined && skyColor !== undefined) world.set(skylight, Skylight, { color: sky.checked ? [1, 1, 1] : skyColor }).unwrap();
    haze.disabled = !sky.checked;
  });
  haze.addEventListener('input', () => {
    if (atmosphere !== undefined) world.set(atmosphere, Atmosphere, { mieScattering: Number(haze.value) * 2e-6 }).unwrap();
  });
  if (object !== undefined) {
    const origin = Array.from(world.get(object, Transform).unwrap().pos);
    const label = document.createElement('label');
    label.textContent = 'Cube position ';
    const position = document.createElement('input');
    position.id = 'surface-object';
    position.type = 'range';
    position.min = '-1'; position.max = '1'; position.step = '0.05'; position.value = '0';
    position.addEventListener('input', () => world.set(object, Transform,
      { pos: [origin[0]! + Number(position.value), origin[1]!, origin[2]!] }).unwrap());
    label.append(position);
    controls.append(label);
  }
  parent.insertAdjacentElement('afterend', controls);
}
