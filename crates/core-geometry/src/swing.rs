//! Door-swing arcs: whether a door has room to open.
//!
//! A hinged leaf sweeps a quarter-circle sector — centred on the hinge, radius the
//! door's own width — and anything standing in that sector stops the door. This module
//! answers which doors are blocked, in the same shape as [`crate::clearance::crowded`]
//! and [`crate::rooms`]: a derived query over the document, computed on demand and
//! stored nowhere.
//!
//! **The document does not record which way a door hangs.** [`Opening`] has a width, a
//! position along its wall, and nothing about handedness or swing direction. Rather than
//! invent a field and guess a default, this asks the question the missing data still
//! permits: *is there any way to hang this door that leaves it room to open?* A door with
//! all four options blocked is unambiguously a problem; one with a clear option is a
//! choice nobody has made yet. [`swing_options`] exposes the four so a caller can offer
//! them once the document learns to store the answer.

use crate::clearance::{Footprint, footprint};
use core_scene::{Opening, OpeningId, OpeningKind, Scene, Wall};
use glam::Vec2;

/// Contact shallower than this (metres) reads as the leaf brushing past rather than
/// striking. Matches the tolerance clearance uses, for the same reason: wall-snapped
/// furniture sits at an exact face offset and would otherwise block every door it
/// stands beside.
const TOUCH_EPS: f32 = 1e-3;

/// One way a door could be hung: which jamb carries the hinge, and which side of the
/// wall the leaf opens onto.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hanging {
    /// `true` hinges at the jamb nearer the wall's start, `false` at the far jamb.
    pub hinge_at_start: bool,
    /// `true` swings toward the wall's `normal()` side, `false` the other way.
    pub opens_along_normal: bool,
}

/// Every way a door can be hung, in a stable order so a caller can index them.
pub const HANGINGS: [Hanging; 4] = [
    Hanging {
        hinge_at_start: true,
        opens_along_normal: true,
    },
    Hanging {
        hinge_at_start: true,
        opens_along_normal: false,
    },
    Hanging {
        hinge_at_start: false,
        opens_along_normal: true,
    },
    Hanging {
        hinge_at_start: false,
        opens_along_normal: false,
    },
];

/// The quarter-circle a door leaf sweeps: hinged at `pivot`, `radius` long, turning from
/// the closed position (flat against the wall) to fully open (square to it).
///
/// Stored as two unit vectors rather than angles. The sector spans the shorter way round
/// from `closed` to `open`, which is unambiguous precisely because the turn is 90° — an
/// angle pair would need a winding convention and a wrap-around case, and both are the
/// kind of thing that works until a door faces the other way.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sector {
    pub pivot: Vec2,
    pub radius: f32,
    /// Direction from the pivot to the free edge with the door shut.
    pub closed: Vec2,
    /// Direction from the pivot to the free edge with the door fully open.
    pub open: Vec2,
}

impl Sector {
    /// Whether `p` lies inside the swept quarter-circle.
    fn contains(&self, p: Vec2) -> bool {
        let rel = p - self.pivot;
        let dist = rel.length();
        if dist > self.radius + TOUCH_EPS {
            return false;
        }
        if dist <= TOUCH_EPS {
            return true; // at the pivot, which every position of the leaf touches
        }
        // Inside a 90° sector exactly when the point is on the inner side of both
        // bounding radii. `perp_dot` gives the turn direction from one to the other, and
        // the point has to turn the same way from `closed` as `open` does.
        let winding = self.closed.perp_dot(self.open);
        let from_closed = self.closed.perp_dot(rel);
        let from_open = rel.perp_dot(self.open);
        from_closed * winding >= -TOUCH_EPS && from_open * winding >= -TOUCH_EPS
    }

    /// The far end of the leaf when shut, and when fully open.
    fn tips(&self) -> (Vec2, Vec2) {
        (
            self.pivot + self.closed * self.radius,
            self.pivot + self.open * self.radius,
        )
    }
}

/// Whether two segments cross.
fn segments_cross(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2) -> bool {
    let d1 = a1 - a0;
    let d2 = b1 - b0;
    let denom = d1.perp_dot(d2);
    if denom.abs() < f32::EPSILON {
        return false; // parallel; a collinear overlap is caught by the corner tests
    }
    let between = b0 - a0;
    let t = between.perp_dot(d2) / denom;
    let u = between.perp_dot(d1) / denom;
    (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u)
}

/// Whether a segment reaches the arc itself — the curved edge, not the straight radii.
fn segment_crosses_arc(sector: &Sector, p0: Vec2, p1: Vec2) -> bool {
    // Closest approach of the segment to the pivot, and the far end: the segment can
    // only touch the arc if it straddles the radius.
    let d = p1 - p0;
    let len_sq = d.length_squared();
    if len_sq < f32::EPSILON {
        return false;
    }
    let t = ((sector.pivot - p0).dot(d) / len_sq).clamp(0.0, 1.0);
    let nearest = p0 + d * t;
    let near = nearest.distance(sector.pivot);
    let far = p0.distance(sector.pivot).max(p1.distance(sector.pivot));
    if near > sector.radius || far < sector.radius {
        return false; // wholly outside or wholly inside the circle
    }
    // It crosses the circle somewhere. Sample the crossing region rather than solving
    // the quadratic: the two candidate points are where the segment meets the circle,
    // and testing whether either lies in the angular span is what actually matters.
    let half_chord = (sector.radius * sector.radius - near * near)
        .max(0.0)
        .sqrt();
    let dir = d / len_sq.sqrt();
    [nearest - dir * half_chord, nearest + dir * half_chord]
        .into_iter()
        .filter(|hit| {
            // Keep only crossings that lie on the segment, not on its infinite line.
            let along = (*hit - p0).dot(dir);
            (-TOUCH_EPS..=len_sq.sqrt() + TOUCH_EPS).contains(&along)
        })
        .any(|hit| sector.contains(hit))
}

/// Whether a swept door leaf meets a floor rectangle.
///
/// Sector against oriented box, done as four exhaustive cases rather than approximated
/// by sampling leaf positions: a sampled sweep misses a thin obstacle between samples
/// and reports a clear door, which is the failure mode that reads as working.
pub fn sector_hits(sector: &Sector, rect: &Footprint) -> bool {
    let corners = rect_corners(rect);
    // 1. A corner standing inside the swept quarter.
    if corners.iter().any(|c| sector.contains(*c)) {
        return true;
    }
    // 2. The hinge standing inside the obstacle.
    if rect_contains(rect, sector.pivot) {
        return true;
    }
    let (closed_tip, open_tip) = sector.tips();
    for i in 0..4 {
        let (e0, e1) = (corners[i], corners[(i + 1) % 4]);
        // 3. An edge cut by the leaf at either end of its travel.
        if segments_cross(sector.pivot, closed_tip, e0, e1)
            || segments_cross(sector.pivot, open_tip, e0, e1)
        {
            return true;
        }
        // 4. An edge cut by the arc the free end traces.
        if segment_crosses_arc(sector, e0, e1) {
            return true;
        }
    }
    false
}

fn rect_corners(rect: &Footprint) -> [Vec2; 4] {
    let (sin, cos) = rect.yaw.sin_cos();
    let u = Vec2::new(cos, -sin) * rect.half.x;
    let v = Vec2::new(sin, cos) * rect.half.y;
    [
        rect.centre - u - v,
        rect.centre + u - v,
        rect.centre + u + v,
        rect.centre - u + v,
    ]
}

fn rect_contains(rect: &Footprint, p: Vec2) -> bool {
    let (sin, cos) = rect.yaw.sin_cos();
    let rel = p - rect.centre;
    let along = rel.dot(Vec2::new(cos, -sin)).abs();
    let across = rel.dot(Vec2::new(sin, cos)).abs();
    along <= rect.half.x + TOUCH_EPS && across <= rect.half.y + TOUCH_EPS
}

/// The floor rectangle a wall covers, so a wall can be tested like any other obstacle.
///
/// The yaw is `atan2(-d.y, d.x)`, not `atan2(d.x, d.y)`. [`Footprint::axes`] builds its
/// local `+X` as `(cos, -sin)`, so recovering the wall's own direction means inverting
/// *that* — and getting it wrong rotates every wall rectangle a quarter turn, which
/// leaves walls in open floor and doors clear of returns they plainly foul.
fn wall_footprint(wall: &Wall) -> Footprint {
    let d = wall.direction();
    Footprint {
        centre: (wall.start + wall.end) * 0.5,
        half: Vec2::new(wall.length() * 0.5, wall.thickness * 0.5),
        yaw: (-d.y).atan2(d.x),
    }
}

/// The quarter-circle a door would sweep, hung the given way.
///
/// The pivot sits at a jamb — the edge of the opening, not its centre — because that is
/// where a hinge goes, and putting it at the centre would understate the reach by half
/// the door's width on one side and overstate it on the other.
pub fn sector_for(opening: &Opening, wall: &Wall, hanging: Hanging) -> Sector {
    let (near, far) = opening.span();
    let along = if hanging.hinge_at_start { near } else { far };
    let direction = wall.direction();
    // Closed: the leaf lies in the wall, reaching from its hinge toward the other jamb.
    let closed = if hanging.hinge_at_start {
        direction
    } else {
        -direction
    };
    let normal = wall.normal();
    let open = if hanging.opens_along_normal {
        normal
    } else {
        -normal
    };
    Sector {
        pivot: wall.point_at(along),
        radius: opening.width,
        closed,
        open,
    }
}

/// Every way this door could be hung, in [`HANGINGS`] order.
pub fn swing_options(opening: &Opening, wall: &Wall) -> [Sector; 4] {
    HANGINGS.map(|h| sector_for(opening, wall, h))
}

/// Whether a swept leaf is clear of everything in the room.
///
/// Its own wall is excluded — the door is a hole in that wall, and the leaf lying flat
/// in the closed position touches it by construction. Every other wall counts: a door
/// hung into a corner fouls the wall it opens toward.
fn is_clear(sector: &Sector, scene: &Scene, own_wall: core_scene::WallId) -> bool {
    let wall_free = scene
        .walls
        .iter()
        .filter(|w| w.id != own_wall)
        .all(|w| !sector_hits(sector, &wall_footprint(w)));
    wall_free
        && scene
            .placed_furnishings()
            .all(|f| !sector_hits(sector, &footprint(f)))
}

/// Ids of the doors that cannot open whichever way they are hung.
///
/// Only doors — a window has no leaf, so a sill-height opening sweeps nothing. Reported
/// when **all four** hangings are blocked, because the document does not record which
/// one a door actually uses: a single blocked option is a choice to avoid, not a fault.
/// That makes this deliberately conservative — it will not flag a door that is blocked
/// the way it is really hung but clear some other way, and it cannot, until handedness
/// is document state.
pub fn swing_blocked(scene: &Scene) -> Vec<OpeningId> {
    scene
        .openings
        .iter()
        .filter(|o| o.kind == OpeningKind::Door)
        .filter(|o| {
            let Some(wall) = scene.wall(o.wall) else {
                return false; // an opening whose wall has gone is not a swing problem
            };
            swing_options(o, wall)
                .iter()
                .all(|sector| !is_clear(sector, scene, o.wall))
        })
        .map(|o| o.id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_scene::{Anchor, Asset, Command, Furnishing, Placement, WallOrigin};
    use glam::Vec3;

    fn wall(id: u32, start: Vec2, end: Vec2) -> Wall {
        Wall {
            id,
            start,
            end,
            thickness: 0.12,
            height: 2.5,
            origin: WallOrigin::Drawn,
        }
    }

    fn door(id: u32, wall: u32, along: f32) -> Opening {
        Opening {
            id,
            wall,
            kind: OpeningKind::Door,
            along,
            width: 0.9,
            height: 2.03,
            sill: 0.0,
        }
    }

    /// A room with one long wall on `z = 0` and a door in the middle of it.
    fn one_door() -> Scene {
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(wall(0, Vec2::ZERO, Vec2::new(6.0, 0.0))));
        scene.apply(Command::AddOpening(door(10, 0, 3.0)));
        scene
    }

    fn box_at(id: u32, x: f32, z: f32, w: f32, d: f32) -> Furnishing {
        Furnishing {
            id,
            asset: Asset {
                extent: Vec3::new(w, 0.8, d),
                asset_id: "crate".into(),
            },
            placement: Placement {
                position: Vec3::new(x, 0.0, z),
                yaw: 0.0,
                anchor: Anchor::Floor,
            },
            scale: Vec3::ONE,
            stashed: false,
        }
    }

    #[test]
    fn a_door_in_an_empty_room_can_open() {
        assert!(swing_blocked(&one_door()).is_empty());
    }

    #[test]
    fn the_pivot_sits_at_a_jamb_not_the_centre() {
        // A 0.9 door centred at 3.0 spans 2.55..3.45, so the hinges are at the ends of
        // that span. Putting the pivot at 3.0 would misplace the reach by 0.45 m.
        let scene = one_door();
        let (o, w) = (scene.openings[0], scene.walls[0]);
        assert_eq!(sector_for(&o, &w, HANGINGS[0]).pivot, Vec2::new(2.55, 0.0));
        assert_eq!(sector_for(&o, &w, HANGINGS[2]).pivot, Vec2::new(3.45, 0.0));
    }

    #[test]
    fn the_radius_is_the_door_width_and_the_quarter_is_square_to_the_wall() {
        let scene = one_door();
        let s = sector_for(&scene.openings[0], &scene.walls[0], HANGINGS[0]);
        assert_eq!(s.radius, 0.9);
        // Closed lies in the wall, open is square to it — a right angle either way round.
        assert!(s.closed.dot(s.open).abs() < 1e-6);
    }

    #[test]
    fn a_wardrobe_across_the_doorway_blocks_every_hanging() {
        // 3 m wide and standing 0.4 m off the wall: it covers the swept quarter on the
        // `+z` side, and on `-z` there is nothing to swing into either — but the far
        // side is open floor, so this must block only when both sides are covered.
        let mut scene = one_door();
        scene.apply(Command::AddFurnishing(box_at(1, 3.0, 0.4, 3.0, 0.6)));
        scene.apply(Command::AddFurnishing(box_at(2, 3.0, -0.4, 3.0, 0.6)));
        assert_eq!(swing_blocked(&scene), vec![10]);
    }

    #[test]
    fn an_obstacle_on_one_side_only_leaves_the_door_a_way_to_open() {
        let mut scene = one_door();
        scene.apply(Command::AddFurnishing(box_at(1, 3.0, 0.5, 3.0, 0.8)));
        assert!(
            swing_blocked(&scene).is_empty(),
            "a door blocked one way is a hanging choice, not a fault"
        );
    }

    #[test]
    fn a_window_never_swings() {
        let mut scene = one_door();
        scene.openings[0].kind = OpeningKind::Window;
        scene.apply(Command::AddFurnishing(box_at(1, 3.0, 0.4, 3.0, 0.6)));
        scene.apply(Command::AddFurnishing(box_at(2, 3.0, -0.4, 3.0, 0.6)));
        assert!(swing_blocked(&scene).is_empty());
    }

    #[test]
    fn a_stashed_item_is_not_in_the_way() {
        let mut scene = one_door();
        for id in [1, 2] {
            let z = if id == 1 { 0.4 } else { -0.4 };
            scene.apply(Command::AddFurnishing(box_at(id, 3.0, z, 3.0, 0.6)));
            scene.apply(Command::SetStashed { id, stashed: true });
        }
        assert!(
            swing_blocked(&scene).is_empty(),
            "the bullpen is not the room"
        );
    }

    #[test]
    fn a_door_in_a_tight_corner_is_blocked_by_the_returning_wall() {
        // Two walls meeting at the origin, with a door 0.3 m along one of them — closer
        // to the corner than the door is wide, so the leaf fouls the other wall whichever
        // jamb it hangs from and whichever side it opens onto.
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(wall(0, Vec2::ZERO, Vec2::new(4.0, 0.0))));
        scene.apply(Command::AddWall(wall(1, Vec2::ZERO, Vec2::new(0.0, 4.0))));
        scene.apply(Command::AddOpening(door(10, 0, 0.5)));
        assert_eq!(
            swing_blocked(&scene),
            vec![10],
            "a door this close to a return has nowhere to swing"
        );
    }

    #[test]
    fn the_same_door_further_along_the_wall_is_fine() {
        // The discriminating half of the corner test: move it clear and it opens.
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(wall(0, Vec2::ZERO, Vec2::new(4.0, 0.0))));
        scene.apply(Command::AddWall(wall(1, Vec2::ZERO, Vec2::new(0.0, 4.0))));
        scene.apply(Command::AddOpening(door(10, 0, 2.0)));
        assert!(swing_blocked(&scene).is_empty());
    }

    #[test]
    fn an_obstacle_inside_the_arc_but_touching_no_edge_still_blocks() {
        // A small item wholly within the swept quarter crosses none of its boundaries,
        // so corner-in-sector is the only test that catches it. This is the case a
        // boundary-only implementation passes wrongly.
        let mut scene = one_door();
        scene.apply(Command::AddFurnishing(box_at(1, 2.9, 0.3, 0.2, 0.2)));
        scene.apply(Command::AddFurnishing(box_at(2, 2.9, -0.3, 0.2, 0.2)));
        assert_eq!(swing_blocked(&scene), vec![10]);
    }

    #[test]
    fn an_opening_whose_wall_was_deleted_is_not_reported() {
        let mut scene = one_door();
        scene.walls.clear(); // the opening outlives its wall only in a malformed document
        assert!(swing_blocked(&scene).is_empty());
    }
}
