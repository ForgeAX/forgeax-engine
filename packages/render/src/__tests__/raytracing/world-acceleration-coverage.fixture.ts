import { worldTraversalWgsl } from '../../raytracing/world-traversal';

/** Same production World query, without Card shading, draws or an alternate intersection model. */
export function worldAccelerationCoverageWgsl(): string {
  const production = worldTraversalWgsl('ray-query');
  const tail = 'result.state=vec4u(1u,0u,steps,row.x);';
  if (production.split(tail).length !== 2) throw new Error('missing or ambiguous actual hit tail');
  // Observe the hardware original primitive only in the existing reserved output
  // word. The actual query prefix, layout and closest-hit algorithm are unchanged.
  const observed = production.replace(
    tail,
    'result.state=vec4u(1u,c.primitive_index,steps,row.x);',
  );
  return `${observed}
@group(0) @binding(7) var<storage,read> rays:array<Ray>;
@group(0) @binding(8) var<storage,read_write> hits:array<Hit>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u){
 if(gid.x>=arrayLength(&rays)){return;}
 hits[gid.x]=traceWorld(rays[gid.x],rays[gid.x].mask.y,1.0);
}
`;
}
