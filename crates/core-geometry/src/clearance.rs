//! Clearance queries: whether the things in a room actually fit around each other.
//!
//! Every footprint here is an oriented rectangle, because the document is prismatic —
//! so "does it fit" is a floor-plan question and the separating-axis test settles it
//! outright. Deliberately *not* `parry3d` (which `PLAN.md` names): a 3D collision stack
//! answers a question this document never asks, against a WASM budget that has to hold
//! the whole app. `parry2d` is the revisit if door-swing arcs ever want swept queries.

use core_scene::{Furnishing, FurnishingId, Scene};
use glam::Vec2;

/// Penetration shallower than this (metres) reads as two items placed flush rather than
/// as a collision. Without it a sofa seated against a side table warns on contact, and
/// wall-snapped placements — which seat items to an exact face offset — warn constantly.
const TOUCH_EPS: f32 = 1e-3;

/// The ground-plane rectangle a furnishing covers. `half.x` is half its width (the
/// asset's local `+X`), `half.y` half its depth (local `+Z`); the up axis plays no part
/// in a floor-plan question. `yaw` rotates the rectangle about the up axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Footprint {
    pub centre: Vec2,
    pub half: Vec2,
    pub yaw: f32,
}

impl Footprint {
    /// World directions of the rectangle's own two axes: local `+X` first, then local
    /// `+Z`. Same yaw-about-up convention `resolve_placement` emits, so a wall-snapped
    /// item's footprint lines up with the wall it was seated against.
    ///
    /// `pub(crate)` so [`crate::swing`] shares this one definition rather than
    /// re-deriving it. A yaw convention with two encodings is a bug waiting for someone
    /// to change one of them — and a wall footprint built on the wrong one is exactly
    /// what put walls in open floor during the door-swing work: every *negative*
    /// assertion still passed, because a misplaced wall obstructs nothing.
    pub(crate) fn axes(&self) -> (Vec2, Vec2) {
        let (sin, cos) = self.yaw.sin_cos();
        (Vec2::new(cos, -sin), Vec2::new(sin, cos))
    }

    /// How far the rectangle reaches from its centre along `axis`, which must be a unit
    /// vector. This is the projection radius the separating-axis test compares.
    fn reach(&self, axis: Vec2) -> f32 {
        let (u, v) = self.axes();
        self.half.x * u.dot(axis).abs() + self.half.y * v.dot(axis).abs()
    }
}

/// The floor rectangle a furnishing covers at its current scale and yaw.
pub fn footprint(furnishing: &Furnishing) -> Footprint {
    let size = furnishing.asset.extent * furnishing.scale;
    let position = furnishing.placement.position;
    Footprint {
        centre: Vec2::new(position.x, position.z),
        half: Vec2::new(size.x, size.z) * 0.5,
        yaw: furnishing.placement.yaw,
    }
}

/// Whether two footprints share floor.
///
/// Separating-axis test: two convex shapes miss each other exactly when some axis
/// separates their projections, and for a pair of rectangles only their own four edge
/// normals can be that axis. Find one and they are clear; find none and they overlap.
pub fn overlaps(a: &Footprint, b: &Footprint) -> bool {
    let (au, av) = a.axes();
    let (bu, bv) = b.axes();
    let between = b.centre - a.centre;
    !([au, av, bu, bv].into_iter()).any(|axis| {
        // Separated along this axis once the gap between the projections is positive,
        // give or take the flush-contact tolerance.
        between.dot(axis).abs() - (a.reach(axis) + b.reach(axis)) > -TOUCH_EPS
    })
}

/// Ids of the placed furnishings that overlap at least one other, in placement order.
///
/// Bullpen items are excluded — something set aside is not in the room to collide with.
/// Quadratic in the number of placed items, which is the right shape for a single room:
/// a few dozen pieces at most, and only recomputed when the document changes.
///
/// Deliberately unsorted. Placement order is already ascending by id (ids come from a
/// monotonic counter and furnishings are only ever pushed), and no caller depends on the
/// order anyway — the web layer reads the result straight into a set. Sorting it cost
/// 1.7 KB gzipped of pulled-in sort machinery to reorder an already-ordered list.
pub fn crowded(scene: &Scene) -> Vec<FurnishingId> {
    let placed: Vec<(FurnishingId, Footprint)> = scene
        .placed_furnishings()
        .map(|f| (f.id, footprint(f)))
        .collect();

    placed
        .iter()
        .enumerate()
        .filter(|(i, (_, shape))| {
            placed
                .iter()
                .enumerate()
                .any(|(j, (_, other))| j != *i && overlaps(shape, other))
        })
        .map(|(_, (id, _))| *id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_scene::{Anchor, Asset, Command, Placement};
    use glam::Vec3;

    /// Wider than it is deep, so a 90° turn changes which way it reaches — the whole
    /// point of testing an oriented box rather than an axis-aligned one.
    fn table_asset() -> Asset {
        Asset {
            extent: Vec3::new(1.6, 0.75, 0.8),
            asset_id: "round-table".into(),
        }
    }

    fn at(x: f32, z: f32, yaw: f32) -> Footprint {
        Footprint {
            centre: Vec2::new(x, z),
            half: Vec2::new(table_asset().extent.x, table_asset().extent.z) * 0.5,
            yaw,
        }
    }

    fn table(id: FurnishingId, x: f32, z: f32, yaw: f32) -> Furnishing {
        Furnishing {
            id,
            asset: table_asset(),
            placement: Placement {
                position: Vec3::new(x, 0.0, z),
                yaw,
                anchor: Anchor::Floor,
            },
            scale: Vec3::ONE,
            stashed: false,
        }
    }

    #[test]
    fn two_items_dropped_on_the_same_spot_overlap() {
        assert!(overlaps(&at(0.0, 0.0, 0.0), &at(0.0, 0.0, 0.0)));
    }

    #[test]
    fn items_across_the_room_are_clear() {
        assert!(!overlaps(&at(0.0, 0.0, 0.0), &at(4.0, 4.0, 0.0)));
    }

    #[test]
    fn rotating_an_item_can_push_it_into_a_neighbour_it_used_to_clear() {
        // 1.0 m apart along z: two 0.8 m-deep tables clear it with room to spare, but
        // turn one a quarter and it reaches 1.6 m across, so it runs into the other.
        let fixed = at(0.0, 0.0, 0.0);
        assert!(!overlaps(&fixed, &at(0.0, 1.0, 0.0)));
        assert!(overlaps(&fixed, &at(0.0, 1.0, std::f32::consts::FRAC_PI_2)));
    }

    #[test]
    fn items_placed_flush_against_each_other_do_not_count_as_overlapping() {
        // Exactly touching, back face to back face: contact is not a collision.
        assert!(!overlaps(&at(0.0, 0.0, 0.0), &at(0.0, 0.8, 0.0)));
    }

    #[test]
    fn a_rotated_neighbour_clears_on_its_own_axis() {
        // A diagonal near-miss, where the *only* axis that separates the pair is the
        // turned table's own. Test just the upright table's two axes and this reads as
        // a collision, so it pins down that both boxes contribute axes.
        let upright = at(0.0, 0.0, 0.0);
        let corner = std::f32::consts::FRAC_PI_4;
        assert!(overlaps(&upright, &at(1.0, 0.6, corner)));
        assert!(!overlaps(&upright, &at(1.1, 0.7, corner)));
    }

    fn room_with(furnishings: Vec<Furnishing>) -> Scene {
        let mut scene = Scene::default();
        for furnishing in furnishings {
            scene.apply(Command::AddFurnishing(furnishing));
        }
        scene
    }

    #[test]
    fn crowded_reports_both_halves_of_an_overlapping_pair_and_leaves_the_rest() {
        let scene = room_with(vec![
            table(1, 0.0, 0.0, 0.0),
            table(2, 0.2, 0.1, 0.0),
            table(3, 6.0, 6.0, 0.0),
        ]);
        assert_eq!(crowded(&scene), vec![1, 2]);
    }

    #[test]
    fn an_empty_room_is_not_crowded() {
        assert!(crowded(&Scene::default()).is_empty());
    }

    #[test]
    fn a_set_aside_item_cannot_crowd_the_room_it_left() {
        let mut scene = room_with(vec![table(1, 0.0, 0.0, 0.0), table(2, 0.2, 0.1, 0.0)]);
        assert_eq!(crowded(&scene), vec![1, 2]);

        scene.apply(Command::SetStashed {
            id: 2,
            stashed: true,
        });
        assert!(crowded(&scene).is_empty());
    }

    #[test]
    fn scaling_an_item_up_can_make_it_crowd_a_neighbour() {
        let mut scene = room_with(vec![table(1, 0.0, 0.0, 0.0), table(2, 0.0, 1.0, 0.0)]);
        assert!(crowded(&scene).is_empty());

        // Twice as deep reaches 0.8 m from its centre instead of 0.4 m, closing the gap.
        scene.apply(Command::SetScale {
            id: 1,
            scale: Vec3::new(1.0, 1.0, 2.0),
        });
        assert_eq!(crowded(&scene), vec![1, 2]);
    }
}
