import { createBoxGeometry } from '../../geometry/dist/index.mjs';
import { mat4 } from '../../math/dist/index.mjs';
export const settings={radius:0.3,height:1.8,maxSlopeDeg:45,maxStep:0.3,cellSize:0.1,cellHeight:0.05};
/** One primitive authoring definition feeds ordinary Mesh, placement and Collider facts. */
export function box(width,height,depth,x=0,y=0,z=0,angle=0) {
  const world=mat4.identity(mat4.create());
  const c=Math.cos(angle),s=Math.sin(angle);world[0]=c;world[1]=s;world[4]=-s;world[5]=c;world[12]=x;world[13]=y;world[14]=z;
  return {mesh:createBoxGeometry(width,height,depth).unwrap(),world,components:{Transform:{pos:[x,y,z],quat:[0,0,Math.sin(angle/2),Math.cos(angle/2)]},Collider:{halfExtents:[width/2,height/2,depth/2]}}};
}
export const floor=()=>box(12,0.2,10,0,-0.1,0);
export function doorway(gap=1.2) {
  return [floor(),box(0.4,3,(10-gap)/2,0,1.5,(10+gap)/4),box(0.4,3,(10-gap)/2,0,1.5,-(10+gap)/4)];
}
export function lowCeiling(clearance=1.5) {return [floor(),box(4,0.2,10,0,clearance+0.1,0)];}
export function stairs(step=0.2) {
  return [box(4,0.2,4,-4,-0.1,0),...Array.from({length:5},(_,i)=>box(1,(i+1)*step,4,-1.5+i,(i+1)*step/2,0)),box(4,0.2,4,5,step*5-0.1,0)];
}
export function slope(angle=20) {const a=angle*Math.PI/180;return [box(10,0.2,4,0,3,0,a)];}
export function islands(){return [box(4,0.2,4,-4,-0.1,0),box(4,0.2,4,4,-0.1,0)];}
export function actor(x,z=0){return {components:{Transform:{pos:[x,0.82,z]},NavigationCharacter:{},NavigationAgent:{speed:1.5},RigidBody:{type:2},Collider:{shape:2,radius:0.3,halfHeight:0.5}}};}
