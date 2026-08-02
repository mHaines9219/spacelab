//! Where walls meet: mitring the corner between two wall ends so they close cleanly.
//!
//! A wall on its own is a box, and two boxes meeting at a corner overlap in a lump on
//! the inside and leave a notch on the outside. Mitring slides each of the four ground
//! corners along its own centreline until the two walls' offset faces actually cross,
//! which is the point the corner belongs at.
//!
//! The solver produces [`WallEnds`] — pure along-coordinates. It never emits geometry;
//! [`crate::wall_mesh`] consumes the result. That split keeps the junction rules here
//! and the extrusion rules there.

use core_scene::{Scene, Wall};
use glam::Vec2;

/// Two wall ends within this distance (metres) are treated as meeting at one junction.
const JOIN_EPS: f32 = 1e-3;

/// Below this `|sin θ|` between two walls the mitre is singular — they are collinear,
/// either continuing straight on or doubled back. A square end is already correct there.
const PARALLEL_EPS: f32 = 1e-6;

/// A mitre may push a corner this many wall-thicknesses past the junction before we give
/// up and leave the end square. Walls meeting at a very shallow angle would otherwise
/// grow a long spike that reads as a rendering defect rather than as a corner.
const MITRE_LIMIT: f32 = 4.0;

/// Which slot of a [`WallEnds`] pair a thickness side (`-1` or `+1`) refers to.
pub(crate) fn side_index(s: f32) -> usize {
    (s > 0.0) as usize
}

/// Where a wall's four ground corners sit *along its own centreline* once mitred against
/// its neighbours. A wall standing alone keeps the square footprint — `0.0` at the start
/// and `length()` at the end, both thickness sides alike. A mitred end pushes one side
/// past the junction and pulls the other back, so the two walls close the corner between
/// them instead of overlapping in a lump.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WallEnds {
    /// Along-coordinates of the two start corners, indexed by [`side_index`].
    start: [f32; 2],
    end: [f32; 2],
}

impl WallEnds {
    /// The square footprint: both sides run the wall's full length, corner to corner.
    pub fn square(wall: &Wall) -> Self {
        Self {
            start: [0.0; 2],
            end: [wall.length(); 2],
        }
    }

    /// Along-coordinates `(near, far)` of the long face on thickness side `s`.
    pub(crate) fn face_span(&self, s: f32) -> (f32, f32) {
        let i = side_index(s);
        (self.start[i], self.end[i])
    }

    /// Record one mitred corner. `t` is measured from the junction along the wall's
    /// *outgoing* direction, and `sigma` is the side in that same outgoing frame — at
    /// the wall's end both are mirrored back into the wall's own frame.
    fn set_corner(&mut self, wall: &Wall, at_start: bool, sigma: f32, t: f32) {
        let (along, side) = if at_start {
            (t, sigma)
        } else {
            (wall.length() - t, -sigma)
        };
        let slot = if at_start {
            &mut self.start
        } else {
            &mut self.end
        };
        slot[side_index(side)] = along;
    }
}

/// Mitre every junction where exactly two wall ends meet, returning one [`WallEnds`] per
/// wall in `scene.walls` order.
///
/// Only two-end junctions are mitred: a T or a cross has no single corner to close, so
/// those ends stay square and simply bury themselves in the wall they run into.
pub fn mitre_walls(scene: &Scene) -> Vec<WallEnds> {
    let mut ends: Vec<WallEnds> = scene.walls.iter().map(WallEnds::square).collect();

    // Group wall ends by the point they land on. A room's worth of walls is small enough
    // that the quadratic scan costs less than the spatial index that would replace it.
    let mut junctions: Vec<(Vec2, Vec<(usize, bool)>)> = Vec::new();
    for (i, wall) in scene.walls.iter().enumerate() {
        for at_start in [true, false] {
            let p = if at_start { wall.start } else { wall.end };
            match junctions
                .iter_mut()
                .find(|(q, _)| q.distance_squared(p) <= JOIN_EPS * JOIN_EPS)
            {
                Some((_, members)) => members.push((i, at_start)),
                None => junctions.push((p, vec![(i, at_start)])),
            }
        }
    }

    for (_, members) in &junctions {
        if members.len() != 2 {
            continue;
        }
        let (a, a_start) = members[0];
        let (b, b_start) = members[1];
        let (wa, wb) = (scene.walls[a], scene.walls[b]);

        // Both directions run *away* from the joint, so the pair reads as a polyline
        // turning through it: arrive along `-db`, leave along `da`. That traversal is
        // what flips the side — `da`'s left is `db`'s right, hence the opposite sign of
        // `sigma` on b below.
        let da = if a_start {
            wa.direction()
        } else {
            -wa.direction()
        };
        let db = if b_start {
            wb.direction()
        } else {
            -wb.direction()
        };
        let denom = da.perp_dot(db);
        if denom.abs() < PARALLEL_EPS {
            continue;
        }
        let (ha, hb) = (wa.thickness * 0.5, wb.thickness * 0.5);

        // Solve `da*ta + na*sigma*ha == db*tb - nb*sigma*hb` for each side: where the two
        // offset lines cross is where the corner belongs.
        let solve = |sigma: f32| {
            let r = -(db.perp() * hb + da.perp() * ha) * sigma;
            (r.perp_dot(db) / denom, r.perp_dot(da) / denom)
        };
        let corners = [solve(-1.0), solve(1.0)];
        let within_limit = corners.iter().all(|&(ta, tb)| {
            ta.abs() <= MITRE_LIMIT * wa.thickness && tb.abs() <= MITRE_LIMIT * wb.thickness
        });
        if !within_limit {
            continue; // too shallow to mitre without spiking; both ends stay square
        }

        for (k, sigma) in [-1.0f32, 1.0].into_iter().enumerate() {
            let (ta, tb) = corners[k];
            ends[a].set_corner(&wa, a_start, sigma, ta);
            ends[b].set_corner(&wb, b_start, -sigma, tb);
        }
    }

    ends
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_scene::Command;

    fn wall(id: u32, start: Vec2, end: Vec2) -> Wall {
        Wall {
            id,
            start,
            end,
            thickness: 0.12,
            height: 2.5,
        }
    }

    fn scene_of(walls: &[Wall]) -> Scene {
        let mut scene = Scene::default();
        for w in walls {
            scene.apply(Command::AddWall(*w));
        }
        scene
    }

    /// Every wall in the scene kept the square footprint it started with.
    fn assert_all_square(scene: &Scene) {
        for (i, ends) in mitre_walls(scene).iter().enumerate() {
            assert_eq!(*ends, WallEnds::square(&scene.walls[i]), "wall {i}");
        }
    }

    #[test]
    fn a_wall_with_no_neighbours_keeps_square_ends() {
        assert_all_square(&scene_of(&[wall(0, Vec2::ZERO, Vec2::new(4.0, 0.0))]));
    }

    #[test]
    fn a_right_angle_corner_trades_half_a_thickness_each_way() {
        // Wall 0 runs +X and ends where wall 1 starts and runs +Z, both 0.12 thick. The
        // outer face of each should overshoot the joint by half the other's thickness,
        // and the inner face should fall short by the same — that is the 45° mitre.
        let scene = scene_of(&[
            wall(0, Vec2::ZERO, Vec2::new(4.0, 0.0)),
            wall(1, Vec2::new(4.0, 0.0), Vec2::new(4.0, 3.0)),
        ]);
        let ends = mitre_walls(&scene);
        assert_eq!(ends[0].face_span(-1.0), (0.0, 4.06)); // outer, overshoots
        assert_eq!(ends[0].face_span(1.0), (0.0, 3.94)); // inner, falls short
        assert_eq!(ends[1].face_span(-1.0), (-0.06, 3.0));
        assert_eq!(ends[1].face_span(1.0), (0.06, 3.0));
    }

    #[test]
    fn a_junction_reads_the_same_whichever_end_of_each_wall_meets_it() {
        // Wall direction is an authoring detail, not a geometric one. Drawing the same
        // corner with either wall reversed must land the corner in the same place.
        let corner = Vec2::new(4.0, 0.0);
        let baseline = scene_of(&[
            wall(0, Vec2::ZERO, corner),
            wall(1, corner, Vec2::new(4.0, 3.0)),
        ]);
        let reversed = scene_of(&[
            wall(0, corner, Vec2::ZERO),
            wall(1, Vec2::new(4.0, 3.0), corner),
        ]);
        let (a, b) = (mitre_walls(&baseline), mitre_walls(&reversed));
        // Reversing a wall swaps its ends and mirrors its sides, so the corner that was
        // 0.06 past wall 0's `end` on side -1 is now 0.06 before its `start` on side +1.
        for side in [-1.0f32, 1.0] {
            let forward = a[0].face_span(side).1 - 4.0; // overshoot past the joint
            let backward = -b[0].face_span(-side).0; // same, measured the other way
            assert!(
                (forward - backward).abs() < 1e-5,
                "side {side}: {forward} vs {backward}"
            );
        }
    }

    #[test]
    fn collinear_walls_butt_square_instead_of_mitring() {
        // A straight run split in two has no corner to close, and the mitre solve is
        // singular there. Square ends already meet perfectly.
        assert_all_square(&scene_of(&[
            wall(0, Vec2::ZERO, Vec2::new(2.0, 0.0)),
            wall(1, Vec2::new(2.0, 0.0), Vec2::new(4.0, 0.0)),
        ]));
    }

    #[test]
    fn a_t_junction_is_left_square() {
        // Three ends at one point: no single corner to close, so the stem just buries
        // itself in the wall it runs into.
        assert_all_square(&scene_of(&[
            wall(0, Vec2::ZERO, Vec2::new(2.0, 0.0)),
            wall(1, Vec2::new(2.0, 0.0), Vec2::new(4.0, 0.0)),
            wall(2, Vec2::new(2.0, 0.0), Vec2::new(2.0, 3.0)),
        ]));
    }

    #[test]
    fn ends_that_merely_pass_close_by_are_not_a_junction() {
        // 1 cm apart is ten times `JOIN_EPS`: two walls that nearly touch are not the
        // same corner, and inventing a mitre between them would drag geometry sideways.
        assert_all_square(&scene_of(&[
            wall(0, Vec2::ZERO, Vec2::new(4.0, 0.0)),
            wall(1, Vec2::new(4.01, 0.0), Vec2::new(4.01, 3.0)),
        ]));
    }

    #[test]
    fn a_very_shallow_corner_falls_back_to_square_ends() {
        // Two walls 5° apart: a true mitre would spike ~1.4 m past the junction, far
        // past `MITRE_LIMIT`, so both ends stay square rather than growing a splinter.
        let angle = 5.0_f32.to_radians();
        assert_all_square(&scene_of(&[
            wall(0, Vec2::ZERO, Vec2::new(4.0, 0.0)),
            wall(
                1,
                Vec2::ZERO,
                Vec2::new(4.0 * angle.cos(), 4.0 * angle.sin()),
            ),
        ]));
    }

    #[test]
    fn a_corner_just_inside_the_mitre_limit_is_still_mitred() {
        // The limit is 4 thicknesses = 0.48 m of overshoot, which a 0.12 m wall hits at
        // about 14°. At 20° the mitre is long but legitimate, and must not be dropped.
        let angle = 20.0_f32.to_radians();
        let scene = scene_of(&[
            wall(0, Vec2::ZERO, Vec2::new(4.0, 0.0)),
            wall(
                1,
                Vec2::ZERO,
                Vec2::new(4.0 * angle.cos(), 4.0 * angle.sin()),
            ),
        ]);
        let ends = mitre_walls(&scene);
        assert_ne!(ends[0], WallEnds::square(&scene.walls[0]));
        // Overshoot is `h / tan(θ/2)` — 0.06 / tan(10°) ≈ 0.34 m, inside the 0.48 limit.
        let overshoot = ends[0].face_span(-1.0).0;
        assert!(
            (overshoot + 0.06 / (angle * 0.5).tan()).abs() < 1e-3,
            "overshoot {overshoot}"
        );
    }
}
