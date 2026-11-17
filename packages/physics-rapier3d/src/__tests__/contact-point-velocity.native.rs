use rapier3d::prelude::*;

#[test]
fn unchanged_rotated_com_pose_has_exactly_zero_interpolated_velocity() {
    use rapier3d::dynamics::RigidBodyPosition;
    let local_com = Vector::new(0.0, -0.22, 0.12);
    for i in 1..32 {
        let pose = Pose::new(Vector::new(7.0, -2.0, 11.0), Vector::new(0.0, i as f32 * 0.1, 0.0));
        let state = RigidBodyPosition { position: pose, next_position: pose };
        let velocity = state.interpolate_velocity(60.0, local_com);
        assert_eq!(velocity.linvel, Vector::ZERO, "unchanged pose at angle {}", i);
        assert_eq!(velocity.angvel, Vector::ZERO);
    }
}

#[test]
fn translated_rotated_com_pose_retains_kinematic_velocity() {
    use rapier3d::dynamics::RigidBodyPosition;
    let pose = Pose::new(Vector::ZERO, Vector::new(0.0, 1.2, 0.0));
    let mut next = pose;
    next.translation += Vector::new(0.125, 0.0, -0.25);
    let state = RigidBodyPosition { position: pose, next_position: next };
    let velocity = state.interpolate_velocity(60.0, Vector::new(0.0, -0.22, 0.12));
    assert!((velocity.linvel - Vector::new(7.5, 0.0, -15.0)).length() < 1.0e-4);
}

#[test]
fn impact_retains_incoming_point_velocity_after_solver_response() {
    let mut world = PhysicsWorld::default();
    world.gravity = Vector::ZERO;
    let (actor, actor_shape) = world.insert(
        RigidBodyBuilder::dynamic().translation(Vector::new(-0.51, 0.0, 0.0))
            .linvel(Vector::new(12.0, 0.0, 0.0)),
        ColliderBuilder::cuboid(0.25, 0.25, 0.25).friction(0.0),
    );
    let (_, wall_shape) = world.insert(
        RigidBodyBuilder::fixed(),
        ColliderBuilder::cuboid(0.25, 2.0, 2.0).friction(0.0),
    );
    world.step();
    let pair = world.narrow_phase.contact_pair(actor_shape, wall_shape).unwrap();
    let mut count = 0;
    for manifold in pair.solver_manifolds() {
        for contact in &manifold.data.solver_contacts {
            let point = &manifold.points[contact.contact_indices()[0] as usize];
            let [first, second] = point.data.pre_solve_velocities.unwrap();
            let incoming = if manifold.data.rigid_body1 == Some(actor) { first } else { second };
            let fixed = if manifold.data.rigid_body1 == Some(actor) { second } else { first };
            assert!((incoming.x - 12.0).abs() < 1.0e-5);
            assert_eq!(fixed, Vector::ZERO);
            count += 1;
        }
    }
    assert!(count > 0, "the impact must submit actual solver contacts");
    assert!(world.bodies[actor].linvel().x < 2.0, "the solver must already change velocity");
}

#[test]
fn recycled_contacts_refresh_both_velocities_and_retire_sleeping_observations() {
    let mut world = PhysicsWorld::default();
    world.gravity = Vector::ZERO;
    let (actor, actor_shape) = world.insert(
        RigidBodyBuilder::dynamic().translation(Vector::new(-0.499, 0.0, 0.0)),
        ColliderBuilder::cuboid(0.25, 0.25, 0.25).friction(0.0),
    );
    let (support, support_shape) = world.insert(
        RigidBodyBuilder::kinematic_velocity_based().linvel(Vector::new(0.0, 0.0, 1.0)),
        ColliderBuilder::cuboid(0.25, 2.0, 2.0).friction(0.0),
    );
    for speed in [2.0, 3.0, 4.0] {
        world.bodies[actor].set_linvel(Vector::new(0.0, speed, 0.0), true);
        world.bodies[actor].set_angvel(Vector::new(0.0, 2.0, 0.0), true);
        let before = world.bodies.clone();
        world.step();
        let pair = world.narrow_phase.contact_pair(actor_shape, support_shape).unwrap();
        let mut count = 0;
        for manifold in pair.solver_manifolds() {
            for contact in &manifold.data.solver_contacts {
                let (p1, p2) = manifold.data.solver_contact_world_points(contact, &before);
                let expected = [
                    manifold.data.rigid_body1.map_or(Vector::ZERO, |h| before[h].velocity_at_point(p1)),
                    manifold.data.rigid_body2.map_or(Vector::ZERO, |h| before[h].velocity_at_point(p2)),
                ];
                let point = &manifold.points[contact.contact_indices()[0] as usize];
                let actual = point.data.pre_solve_velocities.unwrap();
                for side in 0..2 {
                    assert!((actual[side] - expected[side]).length() < 1.0e-4);
                }
                count += 1;
            }
        }
        assert!(count > 0);
    }
    world.bodies[support].set_body_type(RigidBodyType::Fixed, true);
    world.step();
    world.bodies[actor].sleep();
    world.step();
    assert!(world.bodies[actor].is_sleeping());
    if let Some(pair) = world.narrow_phase.contact_pair(actor_shape, support_shape) {
        for manifold in pair.solver_manifolds() {
            assert!(manifold.points.iter().all(|p| p.data.pre_solve_velocities.is_none()));
        }
    }
}

#[test]
fn position_driven_kinematic_velocity_is_sampled_after_interpolation() {
    let mut world = PhysicsWorld::default();
    world.gravity = Vector::ZERO;
    let (_, actor_shape) = world.insert(
        RigidBodyBuilder::dynamic().translation(Vector::new(-0.499, 0.0, 0.0)),
        ColliderBuilder::cuboid(0.25, 0.25, 0.25).friction(0.0),
    );
    let (support, support_shape) = world.insert(
        RigidBodyBuilder::kinematic_position_based(),
        ColliderBuilder::cuboid(0.25, 2.0, 2.0).friction(0.0),
    );
    world.bodies[support].set_next_kinematic_translation(Vector::new(0.0, 0.05, 0.0));
    world.step();
    let pair = world.narrow_phase.contact_pair(actor_shape, support_shape).unwrap();
    let mut count = 0;
    for manifold in pair.solver_manifolds() {
        for contact in &manifold.data.solver_contacts {
            let point = &manifold.points[contact.contact_indices()[0] as usize];
            let velocities = point.data.pre_solve_velocities.unwrap();
            let side = usize::from(manifold.data.rigid_body1 != Some(support));
            assert!((velocities[side].y - 3.0).abs() < 1.0e-5);
            count += 1;
        }
    }
    assert!(count > 0);
}
