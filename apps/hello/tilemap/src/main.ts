import { World } from '@forgeax/engine-ecs';
import { registerPropagateTransforms } from '@forgeax/engine-scene';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { buildTilemapScene } from './scene';

async function main() {
  const canvas=document.querySelector<HTMLCanvasElement>('#app');if(canvas===null)return;
  const initialized=await constructRuntimeRendererHost(canvas,{});if(!initialized.ok)throw initialized.error;
 const {renderer,assets}=initialized.value;
  const world=new World({assets});registerPropagateTransforms(world);
  const attached=renderer.attach(world);if(!attached.ok)throw attached.error;
 const lease=attached.value,scene=buildTilemapScene(world,assets);
  let frame=0;
  const draw=()=>{if(++frame===120)scene.edit();world.update(1/60).unwrap();const result=renderer.draw({leases:[lease],camera:{lease},environment:{lease}});if(!result.ok)throw result.error;requestAnimationFrame(draw);};
  requestAnimationFrame(draw);
}
void main();
