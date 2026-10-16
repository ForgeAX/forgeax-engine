#[cfg(any(test, feature = "reference"))]
mod acceleration;
#[cfg(feature = "conformance")]
pub mod conformance;
pub mod conformance_registry;
mod device;
mod ray_query;
#[cfg(feature = "reference")]
pub mod reference;
mod surface;
#[cfg(test)]
mod world_traversal_parity;

use serde::Serialize;
use std::path::Path;
use thiserror::Error;

pub use ray_query::{RayQueryRenderer, RendererConfig};

pub const WGPU_VERSION: &str = "30.0.1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCapabilities {
    pub backend: String,
    pub ray_query: bool,
    pub adapter: AdapterFacts,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterFacts {
    pub name: String,
    pub vendor: u32,
    pub device: u32,
    pub device_type: String,
    pub driver: String,
    pub driver_info: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameEvidence {
    pub width: u32,
    pub height: u32,
    pub non_black_pixel_count: u32,
    pub triangle_visible: bool,
    pub barycentric_variation: bool,
    pub center_pixel: [u8; 4],
    pub corner_pixel: [u8; 4],
}

pub struct FrameCapture {
    pub evidence: FrameEvidence,
    rgba: Vec<u8>,
}

impl FrameCapture {
    pub fn write_png(&self, path: impl AsRef<Path>) -> Result<(), NativeError> {
        let file = std::fs::File::create(path.as_ref()).map_err(|error| NativeError::Evidence {
            detail: format!("failed to create {}: {error}", path.as_ref().display()),
        })?;
        let mut encoder = png::Encoder::new(file, self.evidence.width, self.evidence.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| NativeError::Evidence {
                detail: format!("failed to create PNG header: {error}"),
            })?;
        writer
            .write_image_data(&self.rgba)
            .map_err(|error| NativeError::Evidence {
                detail: format!("failed to write PNG pixels: {error}"),
            })
    }
}

#[derive(Debug, Error)]
pub enum NativeError {
    #[error("native GPU backend unavailable: {detail}")]
    NativeBackendUnavailable { detail: String },
    #[error("native Ray Query unsupported: {detail}")]
    RayQueryUnsupported {
        detail: String,
        capabilities: Box<NativeCapabilities>,
    },
    #[error("native GPU initialization failed: {detail}")]
    GpuInitialization { detail: String },
    #[error("native render failed: {detail}")]
    Render { detail: String },
    #[error("native evidence failed: {detail}")]
    Evidence { detail: String },
}

impl NativeError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::NativeBackendUnavailable { .. } => "native-backend-unavailable",
            Self::RayQueryUnsupported { .. } => "ray-query-unsupported",
            Self::GpuInitialization { .. } => "gpu-initialization-failed",
            Self::Render { .. } => "render-failed",
            Self::Evidence { .. } => "evidence-failed",
        }
    }

    pub fn capabilities(&self) -> Option<&NativeCapabilities> {
        match self {
            Self::RayQueryUnsupported { capabilities, .. } => Some(capabilities),
            _ => None,
        }
    }
}

pub fn analyze_rgba(width: u32, height: u32, rgba: Vec<u8>) -> Result<FrameCapture, NativeError> {
    let expected = width as usize * height as usize * 4;
    if width == 0 || height == 0 || rgba.len() != expected {
        return Err(NativeError::Evidence {
            detail: format!(
                "RGBA length mismatch: expected {expected} bytes for {width}x{height}, got {}",
                rgba.len()
            ),
        });
    }

    let mut non_black = 0_u32;
    let mut min_rgb = [u8::MAX; 3];
    let mut max_rgb = [0_u8; 3];
    for pixel in rgba.chunks_exact(4) {
        if pixel[0] > 2 || pixel[1] > 2 || pixel[2] > 2 {
            non_black += 1;
            for channel in 0..3 {
                min_rgb[channel] = min_rgb[channel].min(pixel[channel]);
                max_rgb[channel] = max_rgb[channel].max(pixel[channel]);
            }
        }
    }

    let total = width * height;
    let triangle_visible = non_black > total / 100 && non_black < total / 2;
    let varied_channels = (0..3)
        .filter(|&channel| max_rgb[channel].saturating_sub(min_rgb[channel]) >= 24)
        .count();
    let barycentric_variation = non_black > 0 && varied_channels >= 2;
    let pixel_at = |x: u32, y: u32| {
        let offset = ((y * width + x) * 4) as usize;
        [
            rgba[offset],
            rgba[offset + 1],
            rgba[offset + 2],
            rgba[offset + 3],
        ]
    };

    Ok(FrameCapture {
        evidence: FrameEvidence {
            width,
            height,
            non_black_pixel_count: non_black,
            triangle_visible,
            barycentric_variation,
            center_pixel: pixel_at(width / 2, height / 2),
            corner_pixel: pixel_at(0, 0),
        },
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_bounded_varying_hit_region() {
        let mut rgba = vec![0_u8; 16 * 16 * 4];
        for pixel in rgba.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        for y in 5..11 {
            for x in 5..11 {
                let offset = (y * 16 + x) * 4;
                rgba[offset] = (x * 17) as u8;
                rgba[offset + 1] = (y * 17) as u8;
                rgba[offset + 2] = 64;
            }
        }
        let capture = analyze_rgba(16, 16, rgba).unwrap();
        assert!(capture.evidence.triangle_visible);
        assert!(capture.evidence.barycentric_variation);
    }

    #[test]
    fn empty_frame_is_not_visible() {
        let mut rgba = vec![0_u8; 8 * 8 * 4];
        for pixel in rgba.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        let capture = analyze_rgba(8, 8, rgba).unwrap();
        assert!(!capture.evidence.triangle_visible);
        assert_eq!(capture.evidence.non_black_pixel_count, 0);
    }

    #[test]
    fn error_codes_are_closed_and_serializable_evidence_is_stable() {
        let errors = [
            NativeError::NativeBackendUnavailable { detail: "x".into() },
            NativeError::RayQueryUnsupported {
                detail: "x".into(),
                capabilities: Box::new(NativeCapabilities {
                    backend: "Metal".into(),
                    ray_query: false,
                    adapter: AdapterFacts {
                        name: "fixture".into(),
                        vendor: 0,
                        device: 0,
                        device_type: "Other".into(),
                        driver: String::new(),
                        driver_info: String::new(),
                    },
                }),
            },
            NativeError::GpuInitialization { detail: "x".into() },
            NativeError::Render { detail: "x".into() },
            NativeError::Evidence { detail: "x".into() },
        ];
        assert_eq!(
            errors.map(|error| error.code()),
            [
                "native-backend-unavailable",
                "ray-query-unsupported",
                "gpu-initialization-failed",
                "render-failed",
                "evidence-failed",
            ]
        );
        let json = serde_json::to_value(FrameEvidence {
            width: 1,
            height: 1,
            non_black_pixel_count: 0,
            triangle_visible: false,
            barycentric_variation: false,
            center_pixel: [0, 0, 0, 255],
            corner_pixel: [0, 0, 0, 255],
        })
        .unwrap();
        assert_eq!(json["nonBlackPixelCount"], 0);
    }
}
