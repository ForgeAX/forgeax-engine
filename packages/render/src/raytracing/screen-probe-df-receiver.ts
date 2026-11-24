/** Rendering receiver identity, not the strict receiver-plane contact proof.
 * The same-frame canonical construction bounds the origin. Surface displacement
 * belongs to the explicitly selected Mesh DF error policy, so a tangent ray is
 * not required to manufacture a unique exact t=0 contact before marching.
 * Source, placement and selected opaque primitive admission stay unchanged. */
export const SCREEN_PROBE_DF_RECEIVER_WGSL = `
fn screenProbeDfReceiver(probe:ScreenProbe)->SdfMeshDfReceiver {
 let none=SdfMeshDfReceiver(0xffffffffu,0xffffffffu,0u);
 if(probe.receiverControl.x!=1u||probe.receiverControl.y!=probeFrame.probes.w||
  probe.receiverControl.z==0u||probe.receiverControl.w!=probeFrame.query.z||
  probe.pixel==0xffffffffu||any(probe.receiverExpected!=probeFrame.expectedSource)||
  any(grid.source!=probeFrame.expectedSource)||probeFrame.expectedSource.w==0u||
  probe.receiverRow>=probeFrame.expectedSource.z||!sdfInstanceValid(probe.receiverRow)||
  !sdfSurfaceRowAssociated(probe.receiverRow)||(sdfInstanceMask(probe.receiverRow)&1u)==0u){return none;}
 let packet=sdfSurfacePacket(probe.receiverRow);
 if(packet.valid!=1u||probe.receiverPrimitive>=packet.triangles.y||
  !sdfSurfacePrimitiveOpaque(packet,probe.receiverPrimitive)||
  sdfSurfaceExpectedDirectory(probeFrame.expectedSource.z,probeFrame.expectedSource).valid!=1u){return none;}
 return SdfMeshDfReceiver(probe.receiverRow,probe.receiverPrimitive,1u);
}
`;
