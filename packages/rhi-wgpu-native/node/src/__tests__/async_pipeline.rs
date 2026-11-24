use super::*;

fn owner() -> PipelineOwner {
    Arc::new(AtomicBool::new(true))
}
fn slot(owner: &PipelineOwner, value: u32) -> CompletionSlot<u32> {
    CompletionSlot {
        owner: owner.clone(),
        value: Mutex::new(Some(value)),
    }
}

#[test]
fn completion_is_owned_and_single_use() {
    let a = owner();
    let b = owner();
    let completion = slot(&a, 7);
    assert!(completion.take(&b).is_err());
    assert_eq!(completion.take(&a).ok(), Some(7));
    assert!(completion.take(&a).is_err());
}

#[test]
fn lost_or_destroyed_owner_cannot_publish_to_old_or_replacement_device() {
    let old = owner();
    let replacement = owner();
    let completion = slot(&old, 9);
    old.store(false, Ordering::Release);
    assert!(completion.take(&old).is_err());
    assert!(completion.take(&replacement).is_err());
}

#[test]
fn independent_completions_can_arrive_out_of_order() {
    let owner = owner();
    let first = slot(&owner, 11);
    let second = slot(&owner, 22);
    assert_eq!(second.take(&owner).ok(), Some(22));
    assert_eq!(first.take(&owner).ok(), Some(11));
}
