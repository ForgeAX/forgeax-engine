import { type MeshDistanceField, validateMeshDistanceField } from '@forgeax/engine-geometry';
import { CANONICAL_RECEIVER_RECONSTRUCTION_BODY_WGSL } from '@forgeax/engine-shader';

/** Private per-tile snapshot: source tuple, row/geometry facts, actual VP and forward. */
export const CARD_RECEIVER_FACT_BYTES = 160;
export const CARD_RECEIVER_FACT_TAG = 0x43524601;

/** Derived once in the existing accepted Mesh geometry cache, never a row registry.
 * It binds the actual captured local arrays to the validated canonical packet's
 * original primitive namespace. Pose, pixels and opaque coverage are later gates. */
export class CardReceiverGeometry {
  readonly #accepted = true;
  private constructor(
    readonly positions: ArrayLike<number>,
    readonly indices: ArrayLike<number>,
    readonly primitiveCount: number,
    readonly meshDigest: string,
    private readonly canonicalPositions: ArrayLike<number>,
    private readonly canonicalIndices: ArrayLike<number>,
  ) {}

  static from(
    field: MeshDistanceField,
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
  ): CardReceiverGeometry | undefined {
    if (field.policy.kind !== 'sampled-visibility' || !validateMeshDistanceField(field).ok)
      return undefined;
    const surface = field.surface;
    if (
      surface === undefined ||
      surface.positions.length !== positions.length ||
      surface.indices.length !== indices.length
    )
      return undefined;
    for (let i = 0; i < positions.length; i++)
      if (!Object.is(positions[i], surface.positions[i])) return undefined;
    for (let i = 0; i < indices.length; i++)
      if (indices[i] !== surface.indices[i]) return undefined;
    return new CardReceiverGeometry(
      positions,
      indices,
      indices.length / 3,
      field.meshDigest,
      surface.positions,
      surface.indices,
    );
  }

  matches(positions: ArrayLike<number>, indices: ArrayLike<number>): boolean {
    if (
      !(#accepted in this) ||
      !this.#accepted ||
      this.positions !== positions ||
      this.indices !== indices ||
      positions.length !== this.canonicalPositions.length ||
      indices.length !== this.canonicalIndices.length
    )
      return false;
    for (let i = 0; i < positions.length; i++)
      if (!Object.is(positions[i], this.canonicalPositions[i])) return false;
    for (let i = 0; i < indices.length; i++)
      if (indices[i] !== this.canonicalIndices[i]) return false;
    return true;
  }
}

/** Copies the already-uploaded 144-byte raster context's VP; never rebuilds it
 * from Card axes or a sampled depth. The result is still unavailable until the
 * same-encoder publisher supplies an independently accepted source tuple. */
export function packCardReceiverFacts(
  row: number,
  context: Uint8Array,
  forward: ArrayLike<number>,
  geometry: CardReceiverGeometry | undefined,
): Uint8Array {
  const bytes = new Uint8Array(CARD_RECEIVER_FACT_BYTES);
  if (
    !geometry ||
    context.byteLength !== 144 ||
    forward.length !== 16 ||
    !Number.isSafeInteger(row) ||
    row < 0 ||
    row >= 0xffffffff
  )
    return bytes;
  const matrix = Float32Array.from(forward),
    bits = new Uint32Array(matrix.buffer);
  for (let i = 0; i < 16; i++) {
    const word = bits[i] ?? 0;
    // Actual Renderer poses are f32. External non-f32/FTZ poses do not acquire a
    // contact certificate merely because an upload would round them.
    if (
      !Object.is(matrix[i], forward[i]) ||
      (word & 0x7f800000) === 0x7f800000 ||
      ((word & 0x7f800000) === 0 && (word & 0x7fffffff) !== 0)
    )
      return bytes;
  }
  const words = new Uint32Array(bytes.buffer);
  words.set([row, geometry.primitiveCount, 1, CARD_RECEIVER_FACT_TAG], 4);
  bytes.set(context.subarray(0, 64), 32);
  bytes.set(new Uint8Array(matrix.buffer), 96);
  return bytes;
}

/** Appended only to the software Card entry's existing pool/interval authority.
 * Actual integer raster identity and the producer snapshot qualify the caller;
 * reconstruction's rasterQualified=0 is deliberately never promoted on its own. */
export const CARD_RECEIVER_WGSL = `${CANONICAL_RECEIVER_RECONSTRUCTION_BODY_WGSL}
struct CardCanonicalReceiver { point:SdfIntervalVector, row:u32, primitive:u32, valid:u32 }
struct CardLightSegment { world:SdfSurfaceRay, state:u32 }
fn cardReceiver(tile:u32,pixel:vec2u,localPixel:vec2u,resolution:u32)->CardCanonicalReceiver {
 var none:CardCanonicalReceiver;
 if(frame.expectedSource.w==0u||any(grid.source!=frame.expectedSource)||resolution==0u){return none;}
 let length=arrayLength(&cardReceivers);
 if(length<10u||tile>(length-10u)/10u||any(textureDimensions(cardPrimitiveIndex)!=vec2u(frame.atlas.x,textureDimensions(cardDepth).y))){return none;}
 let at=tile*10u;let source=cardReceivers[at];let control=cardReceivers[at+1u];
 if(any(source!=frame.expectedSource)||control.z!=1u||control.w!=${CARD_RECEIVER_FACT_TAG}u||control.x!=cards[tile].ids.x||control.x>=source.z){return none;}
 let primitive=textureLoad(cardPrimitiveIndex,vec2i(pixel),0).x;
 if(primitive==0xffffffffu||primitive>=control.y||!sdfInstanceValid(control.x)||!sdfSurfaceRowAssociated(control.x)||(sdfInstanceMask(control.x)&1u)==0u){return none;}
 if(sdfSurfaceExpectedDirectory(source.z,source).valid!=1u){return none;}
 let packet=sdfSurfacePacket(control.x);
 if(packet.valid!=1u||packet.triangles.y!=control.y||!sdfSurfacePrimitiveOpaque(packet,primitive)){return none;}
 var input:CanonicalReceiverInput;let tri=packet.triangles.x+primitive*3u;
 for(var v=0u;v<3u;v++){
  let index=sdfFieldWord(tri+v);if(index>=packet.positions.y){return none;}
  input.vertices[v]=sdfSurfaceVertex(packet,index);
 }
 for(var column=0u;column<4u;column++){
  input.viewProjection[column]=cardReceivers[at+2u+column];
  input.forward[column]=cardReceivers[at+6u+column];
 }
 input.pixel=localPixel;input.extent=vec2u(resolution);input.sampleOffset=vec2u(0x3f000000u);
 let point=canonicalReceiverReconstruct(input);
 if(point.state!=1u||point.rasterQualified!=0u){return none;}
 return CardCanonicalReceiver(point.point,control.x,primitive,1u);
}
fn cardLightSegment(receiver:CardCanonicalReceiver,light:Light,incoming:vec3f,limit:f32)->CardLightSegment {
 var none:CardLightSegment;
 if(receiver.valid!=1u||!sdfIntervalVectorValid(receiver.point)){return none;}
 var direction:SdfIntervalVector;var last=1.0;
 if(u32(light.positionKind.w)<2u){
  direction=sdfIntervalVector(bitcast<vec3u>(incoming),bitcast<vec3u>(incoming));last=limit;
 }else{
  let endpoint=sdfIntervalVector(bitcast<vec3u>(light.positionKind.xyz),bitcast<vec3u>(light.positionKind.xyz));
  if(!sdfIntervalVectorValid(endpoint)){return none;}
  var empty=true;
  for(var axis=0u;axis<3u;axis++){
   if(receiver.point.axis[axis].lo!=endpoint.axis[axis].lo||receiver.point.axis[axis].hi!=endpoint.axis[axis].hi){empty=false;}
  }
  if(empty){none.state=1u;return none;}
  direction=sdfIntervalVectorSubtract(endpoint,receiver.point);
 }
 if(!sdfIntervalVectorValid(direction)||!sdfSurfaceBitsUsable(bitcast<u32>(last))||last<=0.0){return none;}
 var world:SdfSurfaceRay;world.tRange=bitcast<vec2u>(vec2f(0,last));world.valid=1u;
 for(var axis=0u;axis<3u;axis++){
  world.originLo[axis]=bitcast<u32>(receiver.point.axis[axis].lo);world.originHi[axis]=bitcast<u32>(receiver.point.axis[axis].hi);
  world.directionLo[axis]=bitcast<u32>(direction.axis[axis].lo);world.directionHi[axis]=bitcast<u32>(direction.axis[axis].hi);
 }
 if(!sdfSurfaceRayUsable(world)){return none;}
 return CardLightSegment(world,2u);
}
fn cardReceiverContact(receiver:CardCanonicalReceiver,world:SdfSurfaceRay)->SdfSurfaceContact {
 let none=SdfSurfaceContact(0xffffffffu,0xffffffffu,0u);
 if(receiver.valid!=1u||!sdfSurfaceRayUsable(world)){return none;}
 let packet=sdfSurfacePacket(receiver.row);
 if(!sdfSurfacePrimitiveOpaque(packet,receiver.primitive)){return none;}
 let local=sdfSurfaceLocalRay(world,sdfSurfaceInverse(receiver.row),packet.coefficients.yz);
 if(local.valid!=1u){return none;}
 let tri=packet.triangles.x+receiver.primitive*3u;
 let indices=vec3u(sdfFieldWord(tri),sdfFieldWord(tri+1u),sdfFieldWord(tri+2u));
 if(any(indices>=vec3u(packet.positions.y))){return none;}
 let aBits=sdfSurfaceVertex(packet,indices.x);let bBits=sdfSurfaceVertex(packet,indices.y);let cBits=sdfSurfaceVertex(packet,indices.z);
 let a=sdfIntervalVector(aBits,aBits);
 let e1=sdfIntervalVectorSubtract(sdfIntervalVector(bBits,bBits),a);let e2=sdfIntervalVectorSubtract(sdfIntervalVector(cBits,cBits),a);
 let direction=sdfIntervalVector(local.directionLo,local.directionHi);let det=sdfIntervalDot(e1,sdfIntervalCross(direction,e2));
 if(det.valid!=1u||(det.lo<=0.0&&det.hi>=0.0)){return none;}
 return SdfSurfaceContact(receiver.row,receiver.primitive,1u);
}
`;
