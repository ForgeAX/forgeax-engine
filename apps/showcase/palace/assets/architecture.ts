import { footprints } from './footprints.ts';
import { footprintTriangles } from './footprint-triangulations.ts';
import { roofPartitions, roofFootprintDigest } from './roof-partitions.ts';
import { createHash } from 'node:crypto';
import { waterways, jinshuiBridges } from './waterways.ts';
import { createSweepGeometry, meshFromInterleaved } from '@forgeax/engine/geometry';
import type { MeshAsset } from '@forgeax/engine/types';

/** Grow typed storage without retaining boxed-number arrays for every building. */
class Numbers {
  length=0;
  data:Float32Array|Uint32Array;
  readonly indices:boolean;
  constructor(indices=false){this.indices=indices;this.data=indices?new Uint32Array(4096):new Float32Array(4096);}
  push(...values:number[]){
    if(this.length+values.length>this.data.length){
      const next=this.indices?new Uint32Array(this.data.length*2):new Float32Array(this.data.length*2);
      next.set(this.data);this.data=next;
    }
    this.data.set(values,this.length);this.length+=values.length;
  }
  view(){return this.data.subarray(0,this.length);}
}

type V = [number, number, number];
type RoofForm = 'hip' | 'gable-hip' | 'pyramid';
type HallOptions = { front?: readonly ('window'|'door')[]; detailed?: boolean; roof?: RoofForm; bays?: [number,number]; doubleEave?: boolean; eaveHeight?: number; overhang?: number; roofRise?: number; plaque?: string };
const add = (a: V, b: V): V => [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const sub = (a: V, b: V): V => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const mul = (a: V, s: number): V => [a[0]*s,a[1]*s,a[2]*s];
const cross = (a: V,b: V): V => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit = (a: V): V => mul(a,1/(Math.hypot(...a)||1));
const roofRiseAt = (rise:number,t:number):number => rise*Math.max(0,1-t)**1.55;

/** Build-time geometry only. Groups preserve inspectable architectural subjects. */
export class Architecture {
  groups = new Map<string,{vertices:Numbers;indices:Numbers;material:string}>();
  subject = 'Taihedian';
  offset: V = [0,0,0];
  yaw=0;
  rotate(p:V):V {const c=Math.cos(this.yaw),s=Math.sin(this.yaw);return [c*p[0]+s*p[2],p[1],-s*p[0]+c*p[2]];}
  group(material:string){
    const key=this.subject.toLowerCase().replaceAll(' ','-')+'/'+material;
    let g=this.groups.get(key);if(!g){g={vertices:new Numbers(),indices:new Numbers(true),material};this.groups.set(key,g);}
    return g;
  }
  quad(material:string, a:V,b:V,c:V,d:V, desired?:V, normalAt?:(p:V)=>V, uvAt?:(p:V)=>[number,number]) {
    const normal=add(cross(sub(b,a),sub(c,a)),cross(sub(c,a),sub(d,a)));
    if(Math.hypot(...normal)<1e-10)return;
    let n=unit(normal);
    if(desired && n.reduce((s,v,i)=>s+v*desired[i]!,0)<0){ [b,d]=[d,b];n=mul(n,-1); }
    const g=this.group(material);
    const base=g.vertices.length/8;
    const minY=Math.min(a[1],b[1],c[1],d[1]),maxY=Math.max(a[1],b[1],c[1],d[1]);
    const uv=(p:V):[number,number]=>uvAt?.(p)??(material==='caihua'?[(Math.abs(n[0])>.5?p[2]:p[0])/5.8,(p[1]-minY)/Math.max(.001,maxY-minY)/3]:Math.abs(n[1])>Math.max(Math.abs(n[0]),Math.abs(n[2]))?[p[0]*.5,p[2]*.5]:Math.abs(n[0])>Math.abs(n[2])?[p[2]*.5,p[1]*.5]:[p[0]*.5,p[1]*.5]);
    const first=Math.hypot(...cross(sub(b,a),sub(c,a)))>1e-10;
    const second=Math.hypot(...cross(sub(c,a),sub(d,a)))>1e-10;
    if(!first || !second){
      const points=first?[a,b,c]:[a,c,d];
      points.forEach((p,i)=>g!.vertices.push(...add(this.rotate(p),this.offset),...this.rotate(normalAt?.(p)??n),...uv(p)));
      g.indices.push(base,base+1,base+2);return;
    }
    [a,b,c,d].forEach((p,i)=>g!.vertices.push(...add(this.rotate(p),this.offset),...this.rotate(normalAt?.(p)??n),...uv(p)));
    g.indices.push(base,base+1,base+2,base,base+2,base+3);
  }
  box(m:string,x:number,y:number,z:number,w:number,h:number,d:number) {
    const X=x+w/2,A=x-w/2,Y=y+h/2,B=y-h/2,Z=z+d/2,C=z-d/2;
    this.quad(m,[A,B,Z],[X,B,Z],[X,Y,Z],[A,Y,Z],[0,0,1]);
    this.quad(m,[X,B,C],[A,B,C],[A,Y,C],[X,Y,C],[0,0,-1]);
    this.quad(m,[X,B,Z],[X,B,C],[X,Y,C],[X,Y,Z],[1,0,0]);
    this.quad(m,[A,B,C],[A,B,Z],[A,Y,Z],[A,Y,C],[-1,0,0]);
    this.quad(m,[A,Y,Z],[X,Y,Z],[X,Y,C],[A,Y,C],[0,1,0]);
    this.quad(m,[A,B,C],[X,B,C],[X,B,Z],[A,B,Z],[0,-1,0]);
  }
  tube(m:string,points:V[],radius:number,sides=7) {
    this.sweep(m,points,radius,sides);
  }
  /** Use the shared validated sweep factory for low-frequency authored rails. */
  sweep(m:string,points:V[],radius:number,sides=7) {
    const result=createSweepGeometry(points,radius,sides);
    if(!result.ok)throw result.error;
    const source=result.value.vertices,indices=result.value.indices;
    if(indices===undefined)throw Error('Sweep geometry did not produce indices');
    const g=this.group(m),base=g.vertices.length/8;
    const totalLength=points.slice(1).reduce((sum,p,i)=>sum+Math.hypot(...sub(p,points[i]!)),0);
    for(let i=0;i<source.length/12;i++){
      const offset=i*12;
      const p=this.rotate([source[offset]!,source[offset+1]!,source[offset+2]!]);
      const n=this.rotate([source[offset+3]!,source[offset+4]!,source[offset+5]!]);
      g.vertices.push(...add(p,this.offset),...n,source[offset+6]!*Math.PI*radius,source[offset+7]!*totalLength*.5);
    }
    for(const index of indices)g.indices.push(base+index);
  }

  archedWall(width:number,height:number,depth:number,center:[number,number],openings:{x:number;radius:number;spring:number}[],axis:'x'|'z'='z') {
    const P=(p:V):V=>axis==='z'?[p[0]+center[0],p[1],p[2]+center[1]]:[p[2]+center[0],p[1],p[0]+center[1]];
    const N=(n:V):V=>axis==='z'?n:[n[2],n[1],n[0]];
    const Q=(m:string,a:V,b:V,c:V,d:V,n:V)=>this.quad(m,P(a),P(b),P(c),P(d),N(n));
    const B=(m:string,x:number,y:number,z:number,w:number,h:number,d:number)=>{
      const p=P([x,y,z]);this.box(m,...p,axis==='z'?w:d,h,axis==='z'?d:w);
    };
    let edge=-width/2;
    for(const arch of [...openings,{x:width/2,radius:0,spring:0}]){
      const end=arch.x-arch.radius;
      if(end>edge){
        B('red',(edge+end)/2,height/2,0,end-edge,height,depth);
        for(const side of [-1,1])B('stone',(edge+end)/2,1,side*(depth/2+.012),end-edge,2,.024);
      }
      edge=arch.x+arch.radius;
      if(arch.radius===0)continue;
      const {x,radius:r,spring:h}=arch;
      for(const side of [-1,1]){
        const z=side*depth/2;
        for(let j=0;j<24;j++){
          const t=j*Math.PI/24,u=(j+1)*Math.PI/24;
          const a:V=[x+r*Math.cos(t),h+r*Math.sin(t),z],b:V=[x+r*Math.cos(u),h+r*Math.sin(u),z];
          Q('red',a,b,[b[0],height,z],[a[0],height,z],[0,0,side]);
          const A:V=[a[0],a[1],z+side*.035],C:V=[b[0],b[1],z+side*.035];
          Q('stone',A,C,[x+(r+.4)*Math.cos(u),h+(r+.4)*Math.sin(u),C[2]],[x+(r+.4)*Math.cos(t),h+(r+.4)*Math.sin(t),A[2]],[0,0,side]);
          if(side===1)Q('stone-dark',[a[0],a[1],-depth/2],[b[0],b[1],-depth/2],b,a,[-Math.cos((t+u)/2),-Math.sin((t+u)/2),0]);
        }
        for(const sign of [-1,1])B('stone',x+sign*(r+.2),h/2,z+side*.035,.4,h,.05);
      }
      for(const sign of [-1,1])Q('stone-dark',[x+sign*r,0,-depth/2],[x+sign*r,0,depth/2],[x+sign*r,h,depth/2],[x+sign*r,h,-depth/2],[-sign,0,0]);
      B('stone',x,.025,0,2*r,.05,depth);
    }
    B('stone',0,height+.12,0,width+.35,.24,depth+.35);
  }
  column(m:string,x:number,y:number,z:number,h:number,r:number) {
    this.tube(m,[[x,y,z],[x,y+h,z]],r,12);
    this.box('marble',x,y+.14,z,r*2.7,.28,r*2.7);
  }
  rail(x1:number,z1:number,x2:number,z2:number,y:number) {
    const n=Math.max(1,Math.round(Math.hypot(x2-x1,z2-z1)/2.1));
    for(let i=0;i<=n;i++){
      const t=i/n,x=x1+(x2-x1)*t,z=z1+(z2-z1)*t;
      this.box('marble',x,y+.58,z,.26,1.16,.26);
      this.box('marble',x,y+1.18,z,.38,.18,.38);
      this.tube('marble',[[x,y+1.24,z],[x,y+1.42,z]],.17,8);
      if(i<n){const nx=x1+(x2-x1)*(i+1)/n,nz=z1+(z2-z1)*(i+1)/n;
        this.tube('marble',[[x,y+1.02,z],[nx,y+1.02,nz]],.085,6);
        this.tube('marble',[[x,y+.28,z],[nx,y+.28,nz]],.075,6);
        const dx=(nx-x)/6,dz=(nz-z)/6;
        for(let j=1;j<6;j++)this.box('marble',x+dx*j,y+.6,z+dz*j,.095,.63,.095);
        const mx=(x+nx)/2,mz=(z+nz)/2;
        this.box('marble',mx,y+.62,mz,Math.abs(nx-x)>.1?Math.abs(nx-x)-.3:.18,.48,Math.abs(nz-z)>.1?Math.abs(nz-z)-.3:.18);
        const along=unit([nx-x,0,nz-z]);
        this.tube('marble',Array.from({length:17},(_,j)=>add([mx,y+.62,mz],add(mul(along,Math.cos(j*Math.PI/8)*.57),[0,Math.sin(j*Math.PI/8)*.17,.12]))),.045,5);
      }
    }
  }
  terrace(w:number,d:number,height:number) {
    for(let level=0;level<3;level++){
      const W=w-level*8,D=d-level*14,y=height*(level+1)/3;
      this.box('stone',0,y-height/6,0,W,height/3,D);
      this.box('marble',0,y-.12,0,W+.6,.24,D+.6);
      this.box('stone-dark',0,y-height/3+.18,0,W+.35,.20,D+.35);
      for(let x=-W/2+1;x<W/2;x+=2.1){
        if(Math.abs(x)<5 || Math.abs(Math.abs(x)-20)<4)continue;
        this.box('marble',x,y-.42,D/2+.17,.52,.44,.6);
        this.tube('marble',[[x,y-.48,D/2+.3],[x,y-.58,D/2+.85]],.19,8);
        this.box('stone-dark',x,y-.60,D/2+1.03,.16,.13,.03);
      }
      this.rail(-W/2,-D/2,W/2,-D/2,y);
      this.rail(-W/2,-D/2,-W/2,D/2,y);this.rail(W/2,-D/2,W/2,D/2,y);
      for(const [a,b] of [[-W/2,-24],[-16,-5],[5,16],[24,W/2]])this.rail(a!,D/2,b!,D/2,y);
      for(const x of [-20,0,20]){
        const n=15,depth=6.7,stepH=height/3/n;
        for(let j=0;j<n;j++){
          const support=height/3-stepH*j;
          this.box('marble',x,y-height/3+support/2,D/2+depth*(j+.5)/n,x===0?8:7,support,depth/n+.04);
        }
        for(const side of [-1,1])this.tube('marble',[[x+side*4,y+1,D/2],[x+side*4,y-height/3+1,D/2+depth]],.17,6);
      }
      // Main carved stone ceremonial ramp, between the central stair flights.
      this.quad('marble',[ -2,y+.04,D/2],[2,y+.04,D/2],[2,y-height/3+.04,D/2+6.7],[-2,y-height/3+.04,D/2+6.7],[0,1,0]);
    }
  }
  roof(w:number,d:number,y:number,rise:number,trim=0,form:RoofForm='hip',ornamentScale=1) {
    const roofQuad=(a:V,b:V,c:V,d:V)=>{
      this.quad('roof',a,b,c,d,[0,1,0]);
      const under=(p:V):V=>[p[0],p[1]-.12,p[2]];
      this.quad('timber',under(a),under(b),under(c),under(d),[0,-1,0]);
    };
    const ridge=form==='pyramid'?0:Math.max(0,w/2-d*.48);
    const gableStart=form==='gable-hip'?.46:0;
    const spread=(t:number)=>Math.max(0,(t-gableStart)/(1-gableStart));
    const halfAt=(t:number)=>ridge+(w/2-ridge)*spread(t);
    const point=(u:number,t:number,side:number):V=>{
      const half=halfAt(t);
      return [u*half,y+roofRiseAt(rise,t) + .8*Math.abs(u)**12*t**8,side*t*d/2];
    };
    const N=96,T=18,tilePitch=.30;
    for(const side of [-1,1]){
      for(let i=0;i<N;i++)for(let j=Math.ceil(T*trim);j<T;j++)roofQuad(point(i/N*2-1,j/T,side),point((i+1)/N*2-1,j/T,side),point((i+1)/N*2-1,(j+1)/T,side),point(i/N*2-1,(j+1)/T,side));
      const tileCount=Math.ceil(w/tilePitch);
      for(let i=0;i<=tileCount;i++){
        const x=(i/tileCount*2-1)*w/2;
        const start=Math.max(trim,Math.abs(x)<=ridge?0:gableStart+(1-gableStart)*(Math.abs(x)-ridge)/(w/2-ridge));
        if(start>.985)continue;
        this.tube(i%7===0?'roof-aged':'roof-edge',Array.from({length:T+1},(_,j)=>{
          const t=start+(1-start)*j/T;
          return add(point(x/Math.max(.00001,halfAt(t)),t,side),[0,.11,0]);
        }),.085,7);
      }
      this.tube('roof-edge',Array.from({length:51},(_,i)=>point(i/25-1,1,side)),.23*ornamentScale,7);
    }
    for(const side of [-1,1]){
      const P=(u:number,t:number):V=>[side*halfAt(t),y+roofRiseAt(rise,t)+.8*t**8*Math.abs(u)**12,u*d/2*t];
      for(let i=0;i<24;i++)for(let j=0;j<T;j++){
        const start=Math.max(trim,gableStart),t=start+(1-start)*j/T,next=start+(1-start)*(j+1)/T;
        roofQuad(P(i/12-1,t),P((i+1)/12-1,t),P((i+1)/12-1,next),P(i/12-1,next));
      }
      const count=Math.ceil(d/tilePitch);
      for(let i=1;i<count;i++){
        const z=(i/count*2-1)*d/2,start=Math.max(trim,gableStart,Math.abs(z)/(d/2));
        this.tube('roof-edge',Array.from({length:T+1},(_,j)=>{
          const t=Math.max(.002,start+(1-start)*j/T);
          return add(P(z/(d/2*t),t),[0,.11,0]);
        }),.085,7);
      }
      this.tube('roof-edge',Array.from({length:31},(_,i)=>P(i/15-1,1)),.23*ornamentScale,7);
      if(form==='gable-hip' && trim===0){
        const base=y+roofRiseAt(rise,gableStart);
        this.quad('dark-red',[side*ridge,base,-d*gableStart/2],[side*ridge,base,d*gableStart/2],[side*ridge,y+rise,0],[side*ridge,y+rise,0],[side,0,0]);
        for(const zSide of [-1,1])this.tube('roof-edge',Array.from({length:15},(_,j)=>{
          const t=gableStart*j/14;
          return [side*ridge,y+roofRiseAt(rise,t)+.15,zSide*t*d/2] as V;
        }),.18,7);
      }
    }
    if(trim>0)return;
    // Hip ridges and their small ornaments belong to every complete roof form.
    for(const u of [-1,1])for(const side of [-1,1]){
      this.tube('roof-edge',Array.from({length:T+1},(_,j)=>add(point(u,j/T,side),[0,.16,0])),.21*ornamentScale,7);
      const count=form==='pyramid'?7:form==='gable-hip'?9:10;
      for(let j=0;j<count;j++){
        const p=point(u,.97-j*.028,side);
        this.tube('roof-edge',[[p[0],p[1]+.12*ornamentScale,p[2]],[p[0],p[1]+.50*ornamentScale,p[2]]],.11*ornamentScale,7);
        this.tube('roof-edge',[[p[0],p[1]+.4*ornamentScale,p[2]+side*.12*ornamentScale],[p[0],p[1]+.57*ornamentScale,p[2]+side*.17*ornamentScale],[p[0],p[1]+.66*ornamentScale,p[2]+side*.1*ornamentScale]],.10*ornamentScale,7);
      }
    }
    if(form==='pyramid'){
      this.finial(0,y+rise,0,Math.max(.55,w/25));
      return;
    }
    this.box('roof-edge',0,y+rise+.22*ornamentScale,0,ridge*2,.44*ornamentScale,.52*ornamentScale);
    for(const x of [-ridge,ridge]){
      this.tube('roof-edge',[[x,y+rise,0],[x+Math.sign(x)*.4*ornamentScale,y+rise+.8*ornamentScale,0],[x+Math.sign(x)*.5*ornamentScale,y+rise+1.5*ornamentScale,0],[x+Math.sign(x)*.2*ornamentScale,y+rise+2*ornamentScale,0]],.32*ornamentScale,8);
    }
  }
  finial(x:number,y:number,z:number,scale:number){
    const profile:Array<[number,number]>=[[0,.4],[.12,.48],[.2,.42],[.3,.35],[.38,.40],[.46,.30],[.58,.23],[.7,.26],[.8,.18]];
    for(let i=0;i<=24;i++){
      const angle=-Math.PI/2+i*Math.PI/24;
      profile.push([1.35+.55*Math.sin(angle),.48*Math.cos(angle)]);
    }
    for(let k=0;k<profile.length-1;k++)for(let i=0;i<32;i++){
      const p=(row:number,angle:number):V=>[x+Math.cos(angle)*profile[row]![1]!*scale,y+profile[row]![0]!*scale,z+Math.sin(angle)*profile[row]![1]!*scale];
      const a=i*Math.PI/16,b=(i+1)*Math.PI/16;
      const smooth=k>=9?(point:V):V=>unit([(point[0]-x)/(.48*.48),(point[1]-y-1.35*scale)/(.55*.55),(point[2]-z)/(.48*.48)]):undefined;
      this.quad('gold',p(k,a),p(k,b),p(k+1,b),p(k+1,a),[Math.cos(a),0,Math.sin(a)],smooth);
    }
  }

  hall(name:string,pos:V,w:number,d:number,base:number,options:HallOptions={}) {
    const {detailed=false,roof='hip',bays:[bays,depthBays]=detailed?[11,5]:[9,5],doubleEave=true,eaveHeight,overhang,roofRise,plaque,front}=options;
    if(front && front.length!==bays)throw Error('Front elevation must describe every bay: '+name);
    this.subject=name;this.offset=pos;
    const scale=w/64,h=eaveHeight??7.9*scale,lower=base+h+1.5*scale;
    const timberScale=Math.max(.75,scale),eave=overhang??3.5*scale;
    this.box('red',0,base+h*.45,0,w*.94,h*.9,d*.91);
    this.box('stone',0,base+.14,0,w+1,.28,d+1);
    for(let i=0;i<=bays;i++)for(const s of [-1,1]){
      const x=(i/bays-.5)*w;
      this.column('red',x,base,s*d/2,h,.47*timberScale);
      this.box('green',x,base+h-.3*scale,s*(d/2+.1),1.4*scale,.4*scale,1.6*scale);
    }
    for(let i=0;i<bays;i++)for(const side of [-1,1]){
      const x=((i+.5)/bays-.5)*w,bw=w/bays-.8*scale,z=side*(d*.457+.08);
      const opening=side===1?front?.[i]:undefined;
      if(opening){
        const lo=base+h*(opening==='door'?.03:.34),hi=base+h*.81;
        this.box('dark-red',x,(lo+hi)/2,z,bw,hi-lo,.15);
        for(const edge of [-1,1])this.box('red',x+edge*bw/2,(lo+hi)/2,z+.16,.11,hi-lo+.18,.18);
        for(const Y of [lo,hi])this.box('red',x,Y,z+.16,bw,.13,.18);
        if(opening==='window'){
          // Straight mullions above a solid apron, instead of full-height lattice doors.
          const n=Math.max(4,Math.round(bw/.18));
          for(let j=1;j<n;j++)this.box('red',x+(j/n-.5)*bw,(lo+hi)/2,z+.19,.055,hi-lo,.08);
          this.box('red',x,lo+(hi-lo)*.53,z+.19,bw,.09,.08);
          this.box('red',x,lo-.1,z+.25,bw+.18,.16,.4);
        }else{
          for(const side of [-1,1]){
            this.box('red',x+side*bw/4,(lo+hi)/2,z+.1,bw/2-.045,hi-lo-.12,.09);
            this.box('gold',x+side*.13,lo+(hi-lo)*.47,z+.22,.09,.17,.1);
          }
        }
        continue;
      }
      this.box('dark-red',x,base+h*.47,z,bw,h*.73,.15);
      const panels=detailed?6:3;
      for(let j=0;j<panels;j++){
        const X=x+(j/(panels-1)-.5)*(bw-.22);
        this.box('red',X,base+h*.48,z+side*.12,.09*scale,h*.70,.12);
        if(detailed){
          const pw=(bw-.22)/(panels-1)*.88,lo=base+h*.32,hi=base+h*.83;
          for(const edge of [-1,1])this.box('red',X+edge*pw/2,(lo+hi)/2,z+side*.15,.055*timberScale,hi-lo,.10);
          for(let k=0;k<=7;k++)this.box('red',X,lo+(hi-lo)*k/7,z+side*.17,pw,.055*timberScale,.10);
          for(const u of [-1/6,1/6])this.box('red',X+pw*u,(lo+hi)/2,z+side*.17,.045*timberScale,hi-lo,.10);
          for(const Y of [base+h*.13,base+h*.28])this.box('gold',X,Y,z+side*.17,pw,.035*timberScale,.08);
        }
      }
      for(const Y of [base+1.4*scale,base+h*.76])this.box('gold',x,Y,z+side*.2,bw,.05*scale,.09);
    }
    // Side elevations consume the same declared bay counts as the front.
    for(const side of [-1,1]){
      for(let i=1;i<depthBays;i++)this.column('red',side*w/2,base,(i/depthBays-.5)*d,h,.47*timberScale);
      for(let i=0;i<depthBays;i++){
        const z=((i+.5)/depthBays-.5)*d,bw=d/depthBays-.9;
        this.box('dark-red',side*(w*.471+.1),base+h*.47,z,.18,h*.73,bw);
        for(let j=0;j<6;j++){
          const Z=z+(j/5-.5)*(bw-.25),X=side*(w*.471+.24);
          this.box('red',X,base+h*.48,Z,.12,h*.70,.09);
          if(detailed){
            const pw=(bw-.25)/5*.88,lo=base+h*.32,hi=base+h*.83;
            for(const edge of [-1,1])this.box('red',X,(lo+hi)/2,Z+edge*pw/2,.10,hi-lo,.055*timberScale);
            for(let k=0;k<=7;k++)this.box('red',X,lo+(hi-lo)*k/7,Z,.10,.055*timberScale,pw);
            for(const u of [-1/6,1/6])this.box('red',X,(lo+hi)/2,Z+pw*u,.10,hi-lo,.045*timberScale);
          }
        }
      }
      for(const upper of (doubleEave?[false,true]:[false])){
        const y=(upper?lower+4.7*scale:lower)-1.15*timberScale;
        const bx=side*(upper?w*.45:w/2),bd=upper?d*.65:d;
        this.box('caihua',bx,y,0,.75*scale,1.15*timberScale,bd+scale);
        for(const dy of [-.49,.49])this.box('gold',bx+side*.4*scale,y+dy*scale,0,.08*scale,.07*scale,bd+scale);
        for(let j=0;j<32;j++){
          const z=(j/31-.5)*bd;
          this.box('green',bx+side*.5*scale,y+.4*scale,z,1.6*scale,.25*scale,.62*scale);
          this.box('blue',bx+side*.8*scale,y+.73*scale,z,1.8*scale,.3*scale,.4*scale);
        }
      }
    }
    for(const side of [-1,1])for(const upper of (doubleEave?[false,true]:[false])){
      const y=(upper?lower+4.7*scale:lower)-1.15*timberScale;
      const beamDepth=upper?d*.65/2:d/2;
      const beamWidth=upper?w*.90:w;
      this.box('caihua',0,y,side*(beamDepth+.4),beamWidth+1,1.15*timberScale,.7*scale);
      for(const dy of [-.49,.49])this.box('gold',0,y+dy*scale,side*(beamDepth+.79),beamWidth+1,.07*scale,.08);
      const count=detailed?66:24;
      for(let j=0;j<count;j++){
        const x=(j/(count-1)-.5)*beamWidth;
        this.box('green',x,y+.4*scale,side*(beamDepth+.9*scale),.62*scale,.25*scale,1.6*scale);
        this.box('blue',x,y+.73*scale,side*(beamDepth+1.12*scale),.4*scale,.3*scale,1.8*scale);
        if(detailed)this.tube('gold',[[x-.26,y-.2,side*(beamDepth+.78)],[x,y+.17,side*(beamDepth+.8)],[x+.26,y-.2,side*(beamDepth+.78)]],.03,4);
      }
    }
    if(doubleEave){
      this.roof(w+2*eave,d+2*eave,lower,11*scale,.58);
      this.box('dark-red',0,lower+2.4*scale,0,w*.90,3.5*scale,d*.65);
      this.roof(w*.90+3*scale,d*.65+3*scale,lower+4.7*scale,10.8*scale,0,roof);
    } else this.roof(w+2*eave,d+2*eave,lower,roofRise??Math.max(6.5,11*scale),0,roof);
    if(detailed){
      const pz=doubleEave?(d*.65+3*scale)/2+.7*scale:d/2+.7;
      const floor=lower+roofRiseAt(11*scale,2*(pz+.16)/(d+2*eave));
      const ceiling=lower+4.7*scale-.15;
      const ph=doubleEave?Math.min(2.6,(ceiling-floor)*.84):1.3;
      const py=doubleEave?(floor+ceiling)/2:base+h-.35,pw=doubleEave?Math.min(1.9,ph*.73):.95;
      this.box('blue',0,py,pz,pw,ph,.3);
      if(plaque)this.quad(plaque,[-pw/2,py-ph/2,pz+.16],[pw/2,py-ph/2,pz+.16],[pw/2,py+ph/2,pz+.16],[-pw/2,py+ph/2,pz+.16],[0,0,1],undefined,p=>[(p[0]+pw/2)/pw,1-(p[1]-py+ph/2)/ph]);
      for(const x of [-1,1])this.box('gold',x*(pw/2+.05),py,pz+.18,.1,ph+.2,.08);
      for(const yy of [-1,1])this.box('gold',0,py+yy*(ph/2+.05),pz+.18,pw+.2,.1,.08);
    }
  }
  cornerTower(pos:V) {
    this.subject=`Corner tower ${pos[0]} ${pos[2]}`;this.offset=pos;this.yaw=0;
    const half=8.73/2,base=10,h=5.7;
    this.box('stone',0,base/2,0,21,base,21);
    this.box('stone',0,base-.35,0,19,.7,19);
    for(const side of [-1,1]){
      this.rail(-9,side*9,9,side*9,base);
      this.rail(side*9,-9,side*9,9,base);
    }
    this.box('red',0,base+h/2,0,8.73,h,8.73);
    // Four narrow projecting bays preserve the measured outer/inner asymmetry.
    for(const axis of [0,2])for(const side of [-1,1]){
      this.offset=pos;this.yaw=0;
      const depth=side===Math.sign(pos[axis]!)?1.60:3.98;
      const center=side*(half+depth/2),front=side*(half+depth);
      if(axis===0)this.box('red',center,base+h/2,0,depth,h,2.91);
      else this.box('red',0,base+h/2,center,2.91,h,depth);
      this.yaw=axis===0?Math.PI/2:0;
      this.offset=axis===0?add(pos,[front,0,0]):add(pos,[0,0,front]);
      const outward=side;
      this.box('dark-red',0,base+2.7,outward*.04,2.65,4.5,.1);
      for(let i=0;i<7;i++)this.box('gold',(i/6-.5)*2.55,base+3.1,outward*.11,.045,3.2,.05);
      for(let i=0;i<10;i++)this.box('gold',0,base+1.5+i*.34,outward*.13,2.55,.04,.05);
      for(const x of [-1.455,1.455])this.column('dark-red',x,base,0,h,.20);
    }
    this.offset=pos;
    for(const turn of [0,1,2,3]){
      this.yaw=turn*Math.PI/2;
      for(const x of [-2.91,2.91]){
        this.box('dark-red',x,base+2.8,half+.025,2.5,4.4,.06);
        for(let i=0;i<7;i++)this.box('gold',x+(i/6-.5)*2.35,base+3.1,half+.075,.035,3.1,.04);
        for(let i=0;i<10;i++)this.box('gold',x,base+1.55+i*.34,half+.09,2.35,.035,.04);
      }
    }
    this.yaw=0;
    // Three interlocked roof levels; detailed joinery remains a visual estimate.
    const belt=(width:number,y:number)=>{
      for(const turn of [0,1,2,3]){
        this.yaw=turn*Math.PI/2;
        this.box('caihua',0,y, width/2,width,1.0,.38);
        for(let i=0;i<15;i++){
          const x=(i/14-.5)*width;
          this.box('green',x,y+.36,width/2+.18,.32,.2,.85);
          this.box('blue',x,y+.58,width/2+.35,.24,.22,1.05);
        }
      }
      this.yaw=0;
    };
    belt(10.5,15.5);this.roof(16.4,16.4,16.5,3.7,.65,'pyramid',.55);
    belt(8.4,18.0);this.roof(12.8,12.8,18.8,3.0,.62,'pyramid',.55);
    for(const axis of [0,2])for(const side of [-1,1]){
      this.offset=pos;this.yaw=0;
      const depth=side===Math.sign(pos[axis]!)?1.60:3.98;
      const center=side*(half+depth/2-1.3);
      this.offset=axis===0?add(pos,[center,0,0]):add(pos,[0,0,center]);
      this.yaw=axis===0?0:Math.PI/2;
      this.roof(depth+7.5,6.9,16.5,3.7,.65,'gable-hip',.55);
      this.roof(depth+6.2,6.0,19.0,2.8,0,'gable-hip',.55);
    }
    this.offset=pos;this.yaw=0;
    this.box('timber',0,18.9,0,7.1,4.4,7.1);
    belt(6.9,20.7);
    for(const turn of [0,1]){this.yaw=turn*Math.PI/2;this.roof(12,7.4,21.5,4.9,0,'gable-hip',.45);}
    this.yaw=0;this.finial(0,26.4,0,(27.5-26.4)/1.9);
  }
  platform(row:typeof footprints[number],height:number) {
    this.subject='Inner hall platform '+row.id;this.offset=[0,0,0];
    const poly=row.polygon,triangles=footprintTriangles[row.id]!;
    const P=(i:number,y:number):V=>[poly[i]![0]!,y,poly[i]![1]!];
    const area=poly.slice(0,-1).reduce((sum,a,i)=>sum+a[0]!*poly[i+1]![1]!-poly[i+1]![0]!*a[1]!,0);
    for(let i=0;i<poly.length-1;i++){
      const a=poly[i]!,b=poly[i+1]!;
      const n:V=unit([(b[1]!-a[1]!)*Math.sign(area),0,-(b[0]!-a[0]!)*Math.sign(area)]);
      this.quad('stone',P(i,0),P(i+1,0),P(i+1,height),P(i,height),n);
    }
    for(let i=0;i<triangles.length;i+=3){
      const a=P(triangles[i]!,height),b=P(triangles[i+1]!,height),c=P(triangles[i+2]!,height);
      this.quad('stone',a,b,c,c,[0,1,0]);
    }
  }
  glazedParapet(x:number,z1:number,z2:number,y:number){
    this.box('green',x,y+.1,(z1+z2)/2,.35,.2,z2-z1);
    const count=Math.ceil((z2-z1)/.4),step=(z2-z1)/count;
    for(let i=0;i<count;i++)for(let j=0;j<2;j++)this.box((i+j)%2?'green':'roof-edge',x,y+.3+j*.19,z1+(i+.5)*step,.28,.19,step);
    this.box('green',x,y+.67,(z1+z2)/2,.48,.13,z2-z1);
    this.sweep('roof-edge',[[x,y+.76,z1],[x,y+.76,z2]],.12,8);
  }
  /** Context buildings derive their placement and wall outlines from the mapped footprint. */
  mappedBuilding(row:typeof footprints[number]) {
    const {x,z,width:w,depth:d}=row;
    if(w>130||d>130)return;
    this.subject='Precinct '+Math.floor((x+375)/125)+' '+Math.floor((z+565)/160);this.offset=[0,0,0];
    const wallOnly=row.label.includes('墙');
    const totalHeight=row.height===null?undefined:Number(row.height);
    if(totalHeight!==undefined&&(!Number.isFinite(totalHeight)||totalHeight<=0))throw Error('Invalid metric height on footprint '+row.id);
    const partition=wallOnly?undefined:roofPartitions[row.id];
    if(!wallOnly&&!partition)throw Error('Missing context roof partition for footprint '+row.id);
    let maxTime=0;for(let i=2;i<(partition?.vertices.length??0);i+=3)maxTime=Math.max(maxTime,partition!.vertices[i]!);
    const rise=wallOnly?0:Math.min(6,maxTime*.54,(totalHeight??Infinity)*.5);
    const ridgeRadius=Math.min(.14,(totalHeight??Infinity)*.05),ridgeLift=Math.min(.1,(totalHeight??Infinity)*.05);
    const h=totalHeight===undefined?(wallOnly?3.2:4.7):totalHeight-rise-(wallOnly?0:ridgeRadius+ridgeLift);
    const poly=row.polygon;
    let area=0;for(let i=0;i<poly.length-1;i++)area+=poly[i]![0]*poly[i+1]![1]-poly[i+1]![0]*poly[i]![1];
    for(let i=0;i<poly.length-1;i++){
      const a=poly[i]!,b=poly[i+1]!;
      const n:V=unit([(b[1]-a[1])*Math.sign(area),0,-(b[0]-a[0])*Math.sign(area)]);
      this.quad('red',[a[0],0,a[1]],[b[0],0,b[1]],[b[0],h,b[1]],[a[0],h,a[1]],n);
    }
    if(wallOnly)return;
    const {vertices,triangles,ridges}=partition!;
    const pitch=rise/Math.max(maxTime,.001);
    const P=(i:number):V=>[x+vertices[i*3]!,h+vertices[i*3+2]!*pitch,z+vertices[i*3+1]!];
    for(let i=0;i<triangles.length;i+=3){
      const a=P(triangles[i]!),b=P(triangles[i+1]!),c=P(triangles[i+2]!);
      this.quad('roof',a,b,c,c,[0,1,0]);
    }
    for(let i=0;i<ridges.length;i+=2)this.tube('roof-edge',[add(P(ridges[i]!),[0,ridgeLift,0]),add(P(ridges[i+1]!),[0,ridgeLift,0])],ridgeRadius,5);
    const eaveRadius=Math.min(.1,(rise+ridgeLift+ridgeRadius)/2);
    for(let i=0;i<poly.length-1;i++)this.tube('roof-edge',[[poly[i]![0]!,h+eaveRadius*.8,poly[i]![1]!],[poly[i+1]![0]!,h+eaveRadius*.8,poly[i+1]![1]!]],eaveRadius,5);

  }
  meshes():Record<string,{mesh:MeshAsset;material:string}> {
    return Object.fromEntries([...this.groups].map(([key,g])=>{
      const result=meshFromInterleaved(g.vertices.view() as Float32Array,g.indices.view() as Uint32Array);
      if(!result.ok)throw result.error;
      return [key,{mesh:result.value,material:g.material}];
    }));
  }
}

export function buildPalace() {
  if(createHash('sha256').update(JSON.stringify(footprints)).digest('hex')!==roofFootprintDigest)throw Error('Roof partition source is stale; run node tools/roof-authoring/generate.mjs before building the Palace.');
  const a=new Architecture();
  a.subject='Taihedian terrace';a.terrace(112,76,8.13);
  a.hall('Taihedian',[0,0,-5],63.96,37.2,8.13,{detailed:true,plaque:'taihedian-plaque'});
  a.subject='Surrounding ground';a.offset=[0,0,0];a.box('paving',0,-1.3,-65,1900,1,2000);
  a.subject='Precinct ground';a.box('paving',0,-.65,-65,753,1,1020);
  a.subject='Central terrace';a.offset=[0,0,-90];a.box('stone',0,4,-2,84,8,150);
  a.subject='Forecourt';a.offset=[0,0,0];
  a.box('paving',0,-.35,125,250,.7,210);
  // Paving courses and the central processional path stay authored geometry.
  for(let z=40;z<220;z+=4) a.box('paving-joint',0,.008,z,250,.016,.06);
  for(let x=-125;x<=125;x+=3) a.box('paving-joint',x,.009,130,.04,.018,180);
  a.box('stone',0,.014,130,5,.028,180);
  for(let z=42;z<220;z+=2.5)a.box('paving-joint',0,.036,z,5,.01,.045);
  for(const row of footprints){
    // Museum-correlated platform outlines are authored explicitly, never inferred from height.
    if(row.id===638981252||row.id===638981261){a.platform(row,2);continue;}
    if([638449347,638473398,638156366,638308745,638981317,638981229,639012193,638741722,638981206,638981215,638981227,638981228].includes(row.id))continue;
    if(Math.abs(row.x)<18 && row.z>-91 && row.z<-47)continue;
    // The authored terrace replaces intersecting unmapped-detail structures here.
    if(Math.abs(row.x)<64 && row.z>-42 && row.z<40)continue;
    // The authored gate assembly replaces intersecting map envelopes, including its passages.
    if(row.x+row.width/2>=-82 && row.x-row.width/2<=82 && row.z+row.depth/2>=356 && row.z-row.depth/2<=455)continue;
    a.mappedBuilding(row);
  }
  a.subject='Inner hall glazed parapets';a.offset=[0,0,0];
  for(const x of [-14.7,12.4])for(const [z1,z2] of [[-377,-363.8],[-358,-344.5]])a.glazedParapet(x,z1!,z2!,2);
  a.hall('Zhonghedian',[0,0,-70],25,25,8.13,{roof:'pyramid',bays:[3,3],doubleEave:false,eaveHeight:5.6});
  a.hall('Baohedian',[0,0,-128],50,25,8.13,{roof:'gable-hip'});
  a.hall('Taihemen',[0,0,210],58,27,3.5,{roof:'gable-hip',bays:[9,4]});
  a.hall('Qianqinggong',[0,0,-322],47,22,2);
  a.hall('Jiaotaidian',[0,0,-360],13.5,13.5,2,{detailed:true,roof:'pyramid',bays:[3,3],doubleEave:false,eaveHeight:4.1,overhang:4.15,roofRise:3.7,plaque:'jiaotaidian-plaque'});
  a.hall('Kunninggong',[0,0,-391],45,19,2,{bays:[9,3],front:['window','window','window','window','window','door','window','window','window']});
  a.hall('Shenwumen',[0,0,-565],40,17,10);
  a.hall('Wumen',[0,0,378],60,25,12);
  for(const side of [-1,1])for(const z of [375,435])a.hall('Wumen wings '+side+' '+z,[side*67,0,z],22,22,12,{roof:'pyramid',bays:[3,3]});
  a.subject='Meridian Gate walls';a.offset=[0,0,0];
  a.archedWall(145,12,34,[0,378],[-20,0,20].map(x=>({x,radius:x===0?3.6:2.8,spring:4.4})));
  for(const x of [-67,67])a.archedWall(90,12,25,[x,408],[{x:0,radius:2.4,spring:4.2}],'x');
  a.subject='Imperial waterways';a.offset=[0,0,0];
  for(const {polygon,triangles} of waterways){
    const point=(i:number,y:number):V=>[polygon[i]![0]!,y,polygon[i]![1]!];
    for(let i=0;i<triangles.length;i+=3){
      const A=point(triangles[i]!, .06),B=point(triangles[i+1]!, .06),C=point(triangles[i+2]!, .06);
      a.quad('water',A,B,C,C,[0,1,0]);
    }
    // The bank follows the same measured contour; it does not invent a parallel river path.
    for(let i=0;i<polygon.length;i++){
      const j=(i+1)%polygon.length;
      a.quad('stone-dark',point(i,-.15),point(j,-.15),point(j,.26),point(i,.26));
      a.tube('stone',[point(i,.26),point(j,.26)],.17,4);
    }
  }
  for(const bridge of jinshuiBridges){
    a.subject='Jinshui bridge '+bridge.id;
    const A=bridge.points[0]!,B=bridge.points.at(-1)!;
    const length=Math.hypot(B[0]!-A[0]!,B[1]!-A[1]!),dx=(B[0]!-A[0]!)/length,dz=(B[1]!-A[1]!)/length;
    const width=bridge.id===41439020?8:5.3;
    const top=(t:number)=>.18+1.35*Math.sin(Math.PI*t);
    const P=(u:number,y:number,t:number):V=>[A[0]!+dx*length*t-dz*u,y,A[1]!+dz*length*t+dx*u];
    for(let i=0;i<20;i++){
      const t=i/20,n=(i+1)/20,lo=top(t)-.45,hi=top(n)-.45;
      a.quad('marble',P(-width/2,top(t),t),P(width/2,top(t),t),P(width/2,top(n),n),P(-width/2,top(n),n),[0,1,0]);
      a.quad('stone',P(-width/2,lo,t),P(-width/2,hi,n),P(width/2,hi,n),P(width/2,lo,t),[0,-1,0]);
      for(const side of [-1,1])a.quad('marble',P(side*width/2,lo,t),P(side*width/2,hi,n),P(side*width/2,top(n),n),P(side*width/2,top(t),t),[-dz*side,0,dx*side]);
    }
    for(const t of [0,1])a.quad('stone',P(-width/2,top(t)-.45,t),P(width/2,top(t)-.45,t),P(width/2,top(t),t),P(-width/2,top(t),t),[dx*(t===0?-1:1),0,dz*(t===0?-1:1)]);
    for(const side of [-1,1]){
      const u=side*(width/2-.18);
      a.tube('marble',Array.from({length:33},(_,i)=>P(u,top(i/32)+1.10,i/32)),.10,7);
      for(let i=0;i<=10;i++){
        const t=i/10,pos=P(u,top(t),t);
        a.box('marble',pos[0],pos[1]+.55,pos[2],.3,1.10,.3);
        a.tube('marble',[P(u,top(t)+1.10,t),P(u,top(t)+1.38,t)],.22,8);
        if(i<10){const n=(i+1)/10;
          a.quad('marble',P(u,top(t)+.2,t),P(u,top(n)+.2,n),P(u,top(n)+.85,n),P(u,top(t)+.85,t),[-dz*side,0,dx*side]);
          a.quad('marble',P(u,top(t)+.2,t),P(u,top(n)+.2,n),P(u,top(n)+.85,n),P(u,top(t)+.85,t),[dz*side,0,-dx*side]);
        }
      }
    }
  }
  a.subject='Garden trees';a.offset=[0,0,0];
  for(let i=0;i<85;i++){
    const x=((i*67)%151)-75,z=-510+((i*43)%70),h=5+(i%5);
    a.column('bark',x,0,z,h,.25);
    for(let l=0;l<3;l++){
      const radius=2.5-l*.45,y=h-3+l*1.5;
      for(let k=0;k<9;k++){
        const t=k*Math.PI*2/9,u=(k+1)*Math.PI*2/9;
        a.quad('foliage',[x+Math.cos(t)*radius,y,z+Math.sin(t)*radius],[x+Math.cos(u)*radius,y,z+Math.sin(u)*radius],[x,y+4,z],[x,y+4,z],[0,1,0]);
      }
    }
  }
  // Perimeter, moat and corner towers constrain the full precinct silhouette.
  a.subject='Palace perimeter';a.offset=[0,0,0];
  for(const x of [-376,376])a.box('red',x,5,-61,9,10,966);
  for(const z of [-565,435])for(const side of [-1,1])a.box('red',side*217,5,z,318,10,9);
  for(const x of [-376,376])for(const z of [-565,435])a.cornerTower([x,0,z]);
  return a;
}
