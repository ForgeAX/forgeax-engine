//! A native window and its swapchain stay in the Node runtime's calling thread.
//! The ordinary WebGPU device owns every imported texture; no rendering policy lives here.

use crate::{instance, NativeAdapter, NativeDevice};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;

#[path = "window_winit.rs"]
mod winit_host;

#[cfg(target_os = "windows")]
#[path = "window_gamepad.rs"]
mod gamepad;

#[cfg(target_os = "macos")]
#[path = "window_gamepad_macos.rs"]
mod gamepad_macos;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowFacts {
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub visible: bool,
}

#[derive(Serialize)]
pub struct NativeGamepad {
    index: u32,
    buttons: [f64; 17],
    axes: [f64; 4],
}

/// Calling-thread native drawable owner. It contains no GPU or UI policy.
/// Drop releases its native window, after NativeWindow has retired the Surface.
pub trait NativeWindowHost: HasWindowHandle + HasDisplayHandle {
    fn facts(&self) -> Result<NativeWindowFacts>;
    fn resize(&self, width: u32, height: u32) -> Result<()>;
    fn request_redraw(&self) -> Result<()>;
    fn set_pointer_lock(&self, _locked: bool) -> Result<bool> {
        Ok(false)
    }
    fn gamepads(&self) -> Option<Vec<NativeGamepad>> {
        None
    }
    fn set_ime_area(&self, _area: Option<[f64; 4]>) -> u32 {
        0
    }
    fn poll_events(&self) -> Result<Vec<Value>>;
    fn pre_present_notify(&self) {}
}

struct ConfiguredSurface {
    descriptor: wgpu::SurfaceConfiguration,
    device: wgpu::Device,
    queue: wgpu::Queue,
}

/// Opaque native owner. Its window is never represented by a pointer or JSON handle in JS.
#[napi]
pub struct NativeWindow {
    // Drop the surface and acquired frame before releasing the native window.
    frame: RefCell<Option<wgpu::SurfaceTexture>>,
    configured: RefCell<Option<ConfiguredSurface>>,
    surface: RefCell<Option<wgpu::Surface<'static>>>,
    adapter: RefCell<Option<wgpu::Adapter>>,
    host: RefCell<Option<Box<dyn NativeWindowHost>>>,
}

fn failure(cause: impl std::fmt::Display) -> Error {
    Error::from_reason(cause.to_string())
}

#[napi]
impl NativeWindow {
    #[napi(constructor, catch_unwind)]
    pub fn new(options: String) -> Result<Self> {
        let options: winit_host::WindowOptions = serde_json::from_str(&options).map_err(failure)?;
        if options.width == 0 || options.height == 0 {
            return Err(failure("native window dimensions must be nonzero"));
        }
        let host = Box::new(winit_host::WinitWindow::new(options)?);
        // SAFETY: WinitWindow retains the Arc<Window> until this Surface is retired.
        unsafe { Self::from_host(host) }
    }

    #[napi(catch_unwind)]
    pub fn request_adapter(
        &self,
        power_preference: Option<String>,
        force_fallback_adapter: Option<bool>,
    ) -> Result<Option<NativeAdapter>> {
        self.ensure_surface()?;
        let surface = self.surface.borrow();
        let surface = surface
            .as_ref()
            .ok_or_else(|| failure("native window is closed"))?;
        let adapter =
            pollster::block_on(instance().request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: match power_preference.as_deref() {
                    Some("low-power") => wgpu::PowerPreference::LowPower,
                    _ => wgpu::PowerPreference::HighPerformance,
                },
                force_fallback_adapter: force_fallback_adapter.unwrap_or(false),
                compatible_surface: Some(surface),
                apply_limit_buckets: false,
            }))
            .ok();
        *self.adapter.borrow_mut() = adapter.clone();
        Ok(adapter.map(|adapter| NativeAdapter { adapter }))
    }

    #[napi(catch_unwind)]
    pub fn preferred_format(&self) -> Result<String> {
        self.ensure_surface()?;
        let surface = self.surface.borrow();
        let surface = surface
            .as_ref()
            .ok_or_else(|| failure("native window is closed"))?;
        let adapter = self.adapter.borrow();
        let adapter = adapter
            .as_ref()
            .ok_or_else(|| failure("request a compatible adapter first"))?;
        let caps = surface.get_capabilities(adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|format| !format.is_srgb())
            .ok_or_else(|| failure("native surface has no linear presentation format"))?;
        serde_json::to_value(format)
            .map_err(failure)?
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| failure("invalid surface format"))
    }

    #[napi(catch_unwind)]
    pub fn supported_alpha_modes(&self) -> Result<Vec<String>> {
        self.ensure_surface()?;
        let surface = self.surface.borrow();
        let surface = surface
            .as_ref()
            .ok_or_else(|| failure("native window is closed"))?;
        let adapter = self.adapter.borrow();
        let adapter = adapter
            .as_ref()
            .ok_or_else(|| failure("request a compatible adapter first"))?;
        let caps = surface.get_capabilities(adapter);
        Ok(caps
            .alpha_modes
            .iter()
            .filter_map(|mode| match mode {
                wgpu::CompositeAlphaMode::Opaque => Some("opaque".to_owned()),
                wgpu::CompositeAlphaMode::PreMultiplied => Some("premultiplied".to_owned()),
                _ => None,
            })
            .collect())
    }

    #[napi(catch_unwind)]
    pub fn supported_texture_usages(&self) -> Result<u32> {
        self.ensure_surface()?;
        let surface = self.surface.borrow();
        let surface = surface
            .as_ref()
            .ok_or_else(|| failure("native window is closed"))?;
        let adapter = self.adapter.borrow();
        let adapter = adapter
            .as_ref()
            .ok_or_else(|| failure("request a compatible adapter first"))?;
        Ok(surface.get_capabilities(adapter).usages.bits())
    }

    #[napi(catch_unwind)]
    pub fn configure(&self, device: &NativeDevice, descriptor: String) -> Result<()> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Descriptor {
            format: wgpu::TextureFormat,
            alpha_mode: String,
            usage: u32,
            view_formats: Vec<wgpu::TextureFormat>,
        }
        let different_device = self
            .configured
            .borrow()
            .as_ref()
            .is_some_and(|current| &current.device != device.surface_device());
        if different_device {
            self.unconfigure();
        }
        self.ensure_surface()?;
        let result = (|| {
            let descriptor: Descriptor = serde_json::from_str(&descriptor).map_err(failure)?;
            let surface = self.surface.borrow();
            let surface = surface
                .as_ref()
                .ok_or_else(|| failure("native window is closed"))?;
            let adapter = self.adapter.borrow();
            let adapter = adapter
                .as_ref()
                .ok_or_else(|| failure("request a compatible adapter first"))?;
            let size = self.with_host(|host| host.facts())?;
            let caps = surface.get_capabilities(adapter);
            let usage = wgpu::TextureUsages::from_bits(descriptor.usage).ok_or_else(|| {
            failure(format!(
                "invalid native surface texture usage: requested=0x{:08x}, format={:?}, extent={}x{}, supportedUsages={:?} (0x{:08x})",
                descriptor.usage,
                descriptor.format,
                size.width,
                size.height,
                caps.usages,
                caps.usages.bits(),
            ))
        })?;
            if size.width == 0 || size.height == 0 {
                return Err(failure(format!(
                "native surface has zero drawable extent: requested={}x{}, format={:?}, usage={:?} (0x{:08x}), supportedFormats={:?}, supportedUsages={:?} (0x{:08x})",
                size.width,
                size.height,
                descriptor.format,
                usage,
                descriptor.usage,
                caps.formats,
                caps.usages,
                caps.usages.bits(),
            )));
            }
            if !caps.formats.contains(&descriptor.format) {
                return Err(failure(format!(
                "native surface format is unsupported: requested={:?}, usage={:?} (0x{:08x}), extent={}x{}, supportedFormats={:?}, supportedUsages={:?} (0x{:08x})",
                descriptor.format,
                usage,
                descriptor.usage,
                size.width,
                size.height,
                caps.formats,
                caps.usages,
                caps.usages.bits(),
            )));
            }
            if !caps.usages.contains(usage) {
                return Err(failure(format!(
                "native surface texture usage is unsupported: requested={:?} (0x{:08x}), format={:?}, extent={}x{}, supportedUsages={:?} (0x{:08x}), supportedFormats={:?}",
                usage,
                descriptor.usage,
                descriptor.format,
                size.width,
                size.height,
                caps.usages,
                caps.usages.bits(),
                caps.formats,
            )));
            }
            let mut config = surface
            .get_default_config(adapter, size.width, size.height)
            .ok_or_else(|| {
                failure(format!(
                    "adapter cannot present to the native surface: requestedFormat={:?}, requestedUsage={:?} (0x{:08x}), extent={}x{}, supportedFormats={:?}, supportedUsages={:?} (0x{:08x}), supportedAlphaModes={:?}",
                    descriptor.format,
                    usage,
                    descriptor.usage,
                    size.width,
                    size.height,
                    caps.formats,
                    caps.usages,
                    caps.usages.bits(),
                    caps.alpha_modes,
                ))
            })?;
            config.alpha_mode = match descriptor.alpha_mode.as_str() {
                "opaque" => wgpu::CompositeAlphaMode::Opaque,
                "premultiplied" => wgpu::CompositeAlphaMode::PreMultiplied,
                _ => return Err(failure("invalid native surface alpha mode")),
            };
            if !caps.alpha_modes.contains(&config.alpha_mode) {
                return Err(failure(format!(
                    "native surface alpha mode {} is unsupported; available: {:?}",
                    descriptor.alpha_mode, caps.alpha_modes
                )));
            }
            config.format = descriptor.format;
            config.usage = usage;
            config.view_formats = descriptor.view_formats;
            self.frame.borrow_mut().take();
            device
            .configure_surface(surface, &config)
            .map_err(|cause| {
                let requested_format = config.format;
                let requested_alpha_mode = config.alpha_mode;
                let requested_usage = config.usage;
                let requested_usage_bits = requested_usage.bits();
                let extent_width = config.width;
                let extent_height = config.height;
                let requested_view_formats = &config.view_formats;
                let supported_formats = &caps.formats;
                let supported_usages = caps.usages;
                let supported_usage_bits = caps.usages.bits();
                let supported_alpha_modes = &caps.alpha_modes;
                failure(format!(
                    "native surface configure failed: format={requested_format:?}, alphaMode={requested_alpha_mode:?}, usage={requested_usage:?} (0x{requested_usage_bits:08x}), extent={extent_width}x{extent_height}, viewFormats={requested_view_formats:?}, supportedFormats={supported_formats:?}, supportedUsages={supported_usages:?} (0x{supported_usage_bits:08x}), supportedAlphaModes={supported_alpha_modes:?}: {cause}"
                ))
            })?;
            *self.configured.borrow_mut() = Some(ConfiguredSurface {
                descriptor: config,
                device: device.surface_device().clone(),
                queue: device.surface_queue().clone(),
            });
            Ok(())
        })();
        if result.is_err() {
            self.unconfigure();
        }
        result
    }

    #[napi(catch_unwind)]
    pub fn acquire_texture(&self, device: &NativeDevice) -> Result<u32> {
        let configured = self.configured.borrow();
        let configured = configured
            .as_ref()
            .ok_or_else(|| failure("native surface is unconfigured"))?;
        if device.surface_device() != &configured.device {
            return Err(failure("native surface belongs to another device"));
        }
        if self.frame.borrow().is_some() {
            return Err(failure("native surface already has an acquired frame"));
        }
        let mut acquired = self.acquire_surface_texture()?;
        if matches!(acquired, wgpu::CurrentSurfaceTexture::Lost) {
            self.surface.borrow_mut().take();
            self.ensure_surface()?;
        }
        if matches!(
            acquired,
            wgpu::CurrentSurfaceTexture::Lost | wgpu::CurrentSurfaceTexture::Outdated
        ) {
            self.with_surface(|surface| device.configure_surface(surface, &configured.descriptor))?;
            acquired = self.acquire_surface_texture()?;
        }
        let frame = match acquired {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            status => {
                return Err(failure(format!(
                    "native surface acquisition failed: {status:?}"
                )));
            }
        };
        let id = device.import_surface_texture(frame.texture.clone());
        *self.frame.borrow_mut() = Some(frame);
        Ok(id)
    }

    #[napi(catch_unwind)]
    pub fn present(&self) -> Result<()> {
        if self.host.borrow().is_none() {
            return Err(failure("native window is closed"));
        }
        if let Some(frame) = self.frame.borrow_mut().take() {
            self.with_host(|host| {
                host.pre_present_notify();
                Ok(())
            })?;
            let configured = self.configured.borrow();
            let configured = configured
                .as_ref()
                .ok_or_else(|| failure("native surface is unconfigured"))?;
            configured.queue.present(frame);
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn unconfigure(&self) {
        self.frame.borrow_mut().take();
        // Dropping only ConfiguredSurface leaves the DX12 swapchain bound to
        // its original device/present queue. Retire that backing generation.
        self.surface.borrow_mut().take();
        self.configured.borrow_mut().take();
    }

    #[napi(catch_unwind)]
    pub fn facts(&self) -> Result<String> {
        serde_json::to_string(&self.with_host(|host| host.facts())?).map_err(failure)
    }

    #[napi(catch_unwind)]
    pub fn resize(&self, width: u32, height: u32) -> Result<()> {
        if width == 0 || height == 0 {
            return Err(failure("native window dimensions must be nonzero"));
        }
        self.with_host(|host| host.resize(width, height))
    }

    #[napi(catch_unwind)]
    pub fn request_redraw(&self) -> Result<()> {
        self.with_host(|host| host.request_redraw())
    }

    #[napi(catch_unwind)]
    pub fn set_pointer_lock(&self, locked: bool) -> Result<bool> {
        self.with_host(|host| host.set_pointer_lock(locked))
    }

    #[napi(catch_unwind)]
    pub fn gamepads(&self) -> Result<String> {
        serde_json::to_string(&self.with_host(|host| Ok(host.gamepads()))?).map_err(failure)
    }

    #[napi(catch_unwind)]
    pub fn set_ime_area(&self, area: Option<String>) -> Result<u32> {
        let area: Option<[f64; 4]> = area
            .map(|area| serde_json::from_str(&area))
            .transpose()
            .map_err(failure)?;
        if area.is_some_and(|[x, y, width, height]| {
            ![x, y, width, height].iter().all(|value| value.is_finite())
                || width < 0.0
                || height < 0.0
        }) {
            return Err(failure("invalid logical IME area"));
        }
        self.with_host(|host| Ok(host.set_ime_area(area)))
    }

    #[napi(catch_unwind)]
    pub fn poll_events(&self) -> Result<String> {
        serde_json::to_string(&self.with_host(|host| host.poll_events())?).map_err(failure)
    }

    #[napi(catch_unwind)]
    pub fn close(&self) {
        self.unconfigure();
        self.adapter.borrow_mut().take();
        self.host.borrow_mut().take();
    }
}

impl NativeWindow {
    /// Borrow a drawable owned by another same-process native GUI host.
    ///
    /// # Safety
    /// The host must keep both handles valid, on their required thread, until it is
    /// dropped. NativeWindow drops every acquired image and Surface before the host.
    /// No JS number, IPC message or cross-process address may supply these handles.
    pub unsafe fn from_host(host: Box<dyn NativeWindowHost>) -> Result<Self> {
        let window = Self {
            frame: RefCell::new(None),
            configured: RefCell::new(None),
            surface: RefCell::new(None),
            adapter: RefCell::new(None),
            host: RefCell::new(Some(host)),
        };
        window.ensure_surface()?;
        Ok(window)
    }

    fn ensure_surface(&self) -> Result<()> {
        // Host liveness, not the presence of a current Surface, owns close.
        self.with_host(|_| Ok(()))?;
        if self.surface.borrow().is_some() {
            return Ok(());
        }
        let surface = self.with_host(create_surface_for_host)?;
        *self.surface.borrow_mut() = Some(surface);
        Ok(())
    }

    fn with_surface<T>(&self, run: impl FnOnce(&wgpu::Surface<'static>) -> Result<T>) -> Result<T> {
        let surface = self.surface.borrow();
        run(surface
            .as_ref()
            .ok_or_else(|| failure("native window is closed"))?)
    }

    fn acquire_surface_texture(&self) -> Result<wgpu::CurrentSurfaceTexture> {
        self.with_surface(|surface| Ok(surface.get_current_texture()))
    }

    fn with_host<T>(&self, run: impl FnOnce(&dyn NativeWindowHost) -> Result<T>) -> Result<T> {
        let host = self.host.borrow();
        run(host
            .as_deref()
            .ok_or_else(|| failure("native window is closed"))?)
    }
}

// Raw handles remain valid while the borrowed host is owned by NativeWindow.
fn create_surface_for_host(host: &dyn NativeWindowHost) -> Result<wgpu::Surface<'static>> {
    let raw_display_handle = Some(host.display_handle().map_err(failure)?.as_raw());
    let raw_window_handle = host.window_handle().map_err(failure)?.as_raw();
    unsafe {
        instance().create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle,
            raw_window_handle,
        })
    }
    .map_err(failure)
}
