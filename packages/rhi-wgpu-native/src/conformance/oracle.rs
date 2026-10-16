use glam::Vec3;

#[derive(Debug, Clone, Copy)]
pub struct Ray {
    pub origin: Vec3,
    pub direction: Vec3,
    pub t_min: f32,
    pub t_max: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct Triangle {
    pub vertices: [Vec3; 3],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TriangleHit {
    pub t: f32,
    pub barycentrics: [f32; 2],
    pub front_face: bool,
}

pub fn intersect_triangle(ray: Ray, triangle: Triangle) -> Option<TriangleHit> {
    let edge_a = triangle.vertices[1] - triangle.vertices[0];
    let edge_b = triangle.vertices[2] - triangle.vertices[0];
    let p = ray.direction.cross(edge_b);
    let determinant = edge_a.dot(p);
    if determinant.abs() <= f32::EPSILON {
        return None;
    }
    let inverse = determinant.recip();
    let distance = ray.origin - triangle.vertices[0];
    let u = distance.dot(p) * inverse;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = distance.cross(edge_a);
    let v = ray.direction.dot(q) * inverse;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = edge_b.dot(q) * inverse;
    if t < ray.t_min || t > ray.t_max {
        return None;
    }
    Some(TriangleHit {
        t,
        barycentrics: [u, v],
        front_face: determinant > 0.0,
    })
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn intersect_aabb(ray: Ray, minimum: Vec3, maximum: Vec3) -> Option<f32> {
    let mut near = ray.t_min;
    let mut far = ray.t_max;
    for axis in 0..3 {
        let origin = ray.origin[axis];
        let direction = ray.direction[axis];
        if direction.abs() <= f32::EPSILON {
            if origin < minimum[axis] || origin > maximum[axis] {
                return None;
            }
            continue;
        }
        let inverse = direction.recip();
        let mut first = (minimum[axis] - origin) * inverse;
        let mut second = (maximum[axis] - origin) * inverse;
        if first > second {
            std::mem::swap(&mut first, &mut second);
        }
        near = near.max(first);
        far = far.min(second);
        if near > far {
            return None;
        }
    }
    Some(near)
}

pub fn approximately_equal(actual: f32, expected: f32) -> bool {
    let difference = (actual - expected).abs();
    difference <= 1.0e-4 || difference <= 1.0e-4 * expected.abs().max(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn triangle() -> Triangle {
        Triangle {
            vertices: [
                Vec3::new(-1.0, -1.0, 0.0),
                Vec3::new(1.0, -1.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
        }
    }

    #[test]
    fn triangle_oracle_returns_t_and_barycentrics() {
        let hit = intersect_triangle(
            Ray {
                origin: Vec3::new(0.0, 0.0, 2.0),
                direction: Vec3::NEG_Z,
                t_min: 0.01,
                t_max: 10.0,
            },
            triangle(),
        )
        .unwrap();
        assert!(approximately_equal(hit.t, 2.0));
        assert!(approximately_equal(hit.barycentrics[0], 0.25));
        assert!(approximately_equal(hit.barycentrics[1], 0.5));
    }

    #[test]
    fn triangle_oracle_rejects_miss_and_range() {
        let miss = Ray {
            origin: Vec3::new(3.0, 0.0, 2.0),
            direction: Vec3::NEG_Z,
            t_min: 0.01,
            t_max: 10.0,
        };
        assert!(intersect_triangle(miss, triangle()).is_none());
        assert!(intersect_triangle(Ray { t_max: 1.0, ..miss }, triangle()).is_none());
    }

    #[test]
    fn aabb_oracle_handles_hit_and_parallel_miss() {
        let minimum = Vec3::splat(-1.0);
        let maximum = Vec3::splat(1.0);
        let hit = intersect_aabb(
            Ray {
                origin: Vec3::new(0.0, 0.0, 3.0),
                direction: Vec3::NEG_Z,
                t_min: 0.0,
                t_max: 10.0,
            },
            minimum,
            maximum,
        )
        .unwrap();
        assert!(approximately_equal(hit, 2.0));
        assert!(intersect_aabb(
            Ray {
                origin: Vec3::new(2.0, 0.0, 3.0),
                direction: Vec3::NEG_Z,
                t_min: 0.0,
                t_max: 10.0,
            },
            minimum,
            maximum,
        )
        .is_none());
    }
}
