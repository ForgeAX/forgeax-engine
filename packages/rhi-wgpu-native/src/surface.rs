use crate::NativeError;

pub(crate) fn acquire(
    surface: &wgpu::Surface<'static>,
    device: &wgpu::Device,
    config: &wgpu::SurfaceConfiguration,
) -> Result<wgpu::SurfaceTexture, NativeError> {
    match surface.get_current_texture() {
        wgpu::CurrentSurfaceTexture::Success(frame)
        | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => Ok(frame),
        wgpu::CurrentSurfaceTexture::Outdated => {
            surface.configure(device, config);
            match surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(frame)
                | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => Ok(frame),
                status => Err(NativeError::Render {
                    detail: format!("surface acquisition failed after reconfigure: {status:?}"),
                }),
            }
        }
        status => Err(NativeError::Render {
            detail: format!("surface acquisition failed: {status:?}"),
        }),
    }
}
