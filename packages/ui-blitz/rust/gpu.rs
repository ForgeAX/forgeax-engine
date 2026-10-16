//! AnyRender paint semantics projected into Vello's CPU preparation only.
//! GPU resources and command submission remain in the Engine Renderer.
use anyrender::filters::{EdgeMode, FilterEffect};
use anyrender::{Filter, Glyph, NormalizedCoord, Paint, PaintRef, PaintScene, RenderContext};
use glifo::FontEmbolden;
use std::sync::Arc;
use vello_common::{
    filter_effects::{Filter as VelloFilter, FilterPrimitive},
    geometry::RectU16,
    kurbo::{Affine, Diagonal2, Rect, Shape, Stroke},
    paint::{ImageSource, PaintType},
    peniko::{BlendMode, Color, Fill, FontData, ImageBrush, StyleRef},
};
use vello_gpu::{
    Scene,
    portable::{Frame, Preparation},
};

enum LayerKind {
    Layer,
    Clip,
}

pub struct GpuPainter {
    scene: Scene,
    preparation: Preparation,
    layers: Vec<LayerKind>,
    failure: Option<String>,
}

impl GpuPainter {
    pub fn new(width: u32, height: u32) -> Result<Self, String> {
        Ok(Self {
            scene: Scene::new(width as u16, height as u16),
            preparation: Preparation::new(4096)?,
            layers: Vec::new(),
            failure: None,
        })
    }

    pub fn begin(&mut self, width: u32, height: u32) {
        self.scene.reset_and_resize(width as u16, height as u16);
        self.preparation.begin();
        self.layers.clear();
        self.failure = None;
    }

    pub fn finish(&mut self) -> Result<Frame, String> {
        if let Some(failure) = self.failure.take() {
            return Err(failure);
        }
        if !self.layers.is_empty() {
            return Err("ui-gpu-layer: unbalanced paint layers".into());
        }
        self.preparation.prepare(&mut self.scene)
    }

    fn fail(&mut self, message: impl Into<String>) {
        if self.failure.is_none() {
            self.failure = Some(message.into());
        }
    }

    fn paint(&mut self, paint: PaintRef<'_>) -> PaintType {
        match paint {
            Paint::Solid(color) => PaintType::Solid(color),
            Paint::Gradient(gradient) => PaintType::Gradient(gradient.clone()),
            Paint::Image(image) => match self.preparation.image(image.image) {
                Ok(id) => PaintType::Image(ImageBrush {
                    image: ImageSource::external_texture(
                        id,
                        RectU16::new(0, 0, image.image.width as u16, image.image.height as u16),
                        true,
                    ),
                    sampler: image.sampler,
                }),
                Err(error) => {
                    self.fail(error);
                    PaintType::Solid(Color::TRANSPARENT)
                }
            },
            Paint::Resource(_) | Paint::Custom(_) => {
                self.fail("ui-gpu-paint: renderer-specific resources are not portable UI paint");
                PaintType::Solid(Color::TRANSPARENT)
            }
        }
    }
}

impl RenderContext for GpuPainter {}

impl PaintScene for GpuPainter {
    fn reset(&mut self) {
        self.scene.reset();
        self.layers.clear();
    }

    fn push_layer(
        &mut self,
        fill: Fill,
        blend: impl Into<BlendMode>,
        alpha: f32,
        transform: Affine,
        clip: &impl Shape,
        filter: Option<Arc<Filter>>,
        backdrop_filter: Option<Arc<Filter>>,
    ) {
        if backdrop_filter.is_some() {
            self.fail("ui-gpu-filter: native UI does not admit backdrop filters");
        }
        let filter = match filter.as_deref().map(convert_filter).transpose() {
            Ok(value) => value.flatten(),
            Err(error) => {
                self.fail(error);
                None
            }
        };
        self.scene.set_transform(transform);
        self.scene.set_fill_rule(fill);
        self.scene.push_clip_path(&clip.into_path(0.1));
        self.scene
            .push_layer(None, Some(blend.into()), Some(alpha), None, filter);
        self.layers.push(LayerKind::Layer);
    }

    fn push_clip_layer(&mut self, fill: Fill, transform: Affine, clip: &impl Shape) {
        self.scene.set_transform(transform);
        self.scene.set_fill_rule(fill);
        self.scene.push_clip_path(&clip.into_path(0.1));
        self.layers.push(LayerKind::Clip);
    }

    fn pop_layer(&mut self) {
        match self.layers.pop() {
            Some(LayerKind::Layer) => {
                self.scene.pop_layer();
                self.scene.pop_clip();
            }
            Some(LayerKind::Clip) => self.scene.pop_clip(),
            None => self.fail("ui-gpu-layer: pop without a matching layer"),
        }
    }

    fn stroke<'a>(
        &mut self,
        style: &Stroke,
        transform: Affine,
        paint: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        let paint = self.paint(paint.into());
        self.scene.set_transform(transform);
        self.scene.set_stroke(style.clone());
        self.scene.set_paint(paint);
        self.scene
            .set_paint_transform(brush_transform.unwrap_or(Affine::IDENTITY));
        self.scene.stroke_path(&shape.into_path(0.1));
    }

    fn fill<'a>(
        &mut self,
        fill: Fill,
        transform: Affine,
        paint: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        let paint = self.paint(paint.into());
        self.scene.set_transform(transform);
        self.scene.set_fill_rule(fill);
        self.scene.set_paint(paint);
        self.scene
            .set_paint_transform(brush_transform.unwrap_or(Affine::IDENTITY));
        self.scene.fill_path(&shape.into_path(0.1));
    }

    fn draw_glyphs<'a, 's: 'a>(
        &'a mut self,
        font: &'a FontData,
        font_size: f32,
        hint: bool,
        normalized_coords: &'a [NormalizedCoord],
        embolden: vello_common::kurbo::Vec2,
        style: impl Into<StyleRef<'a>>,
        paint: impl Into<PaintRef<'a>>,
        brush_alpha: f32,
        transform: Affine,
        glyph_transform: Option<Affine>,
        glyphs: impl Iterator<Item = Glyph> + Clone,
    ) {
        let paint = self.paint(paint.into());
        self.scene.set_paint(paint);
        self.scene.reset_paint_transform();
        self.scene.set_transform(transform);
        if brush_alpha != 1.0 {
            self.scene.push_opacity_layer(brush_alpha);
        }
        let style: StyleRef<'a> = style.into();
        let result = match style {
            StyleRef::Fill(fill) => {
                self.scene.set_fill_rule(fill);
                self.scene
                    .glyph_run(&mut self.preparation.resources, font)
                    .font_size(font_size)
                    .hint(hint)
                    .normalized_coords(normalized_coords)
                    .font_embolden(FontEmbolden::new(Diagonal2::new(embolden.x, embolden.y)))
                    .glyph_transform(glyph_transform.unwrap_or_default())
                    .fill_glyphs(glyphs.map(|g| glifo::Glyph {
                        id: g.id,
                        x: g.x,
                        y: g.y,
                    }))
            }
            StyleRef::Stroke(stroke) => {
                self.scene.set_stroke(stroke.clone());
                self.scene
                    .glyph_run(&mut self.preparation.resources, font)
                    .font_size(font_size)
                    .hint(hint)
                    .normalized_coords(normalized_coords)
                    .glyph_transform(glyph_transform.unwrap_or_default())
                    .stroke_glyphs(glyphs.map(|g| glifo::Glyph {
                        id: g.id,
                        x: g.x,
                        y: g.y,
                    }))
            }
        };
        if brush_alpha != 1.0 {
            self.scene.pop_layer();
        }
        if let Err(error) = result {
            self.fail(format!("ui-gpu-glyph: {error:?}"));
        }
    }

    fn draw_box_shadow(
        &mut self,
        transform: Affine,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
    ) {
        self.scene.set_transform(transform);
        self.scene.set_paint(PaintType::Solid(color));
        self.scene.reset_paint_transform();
        self.scene
            .fill_blurred_rounded_rect(&rect, radius as f32, std_dev as f32, false);
    }
}

fn convert_filter(filter: &Filter) -> Result<Option<VelloFilter>, String> {
    let nodes = filter.nodes();
    if nodes.is_empty() {
        return Ok(None);
    }
    if nodes.len() != 1 {
        return Err("ui-gpu-filter: native UI admits one filter operation".into());
    }
    let primitive = match &nodes[0].effect {
        FilterEffect::Flood(color) => FilterPrimitive::Flood { color: *color },
        FilterEffect::GaussianBlur(blur) => FilterPrimitive::GaussianBlur {
            std_deviation: blur.std_deviation,
            edge_mode: convert_edge(blur.edge_mode),
        },
        FilterEffect::DropShadow(shadow) => FilterPrimitive::DropShadow {
            dx: shadow.dx,
            dy: shadow.dy,
            std_deviation: shadow.std_deviation,
            color: shadow.color,
            edge_mode: convert_edge(shadow.edge_mode),
        },
        FilterEffect::Offset(offset) => FilterPrimitive::Offset {
            dx: offset.x as f32,
            dy: offset.y as f32,
        },
        FilterEffect::ColorMatrix(matrix) => FilterPrimitive::ColorMatrix { matrix: matrix.0 },
        _ => return Err("ui-gpu-filter: filter primitive is outside the native UI profile".into()),
    };
    Ok(Some(VelloFilter::from_primitive(primitive)))
}

fn convert_edge(edge: EdgeMode) -> vello_common::filter_effects::EdgeMode {
    use vello_common::filter_effects::EdgeMode as VelloEdge;
    match edge {
        EdgeMode::Duplicate => VelloEdge::Duplicate,
        EdgeMode::Wrap => VelloEdge::Wrap,
        EdgeMode::Mirror => VelloEdge::Mirror,
        EdgeMode::None => VelloEdge::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::UiDocument;
    use vello_gpu::portable::Pass;

    #[test]
    fn gpu_prepares_admitted_layers_masks_and_filters_without_cpu_raster() {
        let html = r#"<style>body{margin:0}.group{position:absolute;left:8px;top:8px;width:72px;height:72px;opacity:.6;overflow:hidden;border-radius:9px;transform:rotate(3deg)}.child{width:60px;height:60px;background:linear-gradient(blue,red);filter:brightness(.5);mask-image:linear-gradient(black,transparent)}.blur{position:absolute;left:40px;top:50px;width:20px;height:20px;background:green;filter:blur(2px)}</style><div class=group><div class=child></div></div><div class=blur></div>"#;
        let mut document = UiDocument::new(html, 100, 100, 1.0, vec![]).unwrap();
        let frame = document.prepare_gpu().unwrap();
        assert_eq!((frame.width, frame.height), (100, 100));
        assert!(
            frame
                .passes
                .iter()
                .any(|pass| matches!(pass, Pass::Filter { .. }))
        );
        assert!(
            frame
                .passes
                .iter()
                .any(|pass| matches!(pass, Pass::Blend { .. }))
        );
        assert!(matches!(document.painter, Some(crate::Painter::Gpu(_))));
        let exists = |target: u32| {
            target == 0
                || (target == 1 && frame.scratch)
                || (target >= 2
                    && ((target - 2) / 2) < frame.layer_pages[((target - 2) % 2) as usize] as u32)
        };
        for pass in &frame.passes {
            match pass {
                Pass::Strip {
                    target,
                    child,
                    instances,
                    ..
                } => {
                    assert!(exists(*target));
                    assert!(child.is_none_or(|child| exists(child) && child != *target));
                    assert_eq!(instances.len() % 24, 0);
                }
                Pass::Clear { target, instances } => {
                    assert!(exists(*target));
                    assert_eq!(instances.len() % 28, 0);
                }
                Pass::Blend {
                    even,
                    odd,
                    instances,
                } => {
                    assert!(frame.scratch && exists(*even) && exists(*odd));
                    assert_eq!(instances.len() % 32, 0);
                }
                Pass::Copy {
                    target,
                    source,
                    instances,
                } => {
                    assert!(exists(*target) && exists(*source) && target != source);
                    assert_eq!(instances.len() % 16, 0);
                }
                Pass::Filter {
                    target,
                    source,
                    instances,
                } => {
                    assert!(exists(*target) && exists(*source) && target != source);
                    assert!(*target >= 2 && *source >= 2);
                    assert_eq!(instances.len() % 36, 0);
                }
            }
        }
    }

    #[test]
    fn gpu_rejects_unportable_custom_paint_instead_of_returning_partial_output() {
        let mut painter = GpuPainter::new(20, 20).unwrap();
        painter.begin(20, 20);
        let custom: Paint = Paint::Custom(Arc::new(42_u32));
        painter.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            &custom,
            None,
            &Rect::new(0., 0., 20., 20.),
        );
        assert!(painter.finish().unwrap_err().starts_with("ui-gpu-paint:"));
    }

    #[test]
    fn cpu_color_matrix_is_a_recoverable_error_while_gpu_prepares_it() {
        let mut document = UiDocument::new(
            "<div style='width:20px;height:20px;background:red;filter:brightness(.5)'></div>",
            32,
            32,
            1.0,
            vec![],
        )
        .unwrap();
        assert!(
            document
                .paint()
                .unwrap_err()
                .starts_with("ui-cpu-unsupported-filter:")
        );
        assert!(
            document
                .prepare_gpu()
                .unwrap()
                .passes
                .iter()
                .any(|pass| matches!(pass, Pass::Filter { .. }))
        );
        let node = document.query(document.root(), "div").unwrap()[0];
        document
            .set_attribute(
                node,
                "style",
                Some("width:20px;height:20px;background:red".into()),
            )
            .unwrap();
        assert_eq!(document.paint().unwrap().len(), 32 * 32 * 4);
    }
}
