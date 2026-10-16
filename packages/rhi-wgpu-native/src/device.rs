use crate::{AdapterFacts, NativeCapabilities, NativeError};

#[cfg(target_os = "macos")]
pub(crate) const REQUIRED_BACKENDS: wgpu::Backends = wgpu::Backends::METAL;
#[cfg(target_os = "macos")]
pub(crate) const REQUIRED_BACKEND: wgpu::Backend = wgpu::Backend::Metal;
#[cfg(target_os = "macos")]
pub(crate) const REQUIRED_BACKEND_NAME: &str = "Metal";

#[cfg(target_os = "windows")]
pub(crate) const REQUIRED_BACKENDS: wgpu::Backends = wgpu::Backends::DX12;
#[cfg(target_os = "windows")]
pub(crate) const REQUIRED_BACKEND: wgpu::Backend = wgpu::Backend::Dx12;
#[cfg(target_os = "windows")]
pub(crate) const REQUIRED_BACKEND_NAME: &str = "Dx12";

#[cfg(target_os = "linux")]
pub(crate) const REQUIRED_BACKENDS: wgpu::Backends = wgpu::Backends::VULKAN;
#[cfg(target_os = "linux")]
pub(crate) const REQUIRED_BACKEND: wgpu::Backend = wgpu::Backend::Vulkan;
#[cfg(target_os = "linux")]
pub(crate) const REQUIRED_BACKEND_NAME: &str = "Vulkan";

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
compile_error!("forgeax-rhi-wgpu-native supports only macOS, Windows, and Linux");

pub(crate) struct NativeContext {
    pub surface: wgpu::Surface<'static>,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub surface_config: wgpu::SurfaceConfiguration,
    pub capabilities: NativeCapabilities,
}

pub(crate) struct NativeAdapter {
    pub adapter: wgpu::Adapter,
    pub capabilities: NativeCapabilities,
    #[cfg_attr(not(feature = "conformance"), allow(dead_code))]
    pub features: wgpu::Features,
    #[cfg_attr(not(feature = "conformance"), allow(dead_code))]
    pub limits: wgpu::Limits,
}

pub(crate) fn create_native_instance() -> Result<wgpu::Instance, NativeError> {
    if !wgpu::Instance::enabled_backend_features().contains(REQUIRED_BACKENDS) {
        return Err(NativeError::NativeBackendUnavailable {
            detail: format!("this target has no compiled {REQUIRED_BACKEND_NAME} backend"),
        });
    }
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = REQUIRED_BACKENDS;
    #[cfg(target_os = "windows")]
    {
        descriptor.flags = descriptor.flags.with_env();
        descriptor.backend_options.dx12 = descriptor.backend_options.dx12.with_env();
    }
    Ok(wgpu::Instance::new(descriptor))
}

pub(crate) async fn select_native_adapter(
    instance: &wgpu::Instance,
    compatible_surface: Option<&wgpu::Surface<'_>>,
) -> Result<NativeAdapter, NativeError> {
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface,
            apply_limit_buckets: false,
        })
        .await
        .map_err(|error| NativeError::NativeBackendUnavailable {
            detail: error.to_string(),
        })?;
    let info = adapter.get_info();
    if info.backend != REQUIRED_BACKEND {
        return Err(NativeError::NativeBackendUnavailable {
            detail: format!(
                "expected {REQUIRED_BACKEND_NAME}, selected {:?}",
                info.backend
            ),
        });
    }
    let features = adapter.features();
    let limits = adapter.limits();
    let ray_query = features.contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY);
    let capabilities = NativeCapabilities {
        backend: format!("{:?}", info.backend),
        ray_query,
        adapter: AdapterFacts {
            name: info.name,
            vendor: info.vendor,
            device: info.device,
            device_type: format!("{:?}", info.device_type),
            driver: info.driver,
            driver_info: info.driver_info,
        },
    };

    Ok(NativeAdapter {
        adapter,
        capabilities,
        features,
        limits,
    })
}

pub(crate) async fn request_native_device(
    adapter: &wgpu::Adapter,
    required_features: wgpu::Features,
    required_limits: wgpu::Limits,
) -> Result<(wgpu::Device, wgpu::Queue), NativeError> {
    adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("forgeax native Ray Query device"),
            required_features,
            required_limits,
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
            // Safety: this opt-in native route accepts wgpu's documented experimental-API risk
            // while retaining validation, process isolation, and reproducible evidence.
            experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        })
        .await
        .map_err(|error| NativeError::GpuInitialization {
            detail: format!("failed to request Ray Query device: {error}"),
        })
}

impl NativeContext {
    pub async fn create<W>(window: W, width: u32, height: u32) -> Result<Self, NativeError>
    where
        W: wgpu::DisplayAndWindowHandle + 'static,
    {
        let instance = create_native_instance()?;
        let surface =
            instance
                .create_surface(window)
                .map_err(|error| NativeError::GpuInitialization {
                    detail: format!("failed to create native surface: {error}"),
                })?;
        let selected = select_native_adapter(&instance, Some(&surface)).await?;
        if !selected.capabilities.ray_query {
            return Err(NativeError::RayQueryUnsupported {
                detail: format!(
                    "adapter '{}' does not expose EXPERIMENTAL_RAY_QUERY",
                    selected.capabilities.adapter.name
                ),
                capabilities: Box::new(selected.capabilities),
            });
        }

        let required_limits =
            wgpu::Limits::default().using_minimum_supported_acceleration_structure_values();
        let (device, queue) = request_native_device(
            &selected.adapter,
            wgpu::Features::EXPERIMENTAL_RAY_QUERY,
            required_limits,
        )
        .await?;
        let surface_config = surface
            .get_default_config(&selected.adapter, width.max(1), height.max(1))
            .ok_or_else(|| NativeError::GpuInitialization {
                detail: format!(
                    "{REQUIRED_BACKEND_NAME} adapter does not support the native surface"
                ),
            })?;
        surface.configure(&device, &surface_config);

        Ok(Self {
            surface,
            device,
            queue,
            surface_config,
            capabilities: selected.capabilities,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.surface_config.width = width.max(1);
        self.surface_config.height = height.max(1);
        self.surface.configure(&self.device, &self.surface_config);
    }
}
