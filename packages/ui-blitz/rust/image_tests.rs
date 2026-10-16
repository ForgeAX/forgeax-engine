use super::UiDocument;

fn aspect_pattern() -> Vec<u8> {
    data_url::DataUrl::process(include_str!("test-assets/aspect-pattern.txt"))
        .unwrap()
        .decode_to_vec()
        .unwrap()
        .0
}

#[test]
fn partially_scrolled_image_keeps_its_recorded_draw_and_visible_pixels_at_dpr3() {
    use anyrender::{Paint, Scene, recording::RenderCommand};
    let html = "<style>body{margin:0;background:white}#scroll{position:absolute;top:48px;width:480px;height:312px;padding:12px;box-sizing:border-box;overflow:auto}#card{width:222px;padding:8px;display:flex;flex-direction:column;gap:8px;background:#274460}header{height:20px}img{display:block;width:206px;height:96px;box-sizing:border-box;padding:8px;border:4px solid #8097af;image-rendering:pixelated}footer{height:40px}#tail{height:500px}</style><div id=scroll><div id=card><header></header><img src=pattern.png><footer></footer></div><div id=tail></div></div>";
    let mut doc = UiDocument::with_resources(
        html,
        480,
        360,
        1.0,
        Vec::new(),
        None,
        Some("https://ui.test/".into()),
    )
    .unwrap();
    let request = doc.resource_requests()[0];
    doc.resource_response(request, aspect_pattern()).unwrap();
    let scroll = doc.query(doc.root(), "#scroll").unwrap()[0];
    doc.scroll_to(scroll, 0.0, 120.0).unwrap();
    for ratio in [1, 2, 3, 1] {
        doc.set_viewport(480 * ratio, 360 * ratio, ratio as f32)
            .unwrap();
        doc.resolve();
        let mut scene = Scene::new();
        super::paint_scene(
            &mut scene,
            &mut doc.document,
            ratio as f64,
            480 * ratio,
            360 * ratio,
            0,
            0,
        );
        let image_work: Vec<_> = scene
            .commands
            .iter()
            .enumerate()
            .filter_map(|(index, command)| {
                if let RenderCommand::Fill(fill) = command
                    && let Paint::Image(image) = &fill.brush
                {
                    Some((
                        index,
                        fill.transform.as_coeffs(),
                        [image.image.width, image.image.height],
                    ))
                } else {
                    None
                }
            })
            .collect();
        eprintln!("DPR{ratio} recorded image work: {image_work:?}");
        assert_eq!(
            image_work.len(),
            1,
            "partially visible image must reach the painter at DPR{ratio}"
        );
        let pixels = doc.paint().unwrap();
        let offset =
            (((54 * ratio + ratio / 2) * 480 * ratio + 50 * ratio + ratio / 2) * 4) as usize;
        assert_eq!(
            &pixels[offset..offset + 4],
            &[51, 102, 224, 255],
            "DPR{ratio} visible image fragment"
        );
    }
}

#[test]
fn image_fit_retains_css_intrinsic_size_and_content_clip_across_device_scales() {
    for fit in ["fill", "contain", "cover", "none", "scale-down"] {
        let html = format!(
            "<style>body{{margin:0;background:white}}img{{display:block;margin:10px;box-sizing:border-box;width:100px;height:72px;padding:8px;border:4px solid #8097af;background:#15202c;object-fit:{fit};image-rendering:pixelated}}</style><img src=pattern.png>"
        );
        let mut reference = Vec::new();
        for ratio in [1, 2, 3] {
            let mut doc = UiDocument::with_resources(
                &html,
                120 * ratio,
                100 * ratio,
                ratio as f32,
                Vec::new(),
                None,
                Some("https://ui.test/".into()),
            )
            .unwrap();
            let request = doc.resource_requests()[0];
            doc.resource_response(request, aspect_pattern()).unwrap();
            let pixels = doc.paint().unwrap();
            let pixel = |x: usize, y: usize| {
                let ratio = ratio as usize;
                let offset = ((y * ratio + ratio / 2) * 120 * ratio + x * ratio + ratio / 2) * 4;
                &pixels[offset..offset + 4]
            };
            // Replaced content clips to its content box, leaving author padding visible.
            assert_eq!(
                pixel(16, 36),
                &[21, 32, 44, 255],
                "{fit}, DPR{ratio}: left padding"
            );
            assert_eq!(
                pixel(60, 16),
                &[21, 32, 44, 255],
                "{fit}, DPR{ratio}: top padding"
            );
            let mut samples = Vec::new();
            for y in (25..68).step_by(5) {
                for x in (25..95).step_by(5) {
                    samples.extend_from_slice(pixel(x, y));
                }
            }
            if ratio == 1 {
                reference = samples;
            } else {
                assert_eq!(
                    samples, reference,
                    "{fit}, DPR{ratio}: normalized source pixels"
                );
            }
        }
    }
}
