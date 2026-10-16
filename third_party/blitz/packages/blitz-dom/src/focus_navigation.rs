use crate::BaseDocument;
use blitz_traits::node_id::NodeId;
use markup5ever::local_name;

/// The sequential navigation starting point survives blur and removal without
/// keeping the removed control focused or retaining a second copy of the tree.
#[derive(Clone, Copy)]
pub(crate) enum FocusNavigationStart {
    Node(NodeId),
    Boundary { parent: NodeId, offset: usize },
}

impl BaseDocument {
    /// Select only. Embedders dispatch change/blur before accepting this target,
    /// outside their native document borrow, and may redirect or cancel focus.
    pub fn sequential_focus_target(&self, reverse: bool) -> Option<NodeId> {
        fn visit(
            doc: &BaseDocument,
            id: NodeId,
            order: &mut Vec<NodeId>,
            boundary: &mut Option<usize>,
        ) {
            order.push(id);
            let node = &doc.nodes[id];
            if let Some(shadow) = node.shadow_root_id() {
                visit(doc, shadow, order, boundary);
            } else {
                for index in 0..=node.children.len() {
                    if matches!(doc.focus_navigation_start, Some(FocusNavigationStart::Boundary { parent, offset }) if parent == id && offset == index)
                    {
                        *boundary = Some(order.len());
                    }
                    if let Some(child) = node.children.get(index) {
                        visit(doc, *child, order, boundary);
                    }
                }
            }
        }
        let mut order = Vec::new();
        let mut boundary = None;
        visit(self, self.root_node_id, &mut order, &mut boundary);
        let start = self.focus_node_id.or(match self.focus_navigation_start {
            Some(FocusNavigationStart::Node(id)) => Some(id),
            _ => None,
        });
        let mut candidates: Vec<_> = order
            .iter()
            .copied()
            .enumerate()
            .filter_map(|(position, id)| {
                let node = &self.nodes[id];
                if !node.is_focussable() || !self.can_focus(id) {
                    return None;
                }
                let tabindex = node
                    .attr(local_name!("tabindex"))
                    .and_then(|value| value.parse::<i32>().ok())
                    .unwrap_or(0);
                Some((id, position, if tabindex > 0 { tabindex } else { i32::MAX }))
            })
            .collect();
        candidates.sort_by_key(|candidate| candidate.2);
        if candidates.is_empty() {
            return None;
        }
        if let Some(index) = candidates
            .iter()
            .position(|candidate| Some(candidate.0) == start)
        {
            let next = if reverse {
                (index + candidates.len() - 1) % candidates.len()
            } else {
                (index + 1) % candidates.len()
            };
            return Some(candidates[next].0);
        }
        if let Some(position) = start.and_then(|id| order.iter().position(|node| *node == id)) {
            boundary = Some(position + usize::from(!reverse));
        }
        if let Some(boundary) = boundary {
            let next = if reverse {
                candidates
                    .iter()
                    .filter(|candidate| candidate.1 < boundary)
                    .max_by_key(|candidate| candidate.1)
            } else {
                candidates
                    .iter()
                    .filter(|candidate| candidate.1 >= boundary)
                    .min_by_key(|candidate| candidate.1)
            };
            if let Some(next) = next {
                return Some(next.0);
            }
        }
        candidates
            .get(if reverse { candidates.len() - 1 } else { 0 })
            .map(|candidate| candidate.0)
    }

    pub fn focus_next_node(&mut self) -> Option<NodeId> {
        let id = self.sequential_focus_target(false)?;
        self.set_focus_to(id);
        Some(id)
    }

    pub fn focus_prev_node(&mut self) -> Option<NodeId> {
        let id = self.sequential_focus_target(true)?;
        self.set_focus_to(id);
        Some(id)
    }

    /// Range-like boundary adjustment runs before detachment, while the native
    /// parent/child relation still identifies the removed subtree's position.
    pub(crate) fn focus_navigation_removing(&mut self, removed: NodeId) {
        let Some(start) = self.focus_navigation_start else {
            return;
        };
        let Some(node) = self.get_node(removed) else {
            return;
        };
        let Some(parent) = node.parent.or(node.shadow_host_id()) else {
            return;
        };
        let offset = self.nodes[parent]
            .children
            .iter()
            .position(|id| *id == removed)
            .unwrap_or(0);
        let mut ancestor = Some(match start {
            FocusNavigationStart::Node(id) => id,
            FocusNavigationStart::Boundary { parent, .. } => parent,
        });
        while let Some(id) = ancestor {
            if id == removed {
                self.focus_navigation_start =
                    Some(FocusNavigationStart::Boundary { parent, offset });
                return;
            }
            ancestor = self
                .get_node(id)
                .and_then(|node| node.parent.or(node.shadow_host_id()));
        }
        if let Some(FocusNavigationStart::Boundary {
            parent: owner,
            offset: start,
        }) = &mut self.focus_navigation_start
        {
            if *owner == parent && *start > offset {
                *start -= 1;
            }
        }
    }

    pub(crate) fn focus_navigation_inserted(
        &mut self,
        parent: NodeId,
        offset: usize,
        count: usize,
    ) {
        if let Some(FocusNavigationStart::Boundary {
            parent: owner,
            offset: start,
        }) = &mut self.focus_navigation_start
        {
            if *owner == parent && *start > offset {
                *start += count;
            }
        }
    }
}
