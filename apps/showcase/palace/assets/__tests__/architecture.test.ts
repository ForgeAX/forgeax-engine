import { expect, it } from 'vitest';
import { Architecture, buildPalace } from '../architecture.ts';
import { footprints } from '../footprints.ts';
import { roofPartitions, roofFootprintDigest } from '../roof-partitions.ts';
import { createHash } from 'node:crypto';
it('exports finite normals and valid indexed architecture', () => {
  const groups=buildPalace().meshes();
  expect(Object.keys(groups).some(key=>key.startsWith('taihedian/'))).toBe(true);
  expect(Object.keys(groups).some(key=>key.startsWith('wumen/'))).toBe(true);
  for(const [name,{mesh}] of Object.entries(groups)) {
    expect(name).toMatch(/^[a-z0-9][a-z0-9/._-]*$/);
    const v=mesh.vertices;
    for(let i=0;i<v.length;i+=12){
      for(let j=0;j<12;j++)if(!Number.isFinite(v[i+j]))throw Error('Non-finite vertex '+name);
      if(Math.hypot(v[i+3]!,v[i+4]!,v[i+5]!)<.99)throw Error('Missing normal '+name);
    }
    if(mesh.indices===undefined)throw Error('Missing index buffer '+name);
    for(const index of mesh.indices)if(index<0||index>=v.length/12)throw Error('Invalid index '+name);
  }
});

it('places the single pyramidal halls under one central gilded finial', () => {
  const groups=buildPalace().meshes();
  for(const [name,z] of [['zhonghedian',-70],['jiaotaidian',-360]] as const){
    const mesh=groups[name+'/gold']?.mesh;
    expect(mesh, name+' gilded finial').toBeDefined();
    const vertices=mesh!.vertices;
    let highest=-Infinity;
    for(let i=0;i<vertices.length;i+=12)highest=Math.max(highest,vertices[i+1]!);
    const peak=[];
    for(let i=0;i<vertices.length;i+=12)if(vertices[i+1]!>highest-.0001)peak.push([vertices[i]!,vertices[i+2]!]);
    expect(peak.length).toBeGreaterThan(0);
    for(const [x,pz] of peak){expect(Math.abs(x!)).toBeLessThan(.1);expect(Math.abs(pz!-z)).toBeLessThan(.1);}
  }
});

it('keeps all five Meridian Gate passages open through their walls', () => {
  const groups=buildPalace().meshes();
  const intersects=(x:number,y:number,axis:'x'|'z'='z',span:[number,number]=[360,396])=>{
    const plane=axis==='z'?0:2,depth=axis==='z'?2:0;
    for(const [key,{mesh}] of Object.entries(groups)){
      const v=mesh.vertices,idx=mesh.indices!;
      for(let i=0;i<idx.length;i+=3){
        const a=idx[i]!*12,b=idx[i+1]!*12,c=idx[i+2]!*12;
        const bx=v[b+plane]!-v[a+plane]!,by=v[b+1]!-v[a+1]!,cx=v[c+plane]!-v[a+plane]!,cy=v[c+1]!-v[a+1]!;
        const det=bx*cy-by*cx;if(Math.abs(det)<1e-8)continue;
        const dx=x-v[a+plane]!,dy=y-v[a+1]!,u=(dx*cy-dy*cx)/det,t=(bx*dy-by*dx)/det;
        if(u<0||t<0||u+t>1)continue;
        const z=v[a+depth]!+u*(v[b+depth]!-v[a+depth]!)+t*(v[c+depth]!-v[a+depth]!);
        if(z>=span[0]&&z<=span[1])return true;
      }
    }
    return false;
  };
  for(const x of [-20,0,20])expect(intersects(x,2),'open passage '+x).toBe(false);
  for(const span of [[-80,-54],[54,80]] as [number,number][])expect(intersects(408,2,'x',span),'open side passage').toBe(false);
  expect(intersects(10,2),'solid pier').toBe(true);
  expect(intersects(0,11),'solid wall above arch').toBe(true);
});

it('fills the stone staircase below each tread instead of floating slabs', () => {
  const mesh=buildPalace().meshes()['taihedian-terrace/marble']!.mesh;
  const v=mesh.vertices,indices=mesh.indices!,x=20.123,z=25.127,y=6.2,hits=new Set<number>();
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i]!*12,b=indices[i+1]!*12,c=indices[i+2]!*12;
    const bx=v[b]!-v[a]!,bz=v[b+2]!-v[a+2]!,cx=v[c]!-v[a]!,cz=v[c+2]!-v[a+2]!;
    const det=bx*cz-bz*cx;if(Math.abs(det)<1e-8)continue;
    const dx=x-v[a]!,dz=z-v[a+2]!,u=(dx*cz-dz*cx)/det,t=(bx*dz-bz*dx)/det;
    if(u<0||t<0||u+t>1)continue;
    const hit=v[a+1]!+u*(v[b+1]!-v[a+1]!)+t*(v[c+1]!-v[a+1]!);
    if(hit>y)hits.add(Math.round(hit*10000));
  }
  expect(hits.size%2,'point under the tread lies inside solid stair masonry').toBe(1);
});


it('preserves the dry Wumen approach and places Jinshui water under its mapped bridges', () => {
  const mesh=buildPalace().meshes()['imperial-waterways/water']!.mesh;
  const covers=(x:number,z:number)=>{
    const v=mesh.vertices,idx=mesh.indices!;
    for(let i=0;i<idx.length;i+=3){
      const a=idx[i]!*12,b=idx[i+1]!*12,c=idx[i+2]!*12;
      const bx=v[b]!-v[a]!,bz=v[b+2]!-v[a+2]!,cx=v[c]!-v[a]!,cz=v[c+2]!-v[a+2]!;
      const det=bx*cz-bz*cx;if(Math.abs(det)<1e-8)continue;
      const dx=x-v[a]!,dz=z-v[a+2]!,u=(dx*cz-dz*cx)/det,t=(bx*dz-bz*dx)/det;
      if(u>=0&&t>=0&&u+t<=1)return true;
    }
    return false;
  };
  expect(covers(0,468),'dry approach south of Wumen').toBe(false);
  expect(covers(0,306),'water beneath the central mapped Jinshui bridge').toBe(true);
});


it('keeps context roofs on their concave footprint instead of covering courtyard voids', () => {
  const row=footprints.find(v=>v.id===638981252)!;
  const a=new Architecture();a.mappedBuilding(row);
  const polygon=row.polygon;
  let footprintArea=0;
  for(let i=0;i<polygon.length-1;i++)footprintArea+=polygon[i]![0]!*polygon[i+1]![1]!-polygon[i+1]![0]!*polygon[i]![1]!;
  footprintArea=Math.abs(footprintArea)/2;
  let roofArea=0;
  for(const [key,{mesh}] of Object.entries(a.meshes())){
    if(!key.endsWith('/roof'))continue;
    const v=mesh.vertices,indices=mesh.indices!;
    for(let i=0;i<indices.length;i+=3){
      const A=indices[i]!*12,B=indices[i+1]!*12,C=indices[i+2]!*12;
      roofArea+=Math.abs((v[B]!-v[A]!)*(v[C+2]!-v[A+2]!)-(v[B+2]!-v[A+2]!)*(v[C]!-v[A]!))/2;
    }
  }
  expect(roofArea,'roof projection must not fill courtyard voids').toBeLessThan(footprintArea*1.02);
  expect(roofArea,'roof projection covers the actual building').toBeGreaterThan(footprintArea*.98);
});


it('keeps inner-hall decks and neighboring ground free of invented map roofs', () => {
  const groups=buildPalace().meshes();
  for(const [x,z,expected] of [[0,-340,2],[0,-300,2],[14,-352,-.15]]){
    let highest=-Infinity;
    for(const {mesh} of Object.values(groups)){
      const v=mesh.vertices,indices=mesh.indices!;
      for(let i=0;i<indices.length;i+=3){
        const a=indices[i]!*12,b=indices[i+1]!*12,c=indices[i+2]!*12;
        const bx=v[b]!-v[a]!,bz=v[b+2]!-v[a+2]!,cx=v[c]!-v[a]!,cz=v[c+2]!-v[a+2]!;
        const det=bx*cz-bz*cx;if(Math.abs(det)<1e-8)continue;
        const dx=x!-v[a]!,dz=z!-v[a+2]!,u=(dx*cz-dz*cx)/det,t=(bx*dz-bz*dx)/det;
        if(u<0||t<0||u+t>1)continue;
        highest=Math.max(highest,v[a+1]!+u*(v[b+1]!-v[a+1]!)+t*(v[c+1]!-v[a+1]!));
      }
    }
    expect(highest,'unobstructed authored surface at '+x+','+z).toBeCloseTo(expected!,2);
  }
});


it('provides a continuous downward-facing roof deck between the eave rafters', () => {
  const a=new Architecture();a.roof(20,20,7.2,6.5,0,'pyramid');
  const groups=a.meshes();
  for(const [x,z] of [[.127,9.173],[-4.234,8.719],[3.951,9.137]]){
    let visible=false;
    for(const {mesh} of Object.values(groups)){
      const v=mesh.vertices,indices=mesh.indices!;
      for(let i=0;i<indices.length;i+=3){
        const A=indices[i]!*12,B=indices[i+1]!*12,C=indices[i+2]!*12;
        if(v[A+4]!+v[B+4]!+v[C+4]!>=-.1)continue;
        const bx=v[B]!-v[A]!,bz=v[B+2]!-v[A+2]!,cx=v[C]!-v[A]!,cz=v[C+2]!-v[A+2]!;
        const det=bx*cz-bz*cx;if(Math.abs(det)<1e-8)continue;
        const dx=x!-v[A]!,dz=z!-v[A+2]!,u=(dx*cz-dz*cx)/det,t=(bx*dz-bz*dx)/det;
        if(u<0||t<0||u+t>1)continue;
        const y=v[A+1]!+u*(v[B+1]!-v[A+1]!)+t*(v[C+1]!-v[A+1]!);
        if(y>7)visible=true;
      }
    }
    expect(visible,'opaque roof underside at '+x+','+z).toBe(true);
  }
});


it('gives round columns radial unit normals without polygonal lighting bands', () => {
  const a=new Architecture();a.subject='Column normal probe';a.column('red',2,3,4,5,.47);
  const v=a.meshes()['column-normal-probe/red']!.mesh.vertices;
  for(let i=0;i<v.length;i+=12){
    const dx=v[i]!-2,dz=v[i+2]!-4,r=Math.hypot(dx,dz);
    const radialDot=(v[i+3]!*dx+v[i+5]!*dz)/r;
    expect(radialDot).toBeGreaterThan(.9999);
    expect(Math.abs(v[i+4]!)).toBeLessThan(.0001);
  }
});


it('keeps a double-eave hall name panel visible between its roof surfaces', () => {
  const a=new Architecture();a.hall('Plaque clearance',[0,0,0],64,37.2,8.13,{detailed:true,plaque:'name-panel'});
  const groups=a.meshes(),panel=groups['plaque-clearance/name-panel']!.mesh.vertices;
  let lo=Infinity,hi=-Infinity,z=-Infinity;
  for(let i=0;i<panel.length;i+=12){lo=Math.min(lo,panel[i+1]!);hi=Math.max(hi,panel[i+1]!);z=Math.max(z,panel[i+2]!);}
  for(const ratio of [.1,.2,.3,.4,.5,.6,.7,.8,.9]){
    const x=.123,y=lo+(hi-lo)*ratio,slope=(17-y)/(56-z);
    for(const [material,{mesh}] of Object.entries(groups)){
      if(material==='plaque-clearance/name-panel')continue;
      const v=mesh.vertices,indices=mesh.indices!;
      const Y=(i:number)=>v[i+1]!-slope*(v[i+2]!-z);
      for(let i=0;i<indices.length;i+=3){
        const ia=indices[i]!*12,ib=indices[i+1]!*12,ic=indices[i+2]!*12;
        const bx=v[ib]!-v[ia]!,by=Y(ib)-Y(ia),cx=v[ic]!-v[ia]!,cy=Y(ic)-Y(ia),det=bx*cy-by*cx;
        if(Math.abs(det)<1e-9)continue;
        const dx=x-v[ia]!,dy=y-Y(ia),u=(dx*cy-dy*cx)/det,t=(bx*dy-by*dx)/det;
        if(u<0||t<0||u+t>1)continue;
        const depth=v[ia+2]!+u*(v[ib+2]!-v[ia+2]!)+t*(v[ic+2]!-v[ia+2]!);
        if(depth>z+.001)throw Error('Plaque obscured by '+material+' at row '+ratio);
      }
    }
  }
});


it('keeps roof tile rolls at an architectural pitch on ordinary hip roofs', () => {
  const a=new Architecture();a.subject='Roof pitch';a.roof(48,26,8,6);
  const intervals:Array<[number,number]>=[];
  for(const material of ['roof-edge','roof-aged']){
    const mesh=a.meshes()['roof-pitch/'+material]!.mesh,v=mesh.vertices,idx=mesh.indices!;
    for(let i=0;i<idx.length;i+=3){
      const intersections:number[]=[];
      for(let j=0;j<3;j++){
        const ia=idx[i+j]!*12,ib=idx[i+(j+1)%3]!*12,za=v[ia+2]!,zb=v[ib+2]!;
        if(Math.abs(zb-za)<1e-9||Math.min(za,zb)>12||Math.max(za,zb)<12)continue;
        intersections.push(v[ia]!+(v[ib]!-v[ia]!)*(12-za)/(zb-za));
      }
      if(intersections.length>=2){const lo=Math.min(...intersections),hi=Math.max(...intersections);if(lo>-6&&hi<6)intervals.push([lo,hi]);}
    }
  }
  intervals.sort((a,b)=>a[0]-b[0]);expect(intervals.length).toBeGreaterThan(0);
  let end=intervals[0]![1],gap=0;
  for(const [lo,hi] of intervals){gap=Math.max(gap,lo-end);end=Math.max(end,hi);}
  expect(gap).toBeLessThan(.4);
});

it('shares tube ring vertices while preserving outward triangles', () => {
  const a=new Architecture();a.subject='Tube';a.tube('red',[[0,0,0],[0,1,0],[0,2,0]],1,7);
  const mesh=a.meshes()['tube/red']!.mesh,v=mesh.vertices,idx=mesh.indices!;
  expect(v.length/12).toBeLessThanOrEqual(24);
  expect(idx.length).toBe(84);
  for(let i=0;i<idx.length;i+=3){
    const a=idx[i]!*12,b=idx[i+1]!*12,c=idx[i+2]!*12;
    const bx=v[b]!-v[a]!,by=v[b+1]!-v[a+1]!,bz=v[b+2]!-v[a+2]!;
    const cx=v[c]!-v[a]!,cy=v[c+1]!-v[a+1]!,cz=v[c+2]!-v[a+2]!;
    const nx=by*cz-bz*cy,nz=bx*cy-by*cx;
    expect(nx*v[a]!+nz*v[a+2]!).toBeGreaterThan(0);
  }
});

it('keeps each context roof slope planar instead of smoothing across its ridges', () => {
  const row=footprints.find(r=>r.id===40478517)!;
  const a=new Architecture();a.mappedBuilding(row);
  const mesh=Object.entries(a.meshes()).find(([key])=>key.endsWith('/roof'))![1].mesh;
  const v=mesh.vertices,idx=mesh.indices!;
  for(let i=0;i<idx.length;i+=3){
    const a=idx[i]!*12,b=idx[i+1]!*12,c=idx[i+2]!*12;
    const bx=v[b]!-v[a]!,by=v[b+1]!-v[a+1]!,bz=v[b+2]!-v[a+2]!;
    const cx=v[c]!-v[a]!,cy=v[c+1]!-v[a+1]!,cz=v[c+2]!-v[a+2]!;
    const n=[by*cz-bz*cy,bz*cx-bx*cz,bx*cy-by*cx],length=Math.hypot(...n);
    if(length<1e-8)continue;
    for(const p of [a,b,c])expect((n[0]!*v[p+3]!+n[1]!*v[p+4]!+n[2]!*v[p+5]!)/length).toBeGreaterThan(.9999);
  }
});

it('keeps every offline roof partition current and matched to its source footprint area', () => {
  expect(createHash('sha256').update(JSON.stringify(footprints)).digest('hex')).toBe(roofFootprintDigest);
  for(const row of footprints){
    if(row.width>130||row.depth>130||row.label.includes('墙'))continue;
    const p=roofPartitions[row.id];expect(p,String(row.id)).toBeDefined();
    let sourceArea=0,roofArea=0;
    for(let i=0;i<row.polygon.length-1;i++){const a=row.polygon[i]!,b=row.polygon[i+1]!;sourceArea+=a[0]*b[1]-b[0]*a[1];}
    sourceArea=Math.abs(sourceArea)/2;
    for(const v of p!.vertices)if(!Number.isFinite(v))throw Error('Non-finite roof partition '+row.id);
    for(let i=0;i<p!.triangles.length;i+=3){
      const [a,b,c]=p!.triangles.slice(i,i+3).map(index=>index*3),v=p!.vertices;
      roofArea+=Math.abs((v[b!]!-v[a!]!)*(v[c!+1]!-v[a!+1]!)-(v[b!+1]!-v[a!+1]!)*(v[c!]!-v[a!]!))/2;
    }
    expect(Math.abs(roofArea-sourceArea)/sourceArea,String(row.id)).toBeLessThan(.001);
  }
});

it('treats mapped height as the whole building envelope including its roof', () => {
  for(const row of footprints){
    if(row.height===null||row.width>130||row.depth>130||row.label.includes('墙'))continue;
    const a=new Architecture();a.mappedBuilding(row);let highest=0;
    for(const {mesh} of Object.values(a.meshes()))for(let i=1;i<mesh.vertices.length;i+=12)highest=Math.max(highest,mesh.vertices[i]!);
    expect(highest,'total height of '+row.id).toBeLessThanOrEqual(Number(row.height)+.001);
    expect(highest,'nonempty roof of '+row.id).toBeGreaterThan(Number(row.height)*.9);
  }
});

it('rejects stale derived roof data from the actual palace build entry', () => {
  const row=footprints[0]!,old=row.x;
  try{row.x+=.1;expect(()=>buildPalace()).toThrow(/roof partition.*stale/i);}
  finally{row.x=old;}
});

it('gives each corner tower its official center finial and asymmetric cross-shaped wall plan', () => {
  const groups=buildPalace().meshes();
  for(const x of [-376,376])for(const z of [-565,435]){
    const name=`corner-tower-${x}-${z}`;
    const gold=groups[name+'/gold']?.mesh;
    expect(gold,'corner tower center finial').toBeDefined();
    let top=-Infinity;
    for(let i=0;i<gold!.vertices.length;i+=12)top=Math.max(top,gold!.vertices[i+1]!);
    expect(top).toBeCloseTo(27.5,3);
    const wall=groups[name+'/red']!.mesh.vertices;
    const extents=[Infinity,-Infinity,Infinity,-Infinity];
    for(let i=0;i<wall.length;i+=12){
      if(wall[i+1]!>13.5)continue;
      const X=(wall[i]!-x)*Math.sign(x),Z=(wall[i+2]!-z)*Math.sign(z);
      extents[0]=Math.min(extents[0]!,X);extents[1]=Math.max(extents[1]!,X);
      extents[2]=Math.min(extents[2]!,Z);extents[3]=Math.max(extents[3]!,Z);
      expect(Math.min(Math.abs(X),Math.abs(Z))).toBeLessThan(4.38);
    }
    expect(extents[0]).toBeCloseTo(-8.345,2);expect(extents[1]).toBeCloseTo(5.965,2);
    expect(extents[2]).toBeCloseTo(-8.345,2);expect(extents[3]).toBeCloseTo(5.965,2);
  }
});


it('gives Kunninggong three side bays from the actual column geometry', () => {
  const v=buildPalace().meshes()['kunninggong/red']!.mesh.vertices;
  const centers=new Set<number>(),radius=.47*.75;
  for(let i=0;i<v.length;i+=12){
    // Curved red vertices at the column foot exclude planar wall/panel faces.
    if(Math.abs(v[i+1]!-2)>.0001||Math.abs(v[i+3]!)<.1||Math.abs(v[i+5]!)<.1)continue;
    const x=v[i]!-radius*v[i+3]!;
    if(Math.abs(x-22.5)>.001)continue;
    centers.add(Math.round((v[i+2]!-radius*v[i+5]!+391)*1000));
  }
  expect([...centers].sort((a,b)=>a-b)).toEqual([-9500,-3167,3167,9500]);
});
