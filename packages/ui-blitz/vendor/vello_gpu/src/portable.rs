// Copyright 2026 the Vello Authors and ForgeAX contributors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Engine-owned GPU execution of the existing Vello sparse-strip schedule.
//! This module has no device, WebGL context, queue, shader compiler or submission.
#![allow(
    missing_docs,
    reason = "wire fields share the Engine GPU-ABI.md contract"
)]

use crate::blend::{BlendStrip, GpuBlendInstance};
use crate::copy::GpuCopyInstance;
use crate::draw::ExternalTextureRun;
use crate::filter::FilterPassPlan;
use crate::gradient_cache::GradientRampCache;
use crate::paint::{PaintResolver, TextureSourceId};
use crate::render::common::{
    DeviceLimits, GpuBlurredRoundedRect, GpuClearInstance, GpuEncodedImage, GpuEncodedPaint,
    GpuLinearGradient, GpuRadialGradient, GpuSweepGradient, pack_image_offset, pack_image_params,
    pack_image_size, pack_radial_kind_and_swapped, pack_texture_width_and_extend_mode, pack_tint,
};
use crate::schedule::round::BlendOp;
use crate::schedule::{Backend, IntermediateTextureAllocations, Schedule, ScheduleStorage};
use crate::target::{
    BlendPassBindings, DrawPassBindings, DrawPassTarget, FilterPassBindings, LayerTextureId,
    RootTarget, TextureParity,
};
use crate::util::RangedSlice;
use crate::{GpuStrip, RenderSettings, Resources, Scene};
use alloc::{collections::BTreeMap, format, string::String, sync::Arc, vec, vec::Vec};
use serde::Serialize;
use vello_common::{
    TextureId,
    encode::{
        EncodedBlurredRoundedRectangle, EncodedGradient, EncodedKind, EncodedPaint,
        MAX_GRADIENT_LUT_SIZE, RadialKind,
    },
    geometry::{RectU16, SizeU16},
    paint::ImageSource,
    peniko,
};

/// Owned bytes of one sampled data texture; no GPU resource identity.
#[derive(Debug, Serialize)]
pub struct DataTexture {
    pub width: u32,
    pub height: u32,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

impl DataTexture {
    fn new(bytes: &[u8], bytes_per_texel: usize, limit: u32) -> Result<Self, String> {
        let texels = bytes.len().div_ceil(bytes_per_texel).max(1);
        let width = texels
            .min(limit as usize)
            .next_power_of_two()
            .min(limit as usize);
        let height = texels.div_ceil(width);
        if height > limit as usize {
            return Err(format!(
                "ui-gpu-capacity: data texture exceeds {limit} by {limit}"
            ));
        }
        let mut data = vec![0; width * height * bytes_per_texel];
        data[..bytes.len()].copy_from_slice(bytes);
        Ok(Self {
            width: width as u32,
            height: height as u32,
            data,
        })
    }
}

/// Immutable, decoded image source retained independently of a GPU generation.
#[derive(Debug, Clone, Serialize)]
pub struct Image {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

/// The five fixed Vello raster operations, after dependency scheduling.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Pass {
    Strip {
        target: u32,
        child: Option<u32>,
        image: Option<u32>,
        #[serde(with = "serde_bytes")]
        instances: Vec<u8>,
    },
    Clear {
        target: u32,
        #[serde(with = "serde_bytes")]
        instances: Vec<u8>,
    },
    Blend {
        even: u32,
        odd: u32,
        #[serde(with = "serde_bytes")]
        instances: Vec<u8>,
    },
    Copy {
        target: u32,
        source: u32,
        #[serde(with = "serde_bytes")]
        instances: Vec<u8>,
    },
    Filter {
        target: u32,
        source: u32,
        #[serde(with = "serde_bytes")]
        instances: Vec<u8>,
    },
}

/// One complete, replayable UI projection. The renderer accepts it atomically.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub layer_width: u32,
    pub layer_height: u32,
    pub layer_pages: [usize; 2],
    pub scratch: bool,
    pub alphas: DataTexture,
    pub paints: DataTexture,
    pub gradients: DataTexture,
    pub filter_data: DataTexture,
    pub images: Vec<Image>,
    pub passes: Vec<Pass>,
}

/// Persistent CPU preparation state for one UI document.
#[derive(Debug)]
pub struct Preparation {
    pub resources: Resources,
    gradient_cache: GradientRampCache,
    encoded_paints: Vec<GpuEncodedPaint>,
    paint_idxs: Vec<u32>,
    schedule_storage: ScheduleStorage,
    settings: RenderSettings,
    limit: u32,
    images: BTreeMap<(u8, u64), Image>,
    pixmaps: BTreeMap<u64, Arc<vello_common::pixmap::Pixmap>>,
    live_images: Vec<u32>,
    next_image: u32,
}

impl Preparation {
    pub fn new(max_texture_dimension_2d: u32) -> Result<Self, String> {
        if max_texture_dimension_2d == 0 {
            return Err("ui-gpu-capacity: texture dimension must be positive".into());
        }
        let limit = max_texture_dimension_2d.min(4096);
        // Power-of-two data widths keep the upstream shift/mask addressing exact.
        let limit = 1 << (31 - limit.leading_zeros());
        let mut settings = RenderSettings::default();
        settings.memory_settings.layers_config.max_textures = Some(32);
        settings.memory_settings.normalize(&DeviceLimits {
            max_texture_dimension_2d: limit as u16,
        });
        Ok(Self {
            resources: Resources::new(settings.memory_settings.image_atlas_config),
            gradient_cache: GradientRampCache::new(
                limit * limit / MAX_GRADIENT_LUT_SIZE as u32,
                settings.level,
            ),
            encoded_paints: Vec::new(),
            paint_idxs: Vec::new(),
            schedule_storage: ScheduleStorage::default(),
            settings,
            limit,
            images: BTreeMap::new(),
            pixmaps: BTreeMap::new(),
            live_images: Vec::new(),
            next_image: 1,
        })
    }

    /// Begin another source projection while retaining preparation caches.
    pub fn begin(&mut self) {
        self.live_images.clear();
    }

    /// Admit image bytes without allocating an atlas or a GPU texture.
    pub fn image(&mut self, source: &peniko::ImageData) -> Result<TextureId, String> {
        if source.width > self.limit || source.height > self.limit {
            return Err("ui-gpu-capacity: image exceeds the device texture extent".into());
        }
        let key = (0, source.data.id());
        if !self.images.contains_key(&key) {
            let ImageSource::Pixmap(pixmap) = ImageSource::from_peniko_image_data(source) else {
                return Err("ui-gpu-image: decoded image did not produce pixels".into());
            };
            let id = self.next_image;
            self.next_image = id
                .checked_add(1)
                .ok_or("ui-gpu-capacity: image identity exhausted")?;
            self.images.insert(
                key,
                Image {
                    id,
                    width: source.width,
                    height: source.height,
                    data: pixmap.data_as_u8_slice().to_vec(),
                },
            );
        }
        let id = self.images[&key].id;
        if !self.live_images.contains(&id) {
            self.live_images.push(id);
        }
        Ok(TextureId(u64::from(id)))
    }

    pub fn prepare(&mut self, scene: &mut Scene) -> Result<Frame, String> {
        if u32::from(scene.width()) > self.limit || u32::from(scene.height()) > self.limit {
            return Err("ui-gpu-capacity: UI exceeds the device texture extent".into());
        }
        // Uncached color/bitmap glyphs carry ordinary Pixmaps. Preserve their
        // retained source identity, then use the same external-image contract.
        for paint in &mut scene.encoded_paints {
            if let EncodedPaint::Image(image) = paint {
                if let ImageSource::Pixmap(pixmap) = &image.source {
                    let pointer = Arc::as_ptr(pixmap) as usize as u64;
                    let key = (1, pointer);
                    if !self.images.contains_key(&key) {
                        let id = self.next_image;
                        self.next_image = id
                            .checked_add(1)
                            .ok_or("ui-gpu-capacity: image identity exhausted")?;
                        self.images.insert(
                            key,
                            Image {
                                id,
                                width: pixmap.width().into(),
                                height: pixmap.height().into(),
                                data: pixmap.data_as_u8_slice().to_vec(),
                            },
                        );
                        // Retention makes this local identity generation-safe. It
                        // is never serialized or interpreted outside this module.
                        self.pixmaps.insert(pointer, pixmap.clone());
                    }
                    let id = self.images[&key].id;
                    if !self.live_images.contains(&id) {
                        self.live_images.push(id);
                    }
                    image.source = ImageSource::external_texture(
                        TextureId(id.into()),
                        RectU16::new(0, 0, pixmap.width(), pixmap.height()),
                        true,
                    );
                }
            }
        }
        self.prepare_gpu_encoded_paints(&scene.encoded_paints)?;
        let layers = self.settings.memory_settings.layers_config;
        let texture_size = layers
            .required_intermediate_texture_size(&scene.recorder)
            .map_err(|e| format!("ui-gpu-capacity: {e}"))?;
        let schedule = Schedule::try_new(
            &mut self.schedule_storage,
            scene,
            RootTarget::UserSurface,
            false,
            PaintResolver::new(&scene.encoded_paints, &self.paint_idxs),
            texture_size,
            IntermediateTextureAllocations::default(),
            layers.max_textures,
        )
        .map_err(|e| format!("ui-gpu-schedule: {e}"))?;
        let requirements = schedule.intermediate_texture_requirements();
        let alphas = DataTexture::new(&scene.strip_storage.borrow().alphas, 16, self.limit)?;
        let mut paint_bytes = Vec::new();
        for paint in &self.encoded_paints {
            paint_bytes.extend_from_slice(paint.as_bytes());
        }
        let paints = DataTexture::new(&paint_bytes, 16, self.limit)?;
        let gradient_bytes = self.gradient_cache.take_luts();
        let gradients = DataTexture::new(&gradient_bytes, 4, self.limit)?;
        self.gradient_cache.restore_luts(gradient_bytes);
        let mut filter_bytes =
            vec![0; self.schedule_storage.filter_context.total_texels() as usize * 16];
        self.schedule_storage
            .filter_context
            .serialize_to_buffer(&mut filter_bytes);
        let filter_data = DataTexture::new(&filter_bytes, 16, self.limit)?;
        let mut recorder = PassRecorder {
            texture_size,
            passes: Vec::new(),
        };
        crate::schedule::execute(
            &mut recorder,
            &mut self.schedule_storage,
            schedule,
            RootTarget::UserSurface,
        )?;
        self.gradient_cache.maintain();
        self.resources.glyph_prep_cache.maintain();
        self.images
            .retain(|_, image| self.live_images.contains(&image.id));
        self.pixmaps
            .retain(|pointer, _| self.images.contains_key(&(1, *pointer)));
        Ok(Frame {
            version: 1,
            width: scene.width().into(),
            height: scene.height().into(),
            layer_width: texture_size.width().into(),
            layer_height: texture_size.height().into(),
            layer_pages: requirements.allocations.layer_pages,
            scratch: requirements.allocations.scratch,
            alphas,
            paints,
            gradients,
            filter_data,
            images: self.images.values().cloned().collect(),
            passes: recorder.passes,
        })
    }

    fn prepare_gpu_encoded_paints(&mut self, paints: &[EncodedPaint]) -> Result<(), String> {
        self.encoded_paints.clear();
        self.paint_idxs.clear();
        let mut offset = 0;
        for paint in paints {
            self.paint_idxs.push(offset);
            let encoded = match paint {
                EncodedPaint::Image(image) => match &image.source {
                    ImageSource::ExternalTexture { source_region, .. } => {
                        self.encode_external_texture_paint(image, *source_region)
                    }
                    _ => return Err("ui-gpu-image: image needs a retained external source".into()),
                },
                EncodedPaint::Gradient(gradient) => {
                    let (start, width) = self.gradient_cache.get_or_create_ramp(gradient);
                    self.encode_gradient_paint(gradient, width, start)
                }
                EncodedPaint::BlurredRoundedRect(rect) => {
                    Self::encode_blurred_rounded_rect_paint(rect)
                }
            };
            offset += encoded.size_texels();
            self.encoded_paints.push(encoded);
        }
        self.paint_idxs.push(offset);
        Ok(())
    }
}

fn layer_id(id: LayerTextureId) -> u32 {
    2 + 2 * u32::from(id.page_index) + id.texture_parity.get_parity() as u32
}
fn target_id(target: DrawPassTarget) -> u32 {
    match target {
        DrawPassTarget::Root(_) => 0,
        DrawPassTarget::Layer(id) => layer_id(id),
    }
}

struct PassRecorder {
    texture_size: SizeU16,
    passes: Vec<Pass>,
}
impl Backend for PassRecorder {
    type Error = String;
    fn opaque_draw_pass(&mut self, _: &[GpuStrip], _: &[ExternalTextureRun]) -> Result<(), String> {
        Err("ui-gpu-schedule: depth-disabled preparation produced opaque work".into())
    }
    fn draw_pass(
        &mut self,
        strips: RangedSlice<'_, GpuStrip>,
        runs: &[ExternalTextureRun],
        bindings: DrawPassBindings,
    ) -> Result<(), String> {
        let strips: Vec<GpuStrip> = strips.iter().copied().collect();
        let target = target_id(bindings.target);
        let child = bindings.child.map(layer_id);
        if runs.is_empty() {
            self.passes.push(Pass::Strip {
                target,
                child,
                image: None,
                instances: bytemuck::cast_slice(&strips).to_vec(),
            });
        } else {
            for (index, run) in runs.iter().enumerate() {
                let end = runs
                    .get(index + 1)
                    .map_or(strips.len(), |next| next.strips_start);
                let image = match run.bindings.as_array()[0] {
                    None => None,
                    Some(TextureSourceId::External(TextureId(id))) => Some(
                        u32::try_from(id).map_err(|_| "ui-gpu-image: invalid image identity")?,
                    ),
                    Some(TextureSourceId::Atlas(_)) => {
                        return Err("ui-gpu-image: unexpected atlas source".into());
                    }
                };
                self.passes.push(Pass::Strip {
                    target,
                    child,
                    image,
                    instances: bytemuck::cast_slice(&strips[run.strips_start..end]).to_vec(),
                });
            }
        }
        Ok(())
    }
    fn clear_pass(&mut self, target: LayerTextureId, rects: &[RectU16]) -> Result<(), String> {
        let instances: Vec<_> = rects
            .iter()
            .map(|rect| GpuClearInstance {
                origin: [rect.x0.into(), rect.y0.into()],
                size: [rect.width().into(), rect.height().into()],
                target_size: [
                    self.texture_size.width().into(),
                    self.texture_size.height().into(),
                ],
                color: 0,
            })
            .collect();
        self.passes.push(Pass::Clear {
            target: layer_id(target),
            instances: bytemuck::cast_slice(&instances).to_vec(),
        });
        Ok(())
    }
    fn blend_pass(
        &mut self,
        blends: RangedSlice<'_, BlendOp>,
        strips: &[BlendStrip],
        bindings: BlendPassBindings,
    ) -> Result<(), String> {
        let mut instances = Vec::new();
        for blend in blends.iter() {
            if let Some(range) = &blend.clip_strips {
                instances.extend(
                    strips[range.start as usize..range.end as usize]
                        .iter()
                        .map(|s| GpuBlendInstance::new(blend, Some(*s), self.texture_size)),
                );
            } else {
                instances.push(GpuBlendInstance::new(blend, None, self.texture_size));
            }
        }
        self.passes.push(Pass::Blend {
            even: layer_id(bindings.layer_id(TextureParity::Even)),
            odd: layer_id(bindings.layer_id(TextureParity::Odd)),
            instances: bytemuck::cast_slice(&instances).to_vec(),
        });
        let copies: Vec<GpuCopyInstance> = instances
            .into_iter()
            .map(GpuBlendInstance::copy_from_scratch)
            .collect();
        self.passes.push(Pass::Copy {
            target: layer_id(bindings.target()),
            source: 1,
            instances: bytemuck::cast_slice(&copies).to_vec(),
        });
        Ok(())
    }
    fn filter_pass(
        &mut self,
        plan: &FilterPassPlan,
        bindings: FilterPassBindings,
    ) -> Result<(), String> {
        if let Some(copies) = plan.copy_pass() {
            self.passes.push(Pass::Copy {
                target: 1,
                source: layer_id(bindings.target()),
                instances: bytemuck::cast_slice(copies).to_vec(),
            });
        }
        for (step, instances) in plan.steps().enumerate() {
            self.passes.push(Pass::Filter {
                target: layer_id(bindings.output(step)),
                source: layer_id(bindings.input(step)),
                instances: bytemuck::cast_slice(instances).to_vec(),
            });
        }
        Ok(())
    }
}

impl Preparation {
    fn encode_external_texture_paint(
        &self,
        image: &vello_common::encode::EncodedImage,
        region: RectU16,
    ) -> GpuEncodedPaint {
        let transform = image.transform.as_coeffs().map(|x| x as f32);
        let image_size = pack_image_size(region.width(), region.height());
        let image_offset = pack_image_offset(region.x0, region.y0);
        let image_params = pack_image_params(
            image.sampler.quality as u32,
            image.sampler.x_extend as u32,
            image.sampler.y_extend as u32,
        );
        let (tint, tint_mode) = pack_tint(image.tint);

        GpuEncodedPaint::Image(GpuEncodedImage {
            image_params,
            image_size,
            image_offset,
            transform,
            tint,
            tint_mode,
            image_padding: 0,
        })
    }

    fn encode_gradient_paint(
        &self,
        gradient: &EncodedGradient,
        gradient_width: u32,
        gradient_start: u32,
    ) -> GpuEncodedPaint {
        let transform = gradient.transform.as_coeffs().map(|x| x as f32);
        let extend_mode = match gradient.extend {
            peniko::Extend::Pad => 0,
            peniko::Extend::Repeat => 1,
            peniko::Extend::Reflect => 2,
        };
        let texture_width_and_extend_mode =
            pack_texture_width_and_extend_mode(gradient_width, extend_mode);

        match &gradient.kind {
            EncodedKind::Linear(_) => GpuEncodedPaint::LinearGradient(GpuLinearGradient {
                texture_width_and_extend_mode,
                gradient_start,
                transform,
            }),
            EncodedKind::Radial(radial) => {
                let (kind, bias, scale, fp0, fp1, fr1, f_focal_x, f_is_swapped, scaled_r0_squared) =
                    match radial {
                        RadialKind::Radial { bias, scale } => {
                            (0, *bias, *scale, 0.0, 0.0, 0.0, 0.0, 0, 0.0)
                        }
                        RadialKind::Strip { scaled_r0_squared } => {
                            (1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0, *scaled_r0_squared)
                        }
                        RadialKind::Focal {
                            focal_data,
                            fp0,
                            fp1,
                        } => (
                            2,
                            *fp0,
                            *fp1,
                            *fp0,
                            *fp1,
                            focal_data.fr1,
                            focal_data.f_focal_x,
                            focal_data.f_is_swapped as u32,
                            0.0,
                        ),
                    };
                GpuEncodedPaint::RadialGradient(GpuRadialGradient {
                    texture_width_and_extend_mode,
                    gradient_start,
                    transform,
                    kind_and_f_is_swapped: pack_radial_kind_and_swapped(kind, f_is_swapped),
                    bias,
                    scale,
                    fp0,
                    fp1,
                    fr1,
                    f_focal_x,
                    scaled_r0_squared,
                })
            }
            EncodedKind::Sweep(sweep) => GpuEncodedPaint::SweepGradient(GpuSweepGradient {
                texture_width_and_extend_mode,
                gradient_start,
                transform,
                start_angle: sweep.start_angle,
                inv_angle_delta: sweep.inv_angle_delta,
                _padding: [0, 0],
            }),
        }
    }

    fn encode_blurred_rounded_rect_paint(rect: &EncodedBlurredRoundedRectangle) -> GpuEncodedPaint {
        GpuEncodedPaint::BlurredRoundedRect(GpuBlurredRoundedRect {
            transform: rect.transform.as_coeffs().map(|x| x as f32),
            color: rect.color.as_premul_rgba8().to_u32(),
            invert: u32::from(rect.invert),
            params0: [
                rect.exponent,
                rect.recip_exponent,
                rect.scale,
                rect.std_dev_inv,
            ],
            params1: [rect.min_edge, rect.w, rect.h, rect.r1],
            size: [rect.width, rect.height],
            _padding1: [0, 0],
        })
    }
}
