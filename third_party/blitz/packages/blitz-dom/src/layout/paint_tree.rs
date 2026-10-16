//! Construction of the paint tree (`Node::paint_children` and
//! `Node::stacking_context`) from the laid-out box tree.
//!
//! The pass runs once per frame after layout and builds *topology* only: which
//! node ids each node paints itself and which z-indexed descendants are hoisted
//! to the nearest stacking-context root. Geometry (a hoisted box's offset from
//! its stacking-context root) is derived at use time from `final_layout()` and
//! memoised per geometry generation, so replaying a cached list for a clean
//! subtree can never paint or hit-test a box where layout no longer puts it.

use blitz_traits::node_id::NodeId;
use std::cell::Cell;
use std::ops::Range;
use thin_vec::ThinVec;

use crate::layout::damage::ALL_DAMAGE;
use crate::tree::NodeTree;
use crate::{BaseDocument, Node};
use style::properties::generated::longhands::position::computed_value::T as Position;
use style::selector_parser::RestyleDamage;
use style::values::computed::Float;
use style::values::specified::box_::DisplayInside;
use taffy::Point;

/// Offset of the hoisted child `child_id` from the border box of its
/// stacking-context root `sc_root_id`, excluding the child's own
/// `final_layout().location`. The positioning and stacking chains can diverge:
/// a viewport-fixed box still belongs to its ancestor stacking context.
///
/// Uses `Node::containing_block` (the out-of-flow containing block for boxes
/// hoisted by Taffy, otherwise `layout_parent`, which is set for every layout
/// child by `resolve_layout_children`, anonymous blocks included).
pub fn hoisted_child_position(tree: &NodeTree, sc_root_id: NodeId, child_id: NodeId) -> Point<f32> {
    let child = &tree[child_id];
    let Some(cb) = child.containing_block().and_then(|id| tree.get(id)) else {
        return Point::ZERO;
    };
    let cb_origin = cb.absolute_position(0.0, 0.0);
    let sc_origin = tree[sc_root_id].absolute_position(0.0, 0.0);
    let mut position = Point {
        x: cb_origin.x - sc_origin.x,
        y: cb_origin.y - sc_origin.y,
    };

    // A fixed-position box whose containing block is the root element is
    // positioned against the viewport and does not scroll with it: cancel the
    // scroll the containing block (or the stacking-context root) applies.
    // A fixed box contained by a transformed ancestor scrolls with it.
    if child.is_viewport_fixed() {
        let scroll_offset = *cb.scroll_offset();
        let viewport_scroll = tree.viewport_scroll();
        position.x += scroll_offset.x as f32 + viewport_scroll.x as f32;
        position.y += scroll_offset.y as f32 + viewport_scroll.y as f32;
    }

    position
}

/// A child with a z_index that is hoisted up to it's containing Stacking Context for paint purposes
#[derive(Debug, Clone)]
pub struct HoistedPaintChild {
    pub node_id: NodeId,
    pub z_index: i32,
    /// `(geometry generation, offset from the stacking-context root)`, see
    /// [`Self::position`]. Generation `0` is never current.
    position: Cell<(u64, Point<f32>)>,
}

impl HoistedPaintChild {
    fn new(node_id: NodeId, z_index: i32) -> Self {
        Self {
            node_id,
            z_index,
            position: Cell::new((0, Point::ZERO)),
        }
    }

    /// The child's offset from the border box of its stacking-context root
    /// (`sc_root_id`), excluding the child's own `final_layout().location`.
    /// Computed at most once per geometry generation.
    pub fn position(&self, tree: &NodeTree, sc_root_id: NodeId) -> Point<f32> {
        let generation = tree.geometry_generation();
        let (stamp, cached) = self.position.get();
        if stamp == generation {
            return cached;
        }
        let position = hoisted_child_position(tree, sc_root_id, self.node_id);
        self.position.set((generation, position));
        position
    }

    /// Whether [`Self::position`] is memoised for the current geometry generation.
    pub fn position_is_cached(&self, tree: &NodeTree) -> bool {
        self.position.get().0 == tree.geometry_generation()
    }
}

#[derive(Debug)]
pub struct StackingContext {
    pub children: ThinVec<HoistedPaintChild>,
    /// The number of hoisted point children with negative z_index
    pub negative_z_count: u32,
}

impl StackingContext {
    /// Build a sorted stacking context from the hoisted entries collected for it.
    fn from_children(children: ThinVec<HoistedPaintChild>) -> Self {
        let mut sc = Self {
            children,
            negative_z_count: 0,
        };
        sc.sort();
        sc
    }

    pub fn sort(&mut self) {
        self.children.sort_by_key(|c| c.z_index);
        self.negative_z_count = self.children.iter().take_while(|c| c.z_index < 0).count() as u32;
    }

    pub fn neg_z_range(&self) -> Range<usize> {
        0..(self.negative_z_count as usize)
    }

    pub fn pos_z_range(&self) -> Range<usize> {
        (self.negative_z_count as usize)..self.children.len()
    }

    pub fn neg_z_hoisted_children(
        &self,
    ) -> impl ExactSizeIterator<Item = &HoistedPaintChild> + DoubleEndedIterator {
        self.children[self.neg_z_range()].iter()
    }

    pub fn pos_z_hoisted_children(
        &self,
    ) -> impl ExactSizeIterator<Item = &HoistedPaintChild> + DoubleEndedIterator {
        self.children[self.pos_z_range()].iter()
    }
}

impl Node {
    /// Conservative device-pixel bounds in this node's border-box coordinates.
    /// Paint and hit culling follow the paint tree, while CSS scroll extents
    /// retain layout ownership. A fixed descendant can remain visible when its
    /// stacking ancestor has scrolled outside the viewport.
    pub fn paint_bounds(&self, scale: f64) -> kurbo::Rect {
        let generation = self.tree().geometry_generation();
        let (stamp, cached) = self.paint_bounds.get();
        if stamp == generation {
            return cached;
        }
        let mut bounds = *self.scrollable_overflow();
        let scroll = *self.scroll_offset();
        let mut include = |id, position: Point<f32>| {
            let child = &self.tree()[id];
            if child.taffy_display() == taffy::Display::None {
                return;
            }
            let location = child.final_layout().location;
            let transform = kurbo::Affine::translate((
                (position.x as f64 + location.x as f64 - scroll.x) * scale,
                (position.y as f64 + location.y as f64 - scroll.y) * scale,
            )) * child.transform().as_deref().copied().unwrap_or_default();
            bounds = bounds.union(transform.transform_rect_bbox(child.paint_bounds(scale)));
        };
        for &id in self.paint_children.borrow().iter().flatten() {
            let child = &self.tree()[id];
            let position = if child.taffy_position().is_out_of_flow() {
                hoisted_child_position(self.tree(), self.id, id)
            } else {
                Point::ZERO
            };
            include(id, position);
        }
        if let Some(sc) = &self.stacking_context {
            for child in &sc.children {
                include(child.node_id, child.position(self.tree(), self.id));
            }
        }
        self.paint_bounds.set((generation, bounds));
        bounds
    }
}

impl BaseDocument {
    /// Rebuild `paint_children` and `stacking_context` for the tree rooted at
    /// `root_id` from the laid-out box tree.
    ///
    /// Each node's layout children are placed either in its `paint_children`
    /// (sorted by paint order) or, when they have a non-zero `z-index` and are
    /// positioned or flex/grid items, in the nearest ancestor stacking context.
    ///
    /// Subtrees whose stored damage lacks `REBUILD_STACKING_CONTEXT` are skipped: their
    /// own lists are still valid and the entries they contributed to the
    /// enclosing stacking context are replayed from `Node::sc_contribution_cache`.
    pub(crate) fn build_paint_tree(&mut self, root_id: NodeId) {
        self.build_paint_tree_impl(root_id, None);
    }

    /// `stacking_context` is the entry list of the nearest ancestor stacking
    /// context, or `None` when `node_id` is itself a stacking-context root.
    fn build_paint_tree_impl(
        &mut self,
        node_id: NodeId,
        stacking_context: Option<&mut ThinVec<HoistedPaintChild>>,
    ) {
        {
            let node = &self.nodes[node_id];
            // `propagate_damage_flags` stores the union of a node's own and
            // its descendants' damage on the node, so the absence of
            // `REBUILD_STACKING_CONTEXT` (which every heavier level implies)
            // means nothing in the subtree can have changed a paint list.
            // Anonymous boxes are never skipped: damage marking walks the DOM
            // parent chain, which bypasses them.
            //
            // Whether a node is a stacking-context root also depends on its
            // parent (z-indexed flex/grid items), which does not damage the
            // node itself, so the role the caller resolved must match the one
            // this node was last built with.
            let role_unchanged = node.stacking_context.is_some() == stacking_context.is_none();
            let clean = role_unchanged
                && !node
                    .damage()
                    .unwrap_or(ALL_DAMAGE)
                    .contains(RestyleDamage::REBUILD_STACKING_CONTEXT)
                && !node.is_anonymous();
            if clean {
                if let Some(stacking_context) = stacking_context {
                    stacking_context.extend(node.sc_contribution_cache.borrow().iter().cloned());
                }
                return;
            }
        }

        let Some(display) = self.nodes[node_id].display_style() else {
            return;
        };

        // Entries hoisted out of this subtree are collected directly into the
        // storage that will hold them afterwards: the node's own stacking
        // context for a root, otherwise its contribution cache (from which
        // they are copied into the enclosing stacking context below).
        let mut entries = {
            let node = &mut self.nodes[node_id];
            let mut entries = match stacking_context {
                None => node
                    .stacking_context
                    .take()
                    .map(|sc| sc.children)
                    .unwrap_or_default(),
                Some(_) => std::mem::take(&mut *node.sc_contribution_cache.borrow_mut()),
            };
            entries.clear();
            entries
        };

        let children = self.nodes[node_id].layout_children.borrow_mut().take();
        if let Some(children) = children {
            let is_flex_or_grid =
                matches!(display.inside(), DisplayInside::Flex | DisplayInside::Grid);

            // Out-of-flow layout belongs to the containing block, but paint
            // cannot cross an intervening stacking context. Derive that owner
            // from the existing layout ancestry, without changing positioning.
            let owned_here = |doc: &Self, child_id: NodeId| -> bool {
                doc.paint_parent(child_id)
                    .is_none_or(|parent| parent == node_id)
            };
            // Boxes painted by this node from further down the tree, keyed by
            // the index of the layout child they descend from: they are visited
            // and listed in tree order, directly after that child (CSS 2.1
            // Appendix E). Boxes whose layout-parent chain does not lead through
            // a layout child of this node come after all of them.
            let mut hoisted = self.nodes[node_id].hoisted_children.borrow().to_vec();
            if stacking_context.is_none() {
                let mut ancestor = self.nodes[node_id].containing_block();
                while let Some(id) = ancestor {
                    hoisted.extend(
                        self.nodes[id]
                            .hoisted_children
                            .borrow()
                            .iter()
                            .copied()
                            .filter(|&child| self.paint_parent(child) == Some(node_id)),
                    );
                    ancestor = self.nodes[id].containing_block();
                }
            }
            let mut hoisted_past_parent: Vec<(usize, NodeId)> = hoisted
                .into_iter()
                .filter(|&id| {
                    self.nodes
                        .get(id)
                        .is_some_and(|n| n.layout_parent.get() != Some(node_id))
                        && owned_here(self, id)
                })
                .map(|id| {
                    let anchor = self
                        .layout_child_containing(node_id, id)
                        .and_then(|anchor| children.iter().position(|&c| c == anchor))
                        .unwrap_or(children.len());
                    (anchor, id)
                })
                .collect();
            hoisted_past_parent.sort_by_key(|&(anchor, _)| anchor);
            let mut next_hoisted = 0;

            let mut paint_children = self.nodes[node_id]
                .paint_children
                .borrow_mut()
                .take()
                .unwrap_or_default();
            paint_children.clear();
            paint_children.reserve(children.len() + hoisted_past_parent.len());

            for (index, &child_id) in children.iter().enumerate() {
                if owned_here(self, child_id) {
                    let is_sc_root = self.nodes[child_id].is_stacking_context_root(is_flex_or_grid);
                    self.build_paint_tree_impl(
                        child_id,
                        match is_sc_root {
                            true => None,
                            false => Some(&mut entries),
                        },
                    );

                    // Only stacking contexts with a non-zero z-index are lifted
                    // out of tree order into the enclosing stacking context's
                    // z-sorted list (CSS 2.1 Appendix E).
                    let z_index = self.nodes[child_id].z_index();
                    if is_sc_root && z_index != 0 {
                        entries.push(HoistedPaintChild::new(child_id, z_index))
                    } else {
                        paint_children.push(child_id);
                    }
                }

                while let Some(&(anchor, hoisted_id)) = hoisted_past_parent.get(next_hoisted)
                    && anchor == index
                {
                    self.attach_hoisted_past_parent(hoisted_id, &mut paint_children, &mut entries);
                    next_hoisted += 1;
                }
            }
            for &(_, hoisted_id) in &hoisted_past_parent[next_hoisted..] {
                self.attach_hoisted_past_parent(hoisted_id, &mut paint_children, &mut entries);
            }

            paint_children
                .sort_by_cached_key(|id| node_to_paint_order(&self.nodes[*id], is_flex_or_grid));

            let node = &self.nodes[node_id];
            *node.paint_children.borrow_mut() = Some(paint_children);
            *node.layout_children.borrow_mut() = Some(children);
        }

        let node = &mut self.nodes[node_id];
        if let Some(stacking_context) = stacking_context {
            node.stacking_context = None;
            stacking_context.extend(entries.iter().cloned());
            *node.sc_contribution_cache.borrow_mut() = entries;
        } else {
            node.sc_contribution_cache.borrow_mut().clear();
            node.stacking_context = Some(Box::new(StackingContext::from_children(entries)));
        }
    }

    /// An out-of-flow box may leave its layout parent for positioning, but
    /// never its nearest ancestor stacking context for paint or hit testing.
    fn paint_parent(&self, child_id: NodeId) -> Option<NodeId> {
        let child = &self.nodes[child_id];
        let cb = child.containing_block()?;
        let mut ancestor = child.layout_parent.get();
        while let Some(id) = ancestor {
            if id == cb {
                return Some(cb);
            }
            let node = &self.nodes[id];
            let parent_is_flex_or_grid = node
                .layout_parent
                .get()
                .and_then(|parent| self.nodes[parent].display_style())
                .is_some_and(|display| {
                    matches!(display.inside(), DisplayInside::Flex | DisplayInside::Grid)
                });
            if node.is_stacking_context_root(parent_is_flex_or_grid) {
                return Some(id);
            }
            ancestor = node.layout_parent.get();
        }
        Some(cb)
    }

    /// The layout child of `node_id` whose subtree contains `id`, following
    /// `layout_parent`.
    fn layout_child_containing(&self, node_id: NodeId, id: NodeId) -> Option<NodeId> {
        let mut current = id;
        loop {
            let parent = self.nodes.get(current)?.layout_parent.get()?;
            if parent == node_id {
                return Some(current);
            }
            current = parent;
        }
    }

    /// Visit an out-of-flow box hoisted to its containing block past its
    /// layout parent and place it in the paint lists: z-indexed boxes go to
    /// the enclosing stacking context like any other z-indexed positioned
    /// child, the rest join `paint_children` at the same paint level as other
    /// positioned boxes (the caller's stable sort keeps tree order).
    fn attach_hoisted_past_parent(
        &mut self,
        child_id: NodeId,
        paint_children: &mut ThinVec<NodeId>,
        entries: &mut ThinVec<HoistedPaintChild>,
    ) {
        self.build_paint_tree_impl(
            child_id,
            match self.nodes[child_id].is_stacking_context_root(false) {
                true => None,
                false => Some(entries),
            },
        );

        let z_index = self.nodes[child_id].z_index();
        if z_index != 0 {
            entries.push(HoistedPaintChild::new(child_id, z_index));
        } else {
            paint_children.push(child_id);
        }
    }
}

#[inline(always)]
fn position_to_order(pos: Position) -> i32 {
    match pos {
        Position::Static => 0,
        // All positioned descendants with z-index: auto share one paint
        // level (CSS 2.1 Appendix E step 8); the stable sort keeps them in
        // tree order among themselves, above in-flow content and floats.
        Position::Relative | Position::Sticky | Position::Absolute | Position::Fixed => 2,
    }
}
#[inline(always)]
fn float_to_order(pos: Float) -> i32 {
    match pos {
        Float::None => 0,
        _ => 1,
    }
}

/// Paint sort key: (paint level, order-modified position). Positioned
/// (z-index: auto) descendants paint above in-flow content (CSS 2.1
/// Appendix E step 8); within a level the stable sort preserves
/// (order-modified) document order.
#[inline(always)]
fn node_to_paint_order(node: &Node, is_flex_or_grid: bool) -> (i32, i32) {
    let Some(style) = node.primary_styles() else {
        return (0, 0);
    };
    let position = style.clone_position();
    if is_flex_or_grid {
        match position {
            Position::Static => (0, style.clone_order()),
            Position::Relative | Position::Sticky => (2, style.clone_order()),
            // Out-of-flow children are not flex/grid items: `order` does
            // not apply; tree order does.
            Position::Absolute | Position::Fixed => (2, 0),
        }
    } else {
        (
            position_to_order(position) + float_to_order(style.clone_float()),
            0,
        )
    }
}
