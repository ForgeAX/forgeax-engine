// Copyright 2026 the Vello Authors and ForgeaX contributors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Exercise the public portable path used by the AnyRender UI adapter.
use vello_common::kurbo::{Rect, Shape};
use vello_gpu::{Scene, portable::Preparation};

#[test]
fn rectangle_path_fill_does_not_regenerate_alpha_strips() {
    let mut scene = Scene::new(100, 100);
    scene.fill_path(&Rect::new(10.25, 20.5, 80.75, 90.0).to_path(0.1));
    let frame = Preparation::new(4096).unwrap().prepare(&mut scene).unwrap();
    assert!(!frame.passes.is_empty());
    assert_eq!(
        frame.alphas.data.len(),
        16,
        "exact rectangular geometry needs only the empty alpha placeholder"
    );
}

#[test]
fn rectangle_path_clips_retain_direct_geometry() {
    let mut scene = Scene::new(100, 100);
    scene.push_clip_path(&Rect::new(10.25, 5.5, 80.75, 90.0).to_path(0.1));
    scene.push_clip_path(&Rect::new(20.5, 0.0, 70.25, 60.75).to_path(0.1));
    scene.fill_rect(&Rect::new(0.0, 20.25, 50.5, 80.0));
    let frame = Preparation::new(4096).unwrap().prepare(&mut scene).unwrap();
    assert!(!frame.passes.is_empty());
    assert_eq!(
        frame.alphas.data.len(),
        16,
        "exact rectangular clips must not force rectangle draws through alpha strips"
    );
}

#[test]
fn blitz_implicit_rectangle_clip_uses_fill_closure() {
    use vello_common::kurbo::BezPath;
    // CssBox::shape emits four corners without a ClosePath; fills/clips close it.
    let mut path = BezPath::new();
    path.move_to((10.25, 5.5));
    path.line_to((80.75, 5.5));
    path.line_to((80.75, 90.0));
    path.line_to((10.25, 90.0));
    let mut scene = Scene::new(100, 100);
    scene.push_clip_path(&path);
    scene.fill_rect(&Rect::new(0.0, 20.25, 50.5, 80.0));
    let frame = Preparation::new(4096).unwrap().prepare(&mut scene).unwrap();
    assert!(!frame.passes.is_empty());
    assert_eq!(frame.alphas.data.len(), 16);
}

#[test]
fn filled_rectangle_contours_keep_winding_start_and_closure_semantics() {
    use vello_common::kurbo::{BezPath, Point};
    let points = [
        Point::new(10.25, 20.5),
        Point::new(80.75, 20.5),
        Point::new(80.75, 90.0),
        Point::new(10.25, 90.0),
    ];
    for start in 0..4 {
        for direction in [1, 3] {
            for explicit_edge in [false, true] {
                for close in [false, true] {
                    let mut path = BezPath::new();
                    path.move_to(points[start]);
                    for step in 1..4 {
                        path.line_to(points[(start + direction * step) % 4]);
                    }
                    if explicit_edge {
                        path.line_to(points[start]);
                    }
                    if close {
                        path.close_path();
                    }
                    let mut scene = Scene::new(100, 100);
                    scene.fill_path(&path);
                    let frame = Preparation::new(4096).unwrap().prepare(&mut scene).unwrap();
                    assert!(!frame.passes.is_empty());
                    assert_eq!(frame.alphas.data.len(), 16);
                }
            }
        }
    }
}

#[test]
fn rectangle_paths_keep_transform_and_aliasing_admission() {
    use vello_common::kurbo::Affine;
    let rect = Rect::new(10.25, 20.5, 40.75, 50.0);
    for transform in [
        Affine::IDENTITY,
        Affine::translate((0.25, -3.5)),
        Affine::scale_non_uniform(1.5, 0.7),
        Affine::new([-1.0, 0.0, 0.0, 1.0, 75.0, 0.0]),
        Affine::rotate(0.3),
        Affine::new([1.0, 0.2, 0.15, 1.0, 0.0, 0.0]),
    ] {
        for threshold in [None, Some(128)] {
            for clipping in [false, true] {
                let mut actual = Scene::new(100, 100);
                let mut expected = Scene::new(100, 100);
                for scene in [&mut actual, &mut expected] {
                    scene.set_transform(transform);
                    scene.set_aliasing_threshold(threshold);
                }
                if clipping {
                    actual.push_clip_path(&rect.to_path(0.1));
                    expected.push_clip_rect(&rect);
                    for scene in [&mut actual, &mut expected] {
                        scene.reset_transform();
                        scene.fill_rect(&Rect::new(0.0, 0.0, 100.0, 100.0));
                    }
                } else {
                    actual.fill_path(&rect.to_path(0.1));
                    expected.fill_rect(&rect);
                }
                let actual = Preparation::new(4096)
                    .unwrap()
                    .prepare(&mut actual)
                    .unwrap();
                let expected = Preparation::new(4096)
                    .unwrap()
                    .prepare(&mut expected)
                    .unwrap();
                assert_eq!(actual.alphas.data, expected.alphas.data);
                assert_eq!(
                    format!("{:?}", actual.passes),
                    format!("{:?}", expected.passes)
                );
            }
        }
    }
}

#[test]
fn complex_contours_keep_the_path_pipeline() {
    use vello_common::kurbo::BezPath;
    use vello_common::peniko::Fill;
    let rect = Rect::new(10.25, 20.5, 80.75, 90.0);
    let mut compound = rect.to_path(0.1);
    compound.extend(Rect::new(30.0, 35.0, 60.0, 60.0).to_path(0.1));
    let mut skewed = BezPath::new();
    skewed.move_to((10.25, 20.5));
    skewed.line_to((80.75, 25.0));
    skewed.line_to((80.75, 90.0));
    skewed.line_to((10.25, 90.0));
    skewed.close_path();
    let mut curved = BezPath::new();
    curved.move_to((10.25, 20.5));
    curved.quad_to((40.0, 0.0), (80.75, 20.5));
    curved.line_to((80.75, 90.0));
    curved.line_to((10.25, 90.0));
    curved.close_path();
    for path in [compound, skewed, curved] {
        let mut scene = Scene::new(100, 100);
        scene.set_fill_rule(Fill::EvenOdd);
        scene.fill_path(&path);
        let frame = Preparation::new(4096).unwrap().prepare(&mut scene).unwrap();
        assert!(!frame.passes.is_empty());
        assert!(
            frame.alphas.data.len() > 16,
            "complex contour must retain its coverage mask"
        );
    }
}

#[test]
fn degenerate_rectangle_paths_keep_zero_coverage() {
    for rect in [
        Rect::new(10.0, 20.0, 10.0, 50.0),
        Rect::new(10.0, 20.0, 50.0, 20.0),
    ] {
        let mut scene = Scene::new(100, 100);
        scene.fill_path(&rect.to_path(0.1));
        let frame = Preparation::new(4096).unwrap().prepare(&mut scene).unwrap();
        assert!(frame.alphas.data.iter().all(|alpha| *alpha == 0));
    }
}

#[test]
fn tiny_affine_off_axis_paths_keep_exact_coverage() {
    use vello_common::kurbo::Affine;
    let rect = Rect::new(30.0, 30.0, 830.0, 430.0);
    for transform in [
        Affine::rotate(0.0001),
        Affine::new([1.0, 0.0001, 0.0, 1.0, 0.0, 0.0]),
    ] {
        for clipping in [false, true] {
            let mut scene = Scene::new(1000, 700);
            scene.set_transform(transform);
            if clipping {
                scene.push_clip_path(&rect.to_path(0.1));
                scene.reset_transform();
                scene.fill_rect(&Rect::new(0.0, 0.0, 1000.0, 700.0));
            } else {
                scene.fill_path(&rect.to_path(0.1));
            }
            let frame = Preparation::new(4096).unwrap().prepare(&mut scene).unwrap();
            assert!(
                frame.alphas.data.len() > 16,
                "off-axis paths must not inherit the Rect API's approximate axis-alignment tolerance"
            );
        }
    }
}
