//! Node-API binding for `@forgeax/engine-rhi-wgpu-native`.
//!
//! The addon is a WebGPU-shaped device over native wgpu plus the wgpu Ray Query extension.
//! The TypeScript GPU (`src/gpu.ts`) owns the W3C object model; this crate owns a per-device
//! id-to-resource table, lowers JSON descriptors, and replays recorded command lists at
//! `GPUCommandEncoder.finish()`. Errors never panic across the boundary: wgpu validation errors
//! route through device-owned error scopes or the uncaptured-error queue, malformed input
//! returns a JS exception the TypeScript side converts into a validation error, and every
//! export catches unwinds.

mod desc;
mod device;
mod errors;
mod limits;
mod window;

use napi::bindgen_prelude::*;
use napi_derive::napi;

pub use device::NativeDevice;
pub use window::{NativeWindow, NativeWindowFacts, NativeWindowHost};

#[cfg(target_os = "macos")]
const BACKENDS: wgpu::Backends = wgpu::Backends::METAL;
#[cfg(target_os = "windows")]
const BACKENDS: wgpu::Backends = wgpu::Backends::DX12;
#[cfg(target_os = "linux")]
const BACKENDS: wgpu::Backends = wgpu::Backends::VULKAN;

/// The pinned wgpu release this addon was built from.
#[napi]
pub fn wgpu_version() -> String {
    "30.0.1".to_owned()
}

pub(crate) fn instance() -> &'static wgpu::Instance {
    static INSTANCE: std::sync::OnceLock<wgpu::Instance> = std::sync::OnceLock::new();
    INSTANCE.get_or_init(|| {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = BACKENDS;
        #[cfg(target_os = "windows")]
        {
            descriptor.flags = descriptor.flags.with_env();
            descriptor.backend_options.dx12 = descriptor.backend_options.dx12.with_env();
        }
        wgpu::Instance::new(descriptor)
    })
}

/// `GPU.requestAdapter`. `None` is the WebGPU adapter-absence channel.
#[napi(catch_unwind)]
pub fn request_adapter(
    power_preference: Option<String>,
    force_fallback_adapter: Option<bool>,
) -> Option<NativeAdapter> {
    let power_preference = match power_preference.as_deref() {
        Some("low-power") => wgpu::PowerPreference::LowPower,
        _ => wgpu::PowerPreference::HighPerformance,
    };
    let adapter = pollster::block_on(instance().request_adapter(&wgpu::RequestAdapterOptions {
        power_preference,
        force_fallback_adapter: force_fallback_adapter.unwrap_or(false),
        compatible_surface: None,
        apply_limit_buckets: false,
    }))
    .ok()?;
    Some(NativeAdapter { adapter })
}

#[napi]
pub struct NativeAdapter {
    pub(crate) adapter: wgpu::Adapter,
}

#[napi]
impl NativeAdapter {
    #[napi(catch_unwind)]
    pub fn features(&self) -> Vec<String> {
        limits::feature_names(self.adapter.features())
    }

    #[napi(catch_unwind)]
    pub fn limits(&self) -> String {
        limits::limits_to_json(&self.adapter.limits())
    }

    /// `GPUAdapterInfo` fields as JSON.
    #[napi(catch_unwind)]
    pub fn info(&self) -> String {
        let info = self.adapter.get_info();
        serde_json::json!({
            "vendor": format!("{:#x}", info.vendor),
            "architecture": "",
            "device": info.name,
            "description": format!("{} ({})", info.driver, info.driver_info),
            "backend": format!("{:?}", info.backend),
            "isFallbackAdapter": info.device_type == wgpu::DeviceType::Cpu,
        })
        .to_string()
    }

    /// `GPUAdapter.requestDevice`. Rejects (JS exception) when a required feature or limit is
    /// not supported, like the W3C `OperationError`.
    #[napi(catch_unwind)]
    pub fn request_device(&self, descriptor: String) -> Result<NativeDevice> {
        let desc: desc::DeviceDesc = serde_json::from_str(&descriptor)
            .map_err(|e| Error::from_reason(format!("invalid GPUDeviceDescriptor: {e}")))?;
        let adapter_features = self.adapter.features();
        let adapter_limits = self.adapter.limits();
        let mut features = wgpu::Features::empty();
        for name in &desc.required_features {
            let feature = limits::parse_feature(name).map_err(Error::from_reason)?;
            if !adapter_features.contains(feature) {
                return Err(Error::from_reason(format!(
                    "requiredFeatures '{name}' is not supported by the adapter"
                )));
            }
            features |= feature;
        }
        let mut required = wgpu::Limits::default();
        if features.contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) {
            required.max_blas_geometry_count = adapter_limits.max_blas_geometry_count;
            required.max_blas_primitive_count = adapter_limits.max_blas_primitive_count;
            required.max_tlas_instance_count = adapter_limits.max_tlas_instance_count;
            required.max_acceleration_structures_per_shader_stage =
                adapter_limits.max_acceleration_structures_per_shader_stage;
        }
        limits::apply_required_limits(&mut required, &adapter_limits, &desc.required_limits)
            .map_err(Error::from_reason)?;
        let (device, queue) =
            pollster::block_on(self.adapter.request_device(&wgpu::DeviceDescriptor {
                label: desc.label.as_deref(),
                required_features: features,
                required_limits: required,
                // SAFETY: Ray Query is the only experimental feature this addon admits, and it
                // is requested only when the adapter reports it.
                experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            }))
            .map_err(|e| Error::from_reason(format!("requestDevice failed: {e}")))?;
        Ok(NativeDevice::new(device, queue))
    }
}
