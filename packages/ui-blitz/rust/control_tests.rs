use super::*;

#[test]
fn checkable_auto_dimensions_retain_native_intrinsic_size() {
    let mut doc = UiDocument::new(
        "<style>input{box-sizing:border-box;min-width:0;width:100%}.choice input{width:auto}</style>
         <label class=choice><input type=checkbox checked>Hints</label>
         <label class=choice><input type=radio checked>Normal</label>",
        440, 240, 1.0, vec![],
    ).unwrap();
    for id in doc.query(doc.root(), "input").unwrap() {
        for (style, expected) in [
            ("", [13.0, 13.0]),
            ("width:auto;height:auto", [13.0, 13.0]),
            ("width:20px;height:auto", [20.0, 13.0]),
            ("width:auto;height:24px", [13.0, 24.0]),
            ("width:20px;height:24px", [20.0, 24.0]),
            ("width:0;height:0", [0.0, 0.0]),
            ("width:auto;height:auto", [13.0, 13.0]),
        ] {
            doc.set_attribute(id, "style", Some(style.into())).unwrap();
            assert_eq!(&doc.rect(id).unwrap()[2..4], &expected, "{style}");
        }
    }
}

#[test]
fn disabled_field_background_repaints_and_preserves_author_colors() {
    let mut doc = UiDocument::new(
        "<style>body{margin:0;background:#123}input{position:absolute;left:20px;top:20px;width:60px;height:24px;border:0;padding:0}</style><input disabled>",
        100, 80, 1.0, vec![],
    ).unwrap();
    let input = doc.query(doc.root(), "input").unwrap()[0];
    let background = |doc: &mut UiDocument| {
        let pixels = doc.paint().unwrap();
        let offset = (30 * 100 + 50) * 4;
        pixels[offset..offset + 4].to_vec()
    };
    assert_eq!(background(&mut doc), [84, 96, 108, 255]);
    doc.set_attribute(input, "disabled", None).unwrap();
    assert_eq!(background(&mut doc), [255, 255, 255, 255]);
    doc.set_attribute(input, "disabled", Some(String::new()))
        .unwrap();
    assert_eq!(background(&mut doc), [84, 96, 108, 255]);
    doc.set_attribute(input, "style", Some("background:#fff0d0".into()))
        .unwrap();
    assert_eq!(background(&mut doc), [255, 240, 208, 255]);
}

#[test]
fn checkable_markers_keep_the_chromium_measured_stroke_and_full_radio_ring() {
    let mut doc = UiDocument::new(
        "<style>body{margin:0;background:#10243a}input{position:absolute;top:10px;left:10px;margin:0;width:13px;height:13px}#radio{left:40px}</style><input type=checkbox checked><input id=radio type=radio checked>",
        80, 40, 1.0, vec![],
    ).unwrap();
    let pixels = doc.paint().unwrap();
    let rgb = |x: usize, y: usize| &pixels[(y * 80 + x) * 4..(y * 80 + x) * 4 + 3];
    // The 13px Chromium checkbox has 16 opaque white-core pixels. Keep
    // its readable 2px-scale tick rather than a one-pixel diagonal fragment.
    let mut white = 0;
    for y in 10..23 {
        for x in 10..23 {
            if rgb(x, y).iter().all(|channel| *channel > 240) {
                white += 1;
            }
        }
    }
    assert!(white >= 12, "visible checkbox tick: {white} white pixels");
    for x in [40, 46, 52] {
        let pixel = rgb(x, 16);
        assert!(
            pixel[0] < 50 && pixel[2] > 200,
            "radio reaches its 13px extent at x={x}: {pixel:?}"
        );
    }
}

#[test]
fn range_track_uses_full_endpoints_and_eight_pixel_chromium_thickness() {
    let mut doc = UiDocument::new(
        "<style>body{margin:0;background:#10243a}input{position:absolute;left:0;top:0;margin:0;width:100px;height:16px}</style><input type=range value=25>",
        100, 30, 1.0, vec![],
    ).unwrap();
    let input = doc.query(doc.root(), "input").unwrap()[0];
    for value in [0, 25, 50, 100] {
        doc.set_input_value(input, &value.to_string()).unwrap();
        let pixels = doc.paint().unwrap();
        let rgb = |x: usize, y: usize| &pixels[(y * 100 + x) * 4..(y * 100 + x) * 4 + 3];
        let center = (8.0 + 84.0 * f64::from(value) / 100.0).round() as usize;
        assert!(rgb(center, 2)[0] < 50 && rgb(center, 2)[2] > 200);
        let track_x = if value < 50 { 75 } else { 25 };
        assert_eq!(rgb(track_x, 3), [16, 36, 58]);
        assert_eq!(rgb(track_x, 12), [16, 36, 58]);
        assert!(rgb(track_x, 4) != [16, 36, 58] && rgb(track_x, 11) != [16, 36, 58]);
        if value == 25 {
            assert_eq!(rgb(75, 4), [178, 178, 178]);
            assert_eq!(rgb(75, 5), [239, 239, 239]);
            assert!(
                rgb(2, 8)[0] < 20 && rgb(2, 8)[2] > 235,
                "track reaches the 1px inset with an antialiased border"
            );
        }
    }
}

#[test]
fn percentage_controls_do_not_inflate_equal_grid_tracks_but_auto_keeps_intrinsic_width() {
    for tag in ["input", "textarea"] {
        let mut doc = UiDocument::new(
            &format!("<style>body{{margin:0}}section{{display:grid;grid-template-columns:1fr 1fr;width:200px;gap:16px}}label{{display:flex;flex-direction:column}}input,textarea{{font:16px sans-serif;min-width:0;width:100%;box-sizing:border-box}}</style><section><label><{tag}></{tag}></label><aside></aside></section>"),
            300, 150, 1.0,
            include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec(),
        ).unwrap();
        let label = doc.query(doc.root(), "label").unwrap()[0];
        let field = doc.query(doc.root(), tag).unwrap()[0];
        assert_eq!(
            doc.rect(label).unwrap()[2],
            92.0,
            "{tag} percentage min-content"
        );
        assert_eq!(doc.rect(field).unwrap()[2], 92.0);
        doc.set_attribute(field, "style", Some("width:auto".into()))
            .unwrap();
        assert!(
            doc.rect(label).unwrap()[2] > 150.0,
            "{tag} auto retains its columns"
        );
    }
}

#[test]
fn select_intrinsic_height_ignores_css_line_height_and_keeps_authored_height() {
    let mut doc = UiDocument::new(
        "<style>select{font:16px sans-serif}</style><select><option>Low</option></select>",
        200,
        150,
        1.0,
        include_bytes!(
            "../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf"
        )
        .to_vec(),
    )
    .unwrap();
    let select = doc.query(doc.root(), "select").unwrap()[0];
    let normal = doc.rect(select).unwrap()[3];
    for line_height in [10, 22, 40] {
        doc.set_attribute(
            select,
            "style",
            Some(format!("line-height:{line_height}px")),
        )
        .unwrap();
        assert_eq!(doc.rect(select).unwrap()[3], normal);
    }
    doc.set_attribute(select, "style", Some("height:40px".into()))
        .unwrap();
    assert_eq!(doc.rect(select).unwrap()[3], 40.0);
}

#[test]
fn disabled_native_fields_compose_with_white_and_dark_surfaces() {
    for (background, expected) in [("white", [248, 248, 248]), ("#10243a", [172, 178, 185])] {
        let mut doc = UiDocument::new(
            &format!("<style>body{{margin:0;background:{background}}}input{{position:absolute;left:10px;top:10px;width:60px;height:24px}}</style><input disabled>"),
            100, 80, 1.0, vec![],
        ).unwrap();
        let pixels = doc.paint().unwrap();
        let offset = (22 * 100 + 40) * 4;
        for (actual, expected) in pixels[offset..offset + 3].iter().zip(expected) {
            assert!(
                (*actual as i32 - expected).abs() <= 1,
                "{background}: actual {:?}",
                &pixels[offset..offset + 3]
            );
        }
    }
}
