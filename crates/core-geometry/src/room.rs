//! Room detection: which enclosed areas the walls actually make.
//!
//! A wall list is a graph, not a room. The rooms are its bounded faces — the areas you
//! could not walk out of. Finding them is the standard planar-graph face walk: sort the
//! wall ends around each corner by angle, then always take the sharpest right turn. That
//! traversal splits the half-edges into closed loops, one per face, and the unbounded
//! outside face is the one that comes back clockwise.
//!
//! Like [`crate::junction`], this module answers a question about the wall graph and
//! emits no geometry. [`crate::floor_mesh`] is what decides to put a floor in a room.

use core_scene::{Scene, Wall, WallId};
use glam::Vec2;

/// Wall ends within this distance (metres) are the same corner. Matches the join
/// tolerance the mitre solver uses, so the two agree on where a corner is.
const JOIN_EPS: f32 = 1e-3;

/// Faces below this area (m²) are not rooms — a dangling wall walked out and back
/// closes a loop of zero area, and a hairline sliver is not somewhere you stand.
const MIN_AREA: f32 = 1e-3;

/// One enclosed area of the wall graph.
#[derive(Clone, Debug, PartialEq)]
pub struct Room {
    /// The corners, in loop order and counter-clockwise in the `(x, z)` ground plane.
    /// These are wall *centreline* corners, not face corners — a floor laid on this
    /// outline runs to the middle of its walls and is hidden under them.
    pub outline: Vec<Vec2>,
    /// The walls bounding the room, one per outline edge: `walls[i]` spans
    /// `outline[i]` to `outline[i + 1]`. A wall enclosing the room on both sides
    /// (a spur reached and returned along) appears twice.
    pub walls: Vec<WallId>,
}

impl Room {
    /// Floor area in m².
    pub fn area(&self) -> f32 {
        crate::signed_area2(&self.outline).abs() * 0.5
    }
}

/// The wall graph as half-edges: every wall walked in both directions, with the walls
/// around each corner sorted by angle so a face walk can pick its turn.
struct Graph {
    /// Corner positions, deduplicated within [`JOIN_EPS`].
    points: Vec<Vec2>,
    /// Index into `scene.walls` for each graph edge. Zero-length walls are left out,
    /// so this is not the identity.
    walls: Vec<usize>,
    /// `[start corner, end corner]` per edge, as indices into `points`.
    ends: Vec<[usize; 2]>,
    /// Half-edges leaving each corner, sorted counter-clockwise by their direction.
    outgoing: Vec<Vec<usize>>,
}

/// Half-edge `h` walks edge `h / 2`; even runs start → end, odd runs end → start.
impl Graph {
    fn build(scene: &Scene) -> Self {
        // A wall shorter than the join tolerance has both ends at one corner: it
        // encloses nothing and its direction is numerically meaningless.
        let usable: Vec<usize> = (0..scene.walls.len())
            .filter(|&i| scene.walls[i].length() > JOIN_EPS)
            .collect();

        let mut points: Vec<Vec2> = Vec::new();
        for &i in &usable {
            corner(&mut points, scene.walls[i].start);
            corner(&mut points, scene.walls[i].end);
        }

        let mut walls = Vec::new();
        let mut ends = Vec::new();
        for &i in &usable {
            // An alcove is drawn against the middle of the wall it hangs off, not
            // against its ends, so a wall is one graph edge per stretch between the
            // corners that land on it — otherwise that wall closes nothing.
            for pair in split_points(&points, &scene.walls[i]).windows(2) {
                walls.push(i);
                ends.push([pair[0], pair[1]]);
            }
        }

        let mut graph = Graph {
            points,
            walls,
            ends,
            outgoing: Vec::new(),
        };
        graph.outgoing = vec![Vec::new(); graph.points.len()];
        for h in 0..2 * graph.ends.len() {
            let v = graph.origin(h);
            graph.outgoing[v].push(h);
        }
        for (v, list) in graph.outgoing.iter_mut().enumerate() {
            let from = graph.points[v];
            list.sort_by(|&a, &b| {
                let angle = |h: usize| {
                    let d = graph.points[graph.ends[h / 2][1 - (h & 1)]] - from;
                    d.y.atan2(d.x)
                };
                angle(a).total_cmp(&angle(b))
            });
        }
        graph
    }

    fn origin(&self, h: usize) -> usize {
        self.ends[h / 2][h & 1]
    }

    /// The next half-edge along the face to this one's left: arrive at the far corner,
    /// then leave along the neighbour one step clockwise from the way we came. Taking
    /// the sharpest available right turn is what keeps the walk hugging a single face.
    fn next(&self, h: usize) -> usize {
        let back = h ^ 1;
        let list = &self.outgoing[self.origin(back)];
        let i = list
            .iter()
            .position(|&e| e == back)
            .expect("every half-edge is listed at its own origin");
        list[(i + list.len() - 1) % list.len()]
    }
}

/// The corners `wall` runs through, in order from its start to its end: its own two ends
/// plus every other wall's end that touches it in between. Consecutive pairs are the
/// graph edges the wall contributes.
fn split_points(points: &[Vec2], wall: &Wall) -> Vec<usize> {
    let mut on_wall: Vec<(f32, usize)> = points
        .iter()
        .enumerate()
        .filter_map(|(i, &p)| {
            let along = wall.project(p);
            let off = wall.point_at(along).distance(p);
            (off <= JOIN_EPS).then_some((along, i))
        })
        .collect();
    // `project` clamps, so the wall's own ends come back at exactly 0 and `length` and
    // sort to the outside. Anything landing on top of them is the same corner already.
    on_wall.sort_by(|a, b| a.0.total_cmp(&b.0));
    on_wall.dedup_by(|a, b| (a.0 - b.0).abs() <= JOIN_EPS);
    on_wall.into_iter().map(|(_, i)| i).collect()
}

/// Index of `p` in `points`, appending it if no existing corner is within [`JOIN_EPS`].
fn corner(points: &mut Vec<Vec2>, p: Vec2) -> usize {
    match points
        .iter()
        .position(|q| q.distance_squared(p) <= JOIN_EPS * JOIN_EPS)
    {
        Some(i) => i,
        None => {
            points.push(p);
            points.len() - 1
        }
    }
}

/// Every enclosed area of `scene`'s walls, largest first.
///
/// Walls that merely cross mid-span do not make a corner — only shared endpoints do —
/// so a room closed by walls that overlap rather than meet is not detected.
pub fn rooms(scene: &Scene) -> Vec<Room> {
    let graph = Graph::build(scene);
    let half_edges = 2 * graph.ends.len();

    let mut seen = vec![false; half_edges];
    let mut rooms = Vec::new();
    for start in 0..half_edges {
        if seen[start] {
            continue;
        }
        let mut face = Vec::new();
        let mut h = start;
        while !seen[h] {
            seen[h] = true;
            face.push(h);
            h = graph.next(h);
        }

        let outline: Vec<Vec2> = face
            .iter()
            .map(|&h| graph.points[graph.origin(h)])
            .collect();
        // The outside of the graph is the one face that comes back clockwise, and a
        // loop that only walked out along dead ends and back encloses nothing.
        if crate::signed_area2(&outline) <= 2.0 * MIN_AREA {
            continue;
        }
        rooms.push(Room {
            walls: face
                .iter()
                .map(|&h| scene.walls[graph.walls[h / 2]].id)
                .collect(),
            outline,
        });
    }

    rooms.sort_by(|a, b| b.area().total_cmp(&a.area()));
    rooms
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_scene::{Command, Wall, WallOrigin};

    fn walls_of(points: &[(f32, f32)], edges: &[(usize, usize)]) -> Scene {
        let mut scene = Scene::default();
        for (id, &(a, b)) in edges.iter().enumerate() {
            scene.apply(Command::AddWall(Wall {
                id: id as u32,
                start: Vec2::new(points[a].0, points[a].1),
                end: Vec2::new(points[b].0, points[b].1),
                thickness: 0.12,
                height: 2.5,
                origin: WallOrigin::Drawn,
            }));
        }
        scene
    }

    /// A closed loop of `points`, one wall per side.
    fn closed(points: &[(f32, f32)]) -> Scene {
        let n = points.len();
        let edges: Vec<(usize, usize)> = (0..n).map(|i| (i, (i + 1) % n)).collect();
        walls_of(points, &edges)
    }

    const SQUARE: [(f32, f32); 4] = [(0.0, 0.0), (4.0, 0.0), (4.0, 3.0), (0.0, 3.0)];

    #[test]
    fn a_closed_rectangle_is_one_room() {
        let rooms = rooms(&closed(&SQUARE));
        assert_eq!(rooms.len(), 1);
        assert!((rooms[0].area() - 12.0).abs() < 1e-4, "{}", rooms[0].area());
        assert_eq!(rooms[0].outline.len(), 4);
        assert_eq!(rooms[0].walls.len(), 4);
    }

    #[test]
    fn the_detected_outline_winds_counter_clockwise() {
        // Downstream triangulation and the point-in-room test both read the sign, so
        // the walk must normalise it however the user happened to draw the loop.
        let mut backwards = SQUARE;
        backwards.reverse();
        for points in [SQUARE, backwards] {
            let rooms = rooms(&closed(&points));
            assert!(crate::signed_area2(&rooms[0].outline) > 0.0);
        }
    }

    #[test]
    fn the_default_two_wall_room_encloses_nothing() {
        // The room the app opens with raises only two of four walls so the view can get
        // in. There is no enclosed face — its floor comes from the document footprint,
        // not from here.
        let scene = walls_of(&SQUARE, &[(3, 0), (0, 1)]);
        assert!(rooms(&scene).is_empty());
    }

    #[test]
    fn an_open_side_means_no_room_until_it_is_closed() {
        let mut scene = walls_of(&SQUARE, &[(0, 1), (1, 2), (2, 3)]);
        assert!(rooms(&scene).is_empty());
        scene.apply(Command::AddWall(Wall {
            id: 9,
            start: Vec2::new(0.0, 3.0),
            end: Vec2::ZERO,
            thickness: 0.12,
            height: 2.5,
            origin: WallOrigin::Drawn,
        }));
        assert_eq!(rooms(&scene).len(), 1);
    }

    #[test]
    fn a_partition_splits_one_room_into_two() {
        // The classic reason face detection beats "the walls I drew": the partition is
        // one new wall, but the room count goes from one to two and neither half is a
        // loop the user drew.
        let points = [
            (0.0, 0.0),
            (4.0, 0.0),
            (4.0, 3.0),
            (0.0, 3.0),
            (1.0, 0.0),
            (1.0, 3.0),
        ];
        let scene = walls_of(
            &points,
            &[(0, 4), (4, 1), (1, 2), (2, 5), (5, 3), (3, 0), (4, 5)],
        );
        let rooms = rooms(&scene);
        assert_eq!(rooms.len(), 2);
        // Largest first: the 3 m side, then the 1 m one. Together they are the whole.
        assert!((rooms[0].area() - 9.0).abs() < 1e-4);
        assert!((rooms[1].area() - 3.0).abs() < 1e-4);
    }

    #[test]
    fn two_rooms_sharing_a_doorway_wall_are_both_found() {
        // Adjacent rooms in a row: the middle wall bounds both, so its id appears in
        // both rooms' wall lists.
        let points = [
            (0.0, 0.0),
            (4.0, 0.0),
            (4.0, 3.0),
            (0.0, 3.0),
            (8.0, 0.0),
            (8.0, 3.0),
        ];
        let scene = walls_of(
            &points,
            &[
                (0, 1),
                (1, 2),
                (2, 3),
                (3, 0), // left room
                (1, 4),
                (4, 5),
                (5, 2), // right room, sharing wall 1
            ],
        );
        let rooms = rooms(&scene);
        assert_eq!(rooms.len(), 2);
        assert!(rooms.iter().all(|r| r.walls.contains(&1)));
        assert!(rooms.iter().all(|r| (r.area() - 12.0).abs() < 1e-4));
    }

    #[test]
    fn a_spur_inside_a_room_does_not_add_a_room() {
        // A stub wall hanging off a corner into the room is walked out and back by the
        // face walk. It encloses nothing, so the room count and area are unchanged —
        // but it does appear twice in the room's wall list, which is the honest answer.
        let mut scene = closed(&SQUARE);
        scene.apply(Command::AddWall(Wall {
            id: 4,
            start: Vec2::ZERO,
            end: Vec2::new(1.0, 1.0),
            thickness: 0.12,
            height: 2.5,
            origin: WallOrigin::Drawn,
        }));
        let rooms = rooms(&scene);
        assert_eq!(rooms.len(), 1);
        assert!((rooms[0].area() - 12.0).abs() < 1e-4);
        assert_eq!(rooms[0].walls.iter().filter(|&&id| id == 4).count(), 2);
    }

    #[test]
    fn walls_meeting_another_mid_span_close_a_room_against_it() {
        // Nobody draws an alcove by first cutting the wall it hangs off in two. Three
        // walls out from the middle of the 4 m side and back must enclose 2×1, with the
        // long wall serving as the fourth side.
        let scene = walls_of(
            &[
                (0.0, 0.0),
                (4.0, 0.0),
                (1.0, 0.0),
                (1.0, -1.0),
                (3.0, -1.0),
                (3.0, 0.0),
            ],
            &[(0, 1), (2, 3), (3, 4), (4, 5)],
        );
        let rooms = rooms(&scene);
        assert_eq!(rooms.len(), 1);
        assert!((rooms[0].area() - 2.0).abs() < 1e-4, "{}", rooms[0].area());
        // Both stretches of the split wall bound it, under the one id it still has.
        assert_eq!(rooms[0].walls.iter().filter(|&&id| id == 0).count(), 1);
    }

    #[test]
    fn a_wall_that_only_crosses_another_makes_no_room() {
        // Two walls crossing mid-span share no endpoint, so the graph has no corner
        // there. This is the known limit: rooms are closed by walls that *meet*.
        let scene = walls_of(
            &[(0.0, 0.0), (4.0, 0.0), (2.0, -2.0), (2.0, 2.0)],
            &[(0, 1), (2, 3)],
        );
        assert!(rooms(&scene).is_empty());
    }

    #[test]
    fn a_zero_length_wall_is_ignored_rather_than_breaking_the_walk() {
        // Mid-drag a wall can be a point. Its direction is undefined, which would put
        // a NaN into the angular sort and scramble every face.
        let mut scene = closed(&SQUARE);
        scene.apply(Command::AddWall(Wall {
            id: 4,
            start: Vec2::new(2.0, 1.0),
            end: Vec2::new(2.0, 1.0),
            thickness: 0.12,
            height: 2.5,
            origin: WallOrigin::Drawn,
        }));
        let rooms = rooms(&scene);
        assert_eq!(rooms.len(), 1);
        assert!((rooms[0].area() - 12.0).abs() < 1e-4);
    }

    #[test]
    fn no_walls_means_no_rooms() {
        assert!(rooms(&Scene::default()).is_empty());
    }
}
