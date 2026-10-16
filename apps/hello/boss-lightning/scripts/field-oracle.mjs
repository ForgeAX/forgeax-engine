// Independent f64 diagnostic oracle. It does not import the production sampler,
// matrix math, field preparation or WGSL helper. Never used by gameplay.
export const dt = 1 / 60;
export function initialPosition(id,key) {
  if(key==='affine-spatial'&&id<5)return [[.125,-.25,0],[.125,-2.15,0],[.125,1.85,0],[1.075,-.25,0],[-.925,-.25,0]][id];
  if(['sphere','box'].includes(key)&&id<4)return [[0,0,0],[1,0,0],[1.25,0,0],[.75,.75,0]][id];
  return [(id % 16) / 20 - 0.375, (Math.floor(id / 16) % 16) / 20 - 0.375, 0.1];
}
export function acceleration(key, p) {
  if (key === 'off' || key === 'zero' || key === 'zero-vector') return [0,0,0];
  if (key === 'constant' || key === 'local' || key === 'shared') return [0.5,0.25,-0.125];
  if (key === 'affine-spatial') {
    // Independent saved radial linear generator and algebraic affine inverse.
    const q=[(p[1]+.25)/2,-(p[0]-.125),2*p[2]];
    return Math.max(...q.map(Math.abs))>1?[0,0,0]:[.125-p[0],-.25-p[1],-p[2]];
  }
  if (key === 'transformed') {
    // Invert the fixed Rz(90) * scale(2,1,.5) analytically in f64.
    const q=[(p[1]+.25)/2,-(p[0]-.125),p[2]*2];
    return Math.max(...q.map(Math.abs))>1?[0,0,0]:[-.25,1,-.0625];
  }
  const radius = key === 'sphere' ? Math.hypot(...p) : Math.max(...p.map(Math.abs));
  if (radius > 1) return [0,0,0];
  if (key === 'sphere' || key === 'box') {
    const length = Math.hypot(...p);
    return length === 0 ? [0,0,0] : p.map(n => -n/length * 0.5 * (1-radius));
  }
  const [kind, dimension, sampling] = key.split('/');
  const n = Number(dimension);
  // Linear voxel generators permit an independent closed form for trilinear.
  // Nearest evaluates the saved generator at the nearest grid node.
  const q = sampling === 'nearest' ? p.map(x => -1 + 2*Math.round((x+1)*0.5*(n-1))/(n-1)) : p;
  if (kind === 'radial') return q.map(x => -x);
  if (kind === 'vortex') return sampling==='reversed'?[q[2],0,-q[0]]:[-q[2],0,q[0]];
  throw new Error(`undeclared oracle ${key}`);
}
export function trajectory(key, id, updates) {
  const p = initialPosition(id,key), v = [0,0,0];
  for (let tick=0;tick<updates;tick++) {
    const a = acceleration(key,p);
    for(let axis=0;axis<3;axis++) { v[axis]+=a[axis]*dt; p[axis]+=v[axis]*dt; }
  }
  return {position:p,velocity:v};
}
export const percentile = (values,q) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1];
export const distribution = values => ({p50:percentile(values,0.5),p95:percentile(values,0.95)});
export function gpuIntervals(frame) {
  const spans=frame.passes.filter(p=>p.status==='measured').map(p=>({name:p.passName,begin:BigInt(p.beginningTick),end:BigInt(p.endTick)})).sort((a,b)=>a.begin<b.begin?-1:1);
  let sum=0n,union=0n,begin,end;
  for(const s of spans){sum+=s.end-s.begin;if(begin===undefined){begin=s.begin;end=s.end;}else if(s.begin<=end){if(s.end>end)end=s.end;}else{union+=end-begin;begin=s.begin;end=s.end;}}
  if(begin!==undefined)union+=end-begin;
  const ms=n=>Number(n)*frame.timestampPeriodNanoseconds/1e6;
  return {sumMs:ms(sum),unionMs:ms(union),overlapMs:ms(sum-union),envelopeMs:spans.length?ms(spans.reduce((end,s)=>s.end>end?s.end:end,spans[0].end)-spans[0].begin):0,spans:spans.map(s=>({...s,begin:s.begin.toString(),end:s.end.toString()}))};
}
