//! Turns the scene document into meshes: prismatic wall extrusion, triangulation, snapping and clearance queries.

mod junction;
mod room;

pub use junction::{WallEnds, mitre_walls};
pub use room::{Room, rooms};

use core_scene::{Anchor, Asset, Opening, Placement, Scene, Wall};
use glam::{Vec2, Vec3};

pub mod clearance;

/// Spans thinner than this (metres) are dropped rather than emitted as slivers — e.g.
/// the below-opening strip of a floor-standing door, whose sill is 0.
const EPS: f32 = 1e-4;

#[derive(Clone, Debug, Default)]
pub struct MeshBuffers {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    /// One `(u, v)` per vertex, in world **metres** projected onto each quad's plane.
    /// Texture tiling density is a renderer concern applied via `repeat`.
    pub uvs: Vec<f32>,
    pub indices: Vec<u32>,
}

impl MeshBuffers {
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// `a b c d` must wind counter-clockwise seen from outside; the normal follows.
    /// UVs project onto the quad's plane in metres: `u` along `a→b`, `v` along `a→d`,
    /// so a tiling texture repeats consistently regardless of quad size.
    fn quad(&mut self, a: Vec3, b: Vec3, c: Vec3, d: Vec3) {
        let base = self.vertex_count() as u32;
        let normal = (b - a).cross(c - a).normalize();
        let u_axis = (b - a).normalize_or_zero();
        let v_axis = (d - a).normalize_or_zero();
        for vertex in [a, b, c, d] {
            let rel = vertex - a;
            self.positions.extend_from_slice(&vertex.to_array());
            self.normals.extend_from_slice(&normal.to_array());
            self.uvs
                .extend_from_slice(&[rel.dot(u_axis), rel.dot(v_axis)]);
        }
        self.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

fn ground(p: Vec2, up: f32) -> Vec3 {
    Vec3::new(p.x, up, p.y)
}

/// The horizontal span an opening actually cuts, clamped inside the wall `[0, len]`.
/// Returns `None` for openings that fall entirely outside the wall or have collapsed to
/// nothing after clamping.
fn cut_span(wall: &Wall, opening: &Opening) -> Option<(f32, f32)> {
    let len = wall.length();
    let (a0, a1) = opening.span();
    let a0 = a0.max(0.0);
    let a1 = a1.min(len);
    (a1 - a0 > EPS).then_some((a0, a1))
}

pub fn wall_mesh(wall: &Wall, openings: &[Opening], ends: WallEnds, out: &mut MeshBuffers) {
    // Corner order matches the old square footprint: start and end on side -1, then end
    // and start on side +1. Mitring only slides each corner along the centreline, so the
    // winding — and every face below — is unchanged.
    let footprint = [(-1.0, false), (-1.0, true), (1.0, true), (1.0, false)].map(|(s, far)| {
        let (near, end) = ends.face_span(s);
        (if far { end } else { near }, s)
    });
    let low = footprint.map(|(a, s)| face_point(wall, a, 0.0, s));
    let high = footprint.map(|(a, s)| face_point(wall, a, wall.height, s));

    // Cap and end-cap faces are unaffected by openings (which never reach the wall ends
    // or its full height): bottom, top, and the two end caps stay solid.
    out.quad(low[0], low[1], low[2], low[3]);
    out.quad(high[3], high[2], high[1], high[0]);
    out.quad(low[3], high[3], high[0], low[0]);
    out.quad(low[1], high[1], high[2], low[2]);

    // The two long faces (inner/outer) get partitioned around the openings; the reveals
    // line the resulting holes through the wall's thickness.
    let cuts: Vec<(f32, f32, &Opening)> = {
        let mut v: Vec<(f32, f32, &Opening)> = openings
            .iter()
            .filter_map(|o| cut_span(wall, o).map(|(a0, a1)| (a0, a1, o)))
            .collect();
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        v
    };
    emit_face(wall, -1.0, ends, &cuts, out);
    emit_face(wall, 1.0, ends, &cuts, out);
    for &(a0, a1, o) in &cuts {
        emit_reveals(wall, a0, a1, o, out);
    }
}

/// A point on one long face of the wall at distance `a` along the centreline, height `y`,
/// and thickness side `s` (`-1` inner offset, `+1` outer offset).
fn face_point(wall: &Wall, a: f32, y: f32, s: f32) -> Vec3 {
    let d = wall.direction();
    let n = wall.normal();
    ground(wall.start + d * a + n * (wall.thickness * 0.5 * s), y)
}

/// Emit one long face (side `s`) as solid strips between and above/below each opening,
/// leaving the openings as holes. Winding flips with the side so both faces point out.
///
/// The face runs corner to corner rather than `0..length`: a mitred end leaves one side
/// longer than the centreline and the other shorter. Openings stay on the centreline, so
/// they are untouched by this.
fn emit_face(
    wall: &Wall,
    s: f32,
    ends: WallEnds,
    cuts: &[(f32, f32, &Opening)],
    out: &mut MeshBuffers,
) {
    let (near, far) = ends.face_span(s);
    let height = wall.height;
    let quad = |out: &mut MeshBuffers, a0: f32, a1: f32, y0: f32, y1: f32| {
        if a1 - a0 <= EPS || y1 - y0 <= EPS {
            return;
        }
        let p = |a, y| face_point(wall, a, y, s);
        if s < 0.0 {
            out.quad(p(a0, y0), p(a0, y1), p(a1, y1), p(a1, y0));
        } else {
            out.quad(p(a1, y0), p(a1, y1), p(a0, y1), p(a0, y0));
        }
    };

    let mut cursor = near;
    for &(a0, a1, o) in cuts {
        let (sill, head) = (o.sill.max(0.0), o.head().min(height));
        quad(out, cursor, a0, 0.0, height); // full-height wall before the opening
        quad(out, a0, a1, 0.0, sill); // strip below the sill (empty for a door)
        quad(out, a0, a1, head, height); // strip above the head
        cursor = a1;
    }
    quad(out, cursor, far, 0.0, height); // wall after the last opening
}

/// Line the hole through the wall's thickness: sill, head, and the two jambs. Each reveal
/// faces into the void so it reads when you look through the opening.
fn emit_reveals(wall: &Wall, a0: f32, a1: f32, o: &Opening, out: &mut MeshBuffers) {
    let (sill, head) = (o.sill.max(0.0), o.head().min(wall.height));
    if head - sill <= EPS {
        return;
    }
    let p = |a, y, s| face_point(wall, a, y, s);

    // Sill (skipped for a floor-standing door) faces up; head faces down.
    if sill > EPS {
        out.quad(
            p(a0, sill, -1.0),
            p(a0, sill, 1.0),
            p(a1, sill, 1.0),
            p(a1, sill, -1.0),
        );
    }
    out.quad(
        p(a0, head, -1.0),
        p(a1, head, -1.0),
        p(a1, head, 1.0),
        p(a0, head, 1.0),
    );
    // Jambs at each end, normals pointing inward along the wall.
    out.quad(
        p(a0, sill, -1.0),
        p(a0, head, -1.0),
        p(a0, head, 1.0),
        p(a0, sill, 1.0),
    );
    out.quad(
        p(a1, sill, -1.0),
        p(a1, sill, 1.0),
        p(a1, head, 1.0),
        p(a1, head, -1.0),
    );
}

/// Clamp a desired centre position so an opening of `width` sits wholly within the wall.
/// Wider-than-wall openings centre on the wall instead of inverting the clamp.
pub fn seat_opening(wall: &Wall, cursor: Vec2, width: f32) -> f32 {
    let len = wall.length();
    let half = (width * 0.5).min(len * 0.5);
    wall.project(cursor).clamp(half, len - half)
}

/// The floor is the document's designated footprint — independent of the walls, so
/// removing walls never reshapes it.
pub fn floor_mesh(scene: &Scene, out: &mut MeshBuffers) {
    let outline = &scene.floor_outline;
    if outline.len() < 3 {
        return;
    }
    let base = out.vertex_count() as u32;
    for p in outline {
        out.positions.extend_from_slice(&ground(*p, 0.0).to_array());
        out.normals.extend_from_slice(&Vec3::Y.to_array());
        // UVs in world metres (x, z); tiling density is applied by the renderer.
        out.uvs.extend_from_slice(&[p.x, p.y]);
    }
    for [a, b, c] in triangulate(outline) {
        // Reorder so the face winds upward (right-hand normal = +Y), matching the
        // per-vertex +Y normals regardless of the outline's own orientation.
        let up = (outline[b].y - outline[a].y) * (outline[c].x - outline[a].x)
            - (outline[b].x - outline[a].x) * (outline[c].y - outline[a].y);
        let (j, k) = if up > 0.0 { (b, c) } else { (c, b) };
        out.indices
            .extend_from_slice(&[base + a as u32, base + j as u32, base + k as u32]);
    }
}

/// Twice the signed area of a polygon; positive when the winding is counter-clockwise.
pub(crate) fn signed_area2(poly: &[Vec2]) -> f32 {
    let n = poly.len();
    (0..n)
        .map(|i| {
            let a = poly[i];
            let b = poly[(i + 1) % n];
            a.x * b.y - b.x * a.y
        })
        .sum()
}

fn point_in_triangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2) -> bool {
    let d1 = (p - a).perp_dot(b - a);
    let d2 = (p - b).perp_dot(c - b);
    let d3 = (p - c).perp_dot(a - c);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Ear-clipping triangulation of a simple polygon. Returns index triples into `poly`;
/// the caller fixes winding. Robust to clockwise or counter-clockwise input.
fn triangulate(poly: &[Vec2]) -> Vec<[usize; 3]> {
    let n = poly.len();
    if n < 3 {
        return Vec::new();
    }
    let mut idx: Vec<usize> = (0..n).collect();
    if signed_area2(poly) < 0.0 {
        idx.reverse(); // normalise to CCW so the convex test is consistent
    }
    let mut tris = Vec::with_capacity(n - 2);
    let mut guard = 0;
    while idx.len() > 3 {
        let m = idx.len();
        let mut clipped = false;
        for i in 0..m {
            let (a, b, c) = (idx[(i + m - 1) % m], idx[i], idx[(i + 1) % m]);
            let (pa, pb, pc) = (poly[a], poly[b], poly[c]);
            // Convex corner (left turn), and no other vertex falls inside the ear.
            if (pb - pa).perp_dot(pc - pb) > 0.0
                && !idx
                    .iter()
                    .any(|&v| v != a && v != b && v != c && point_in_triangle(poly[v], pa, pb, pc))
            {
                tris.push([a, b, c]);
                idx.remove(i);
                clipped = true;
                break;
            }
        }
        guard += 1;
        if !clipped || guard > n * n {
            break; // degenerate or self-intersecting; stop rather than loop forever
        }
    }
    if idx.len() == 3 {
        tris.push([idx[0], idx[1], idx[2]]);
    }
    tris
}

pub fn shell_mesh(scene: &Scene) -> MeshBuffers {
    let mut out = MeshBuffers::default();
    floor_mesh(scene, &mut out);
    for (wall, ends) in scene.walls.iter().zip(mitre_walls(scene)) {
        let openings: Vec<Opening> = scene.openings_on(wall.id).copied().collect();
        wall_mesh(wall, &openings, ends, &mut out);
    }
    out
}

/// Floor-anchored placement, pulled against the nearest wall within `radius` of the
/// asset's back face. Returns where the asset actually goes, not where the cursor is.
pub fn resolve_placement(scene: &Scene, asset: &Asset, cursor: Vec2, radius: f32) -> Placement {
    let mut best: Option<(f32, Placement)> = None;

    for wall in &scene.walls {
        let normal = wall.facing(cursor);
        let centre = wall.point_at(wall.project(cursor));
        let gap = (cursor - centre).dot(normal) - wall.thickness * 0.5 - asset.extent.z * 0.5;
        if gap > radius {
            continue;
        }

        let margin = (asset.extent.x * 0.5).min(wall.length() * 0.5);
        let along = wall.project(cursor).clamp(margin, wall.length() - margin);
        let seated = wall.point_at(along) + normal * (wall.thickness * 0.5 + asset.extent.z * 0.5);
        let placement = Placement {
            position: ground(seated, 0.0),
            yaw: normal.x.atan2(normal.y),
            anchor: Anchor::AgainstWall(wall.id),
        };

        if best.is_none_or(|(closest, _)| gap < closest) {
            best = Some((gap, placement));
        }
    }

    best.map(|(_, placement)| placement).unwrap_or(Placement {
        position: ground(cursor, 0.0),
        yaw: 0.0,
        anchor: Anchor::Floor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_scene::{Command, OpeningKind, WallId, WallOrigin};

    fn chair_asset() -> Asset {
        Asset {
            extent: Vec3::new(0.83, 0.69, 0.57),
            asset_id: "sheen-chair".into(),
        }
    }

    fn corner_room() -> Scene {
        let mut scene = Scene::default();
        for wall in [
            Wall {
                id: 0,
                start: Vec2::ZERO,
                end: Vec2::new(4.2, 0.0),
                thickness: 0.12,
                height: 2.5,
                origin: WallOrigin::Drawn,
            },
            Wall {
                id: 1,
                start: Vec2::ZERO,
                end: Vec2::new(0.0, 3.4),
                thickness: 0.12,
                height: 2.5,
                origin: WallOrigin::Drawn,
            },
        ] {
            scene.apply(Command::AddWall(wall));
        }
        scene
    }

    fn face_normals(mesh: &MeshBuffers) -> Vec<(Vec3, Vec3)> {
        (0..mesh.vertex_count() / 4)
            .map(|face| {
                let quad: Vec<Vec3> = (0..4)
                    .map(|i| {
                        let v = (face * 4 + i) * 3;
                        Vec3::from_slice(&mesh.positions[v..v + 3])
                    })
                    .collect();
                let centroid = quad.iter().sum::<Vec3>() / 4.0;
                let n = (face * 4) * 3;
                (centroid, Vec3::from_slice(&mesh.normals[n..n + 3]))
            })
            .collect()
    }

    #[test]
    fn wall_extrudes_to_a_closed_box() {
        let mut mesh = MeshBuffers::default();
        let wall = corner_room().walls[0];
        wall_mesh(&wall, &[], WallEnds::square(&wall), &mut mesh);
        assert_eq!(mesh.vertex_count(), 24);
        assert_eq!(mesh.triangle_count(), 12);
    }

    fn opening(wall: WallId, kind: OpeningKind, along: f32, sill: f32) -> Opening {
        Opening {
            id: 100,
            wall,
            kind,
            along,
            width: 0.9,
            height: 1.2,
            sill,
        }
    }

    /// Every quad in a mesh, as its four corner points (verts are grouped in fours).
    fn quads(mesh: &MeshBuffers) -> Vec<[Vec3; 4]> {
        (0..mesh.vertex_count() / 4)
            .map(|q| {
                std::array::from_fn(|i| {
                    let v = (q * 4 + i) * 3;
                    Vec3::from_slice(&mesh.positions[v..v + 3])
                })
            })
            .collect()
    }

    #[test]
    fn a_door_leaves_no_geometry_over_its_opening() {
        // A door reaching the floor: no quad should occupy the doorway void.
        let wall = corner_room().walls[0]; // along +X, 4.2 long
        let door = opening(0, OpeningKind::Door, 2.1, 0.0);
        let mut mesh = MeshBuffers::default();
        wall_mesh(&wall, &[door], WallEnds::square(&wall), &mut mesh);
        let (a0, a1) = door.span();
        for q in quads(&mesh) {
            let c = q.iter().copied().sum::<Vec3>() / 4.0;
            // A face quad is one lying on a long face (|z| = half-thickness). If its
            // centroid sits inside the doorway footprint and below the head, it's a leak.
            let on_face = (c.z.abs() - 0.06).abs() < 1e-3;
            let inside = c.x > a0 + 1e-3 && c.x < a1 - 1e-3 && c.y < door.head() - 1e-3;
            assert!(
                !(on_face && inside),
                "face quad {c} sits inside the doorway"
            );
        }
    }

    #[test]
    fn a_door_adds_a_head_and_two_jambs_but_no_sill() {
        // Solid wall = 6 quads. A floor door splits each long face into (before, above,
        // after) = 3, so 2 caps + 2 ends + 6 face strips = 10, plus head + 2 jambs = 13.
        let wall = corner_room().walls[0];
        let mut mesh = MeshBuffers::default();
        let door = opening(0, OpeningKind::Door, 2.1, 0.0);
        wall_mesh(&wall, &[door], WallEnds::square(&wall), &mut mesh);
        assert_eq!(mesh.vertex_count() / 4, 13);
    }

    #[test]
    fn a_window_adds_a_sill_reveal_that_a_door_omits() {
        // A window has a strip below it on each face (+2 vs the door) and a sill reveal
        // (+1): 13 + 3 = 16 quads.
        let wall = corner_room().walls[0];
        let mut mesh = MeshBuffers::default();
        let window = opening(0, OpeningKind::Window, 2.1, 0.9);
        wall_mesh(&wall, &[window], WallEnds::square(&wall), &mut mesh);
        assert_eq!(mesh.vertex_count() / 4, 16);
    }

    #[test]
    fn reveal_normals_face_into_the_opening_void() {
        let wall = corner_room().walls[0];
        let win = opening(0, OpeningKind::Window, 2.1, 0.9);
        let mut mesh = MeshBuffers::default();
        wall_mesh(&wall, &[win], WallEnds::square(&wall), &mut mesh);
        // The opening's centre point on the wall centreline; reveal normals should point
        // roughly towards it (sill up, head down, jambs inward).
        let centre = Vec3::new(win.along, win.sill + win.height * 0.5, 0.0);
        for (c, n) in face_normals(&mesh) {
            let near_void = (c.x - win.along).abs() < 0.46
                && c.y > win.sill - 1e-3
                && c.y < win.head() + 1e-3
                && c.z.abs() < 0.05; // reveals live within the thickness, not on the faces
            if near_void {
                assert!(
                    (centre - c).dot(n) > 0.0,
                    "reveal normal {n} at {c} faces away from the void"
                );
            }
        }
    }

    #[test]
    fn an_opening_wider_than_its_wall_is_centred_not_inverted() {
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(Wall {
            id: 0,
            start: Vec2::ZERO,
            end: Vec2::new(0.6, 0.0),
            thickness: 0.12,
            height: 2.5,
            origin: WallOrigin::Drawn,
        }));
        // Cursor past the far end; a 0.9-wide opening can't fit a 0.6 wall, so it centres.
        let along = seat_opening(&scene.walls[0], Vec2::new(5.0, 0.0), 0.9);
        assert!((along - 0.3).abs() < 1e-5, "along {along}");
    }

    #[test]
    fn seat_opening_keeps_the_opening_within_the_wall() {
        let wall = corner_room().walls[0]; // 4.2 long, 0.9-wide opening
        // Cursor beyond the end clamps so the opening's far edge lands on the wall end.
        let along = seat_opening(&wall, Vec2::new(9.9, 0.0), 0.9);
        assert!((along - (4.2 - 0.45)).abs() < 1e-5, "along {along}");
        // Cursor before the start clamps to the near margin.
        let along = seat_opening(&wall, Vec2::new(-9.9, 0.0), 0.9);
        assert!((along - 0.45).abs() < 1e-5, "along {along}");
    }

    #[test]
    fn wall_face_normals_point_away_from_the_centre() {
        for wall in corner_room().walls {
            let mut mesh = MeshBuffers::default();
            wall_mesh(&wall, &[], WallEnds::square(&wall), &mut mesh);
            let centre = Vec3::new(
                (wall.start.x + wall.end.x) * 0.5,
                wall.height * 0.5,
                (wall.start.y + wall.end.y) * 0.5,
            );
            for (centroid, normal) in face_normals(&mesh) {
                assert!(
                    (centroid - centre).dot(normal) > 0.0,
                    "inward-facing normal {normal} on wall {}",
                    wall.id
                );
            }
        }
    }

    #[test]
    fn wall_spans_its_thickness_and_height() {
        let wall = corner_room().walls[0];
        let mut mesh = MeshBuffers::default();
        wall_mesh(&wall, &[], WallEnds::square(&wall), &mut mesh);
        let zs: Vec<f32> = mesh.positions.chunks(3).map(|v| v[2]).collect();
        let ys: Vec<f32> = mesh.positions.chunks(3).map(|v| v[1]).collect();
        assert!((zs.iter().cloned().fold(f32::MIN, f32::max) - 0.06).abs() < 1e-5);
        assert!((zs.iter().cloned().fold(f32::MAX, f32::min) + 0.06).abs() < 1e-5);
        assert_eq!(ys.iter().cloned().fold(f32::MIN, f32::max), wall.height);
    }

    // --- Mitred junctions --------------------------------------------------

    /// A wall's four ground corners, read back out of the emitted mesh (the bottom cap
    /// is the first quad `wall_mesh` writes, and it *is* the footprint) so these tests
    /// assert on the geometry that actually ships rather than on the solver's internals.
    fn footprint(scene: &Scene, index: usize) -> [Vec2; 4] {
        let wall = scene.walls[index];
        let ends = mitre_walls(scene)[index];
        let mut mesh = MeshBuffers::default();
        wall_mesh(&wall, &[], ends, &mut mesh);
        std::array::from_fn(|i| Vec2::new(mesh.positions[i * 3], mesh.positions[i * 3 + 2]))
    }

    fn assert_near(a: Vec2, b: Vec2, what: &str) {
        assert!(a.distance(b) < 1e-4, "{what}: {a} != {b}");
    }

    /// A wall with nothing to meet keeps the square footprint it always had.
    fn lone_wall(start: Vec2, end: Vec2) -> Wall {
        Wall {
            id: 0,
            start,
            end,
            thickness: 0.12,
            height: 2.5,
            origin: WallOrigin::Drawn,
        }
    }

    fn scene_of(walls: &[Wall]) -> Scene {
        let mut scene = Scene::default();
        for wall in walls {
            scene.apply(Command::AddWall(*wall));
        }
        scene
    }

    #[test]
    fn a_right_angle_corner_closes_on_the_wall_envelope() {
        // Walls on z = 0 and x = 4, each 0.12 thick, so the corner they wrap runs from
        // the outer envelope point (4.06, -0.06) to the inner one (3.94, 0.06).
        let scene = rect_room(4.0, 3.0);
        let (outer, inner) = (Vec2::new(4.06, -0.06), Vec2::new(3.94, 0.06));

        // Wall 0 ends at the junction: its end corners are footprint slots 1 and 2.
        let along_x = footprint(&scene, 0);
        assert_near(along_x[1], outer, "wall 0 outer end");
        assert_near(along_x[2], inner, "wall 0 inner end");

        // Wall 1 starts there: slots 0 and 3. Both walls land on the same two points,
        // which is what "the corner closes" means — no gap outside, no lump inside.
        let along_z = footprint(&scene, 1);
        assert_near(along_z[0], outer, "wall 1 outer start");
        assert_near(along_z[3], inner, "wall 1 inner start");
    }

    #[test]
    fn a_closed_room_mitres_to_exactly_its_inner_and_outer_rectangles() {
        // Four mitred corners leave eight distinct points: the 4.12 × 3.12 outer
        // rectangle and the 3.88 × 2.88 inner one. Anything else means a corner is
        // overlapping (a point inside the envelope) or gapping (one outside it).
        let scene = rect_room(4.0, 3.0);
        let expected = [
            (-0.06, -0.06),
            (4.06, -0.06),
            (4.06, 3.06),
            (-0.06, 3.06),
            (0.06, 0.06),
            (3.94, 0.06),
            (3.94, 2.94),
            (0.06, 2.94),
        ]
        .map(|(x, z)| Vec2::new(x, z));

        for index in 0..scene.walls.len() {
            for corner in footprint(&scene, index) {
                assert!(
                    expected.iter().any(|e| e.distance(corner) < 1e-4),
                    "wall {index} corner {corner} is off the room envelope"
                );
            }
        }
        // And every expected point is actually reached — two walls each, eight in all.
        for point in expected {
            let hits = (0..scene.walls.len())
                .flat_map(|i| footprint(&scene, i))
                .filter(|c| c.distance(point) < 1e-4)
                .count();
            assert_eq!(hits, 2, "{point} reached by {hits} wall corners, want 2");
        }
    }

    #[test]
    fn walls_of_unequal_thickness_still_meet_at_one_point() {
        // The mitre is the intersection of the two offset lines, so a thin wall meeting
        // a thick one lands both of them on the same corner rather than splitting it.
        let mut thin = lone_wall(Vec2::ZERO, Vec2::new(4.0, 0.0));
        thin.thickness = 0.08;
        let mut thick = lone_wall(Vec2::new(4.0, 0.0), Vec2::new(4.0, 3.0));
        thick.id = 1;
        thick.thickness = 0.30;
        let scene = scene_of(&[thin, thick]);

        // Outer corner: thin wall's far face (z = -0.04) meets thick wall's far face
        // (x = 4.15). Inner: z = +0.04 meets x = 3.85.
        let (a, b) = (footprint(&scene, 0), footprint(&scene, 1));
        assert_near(a[1], Vec2::new(4.15, -0.04), "thin outer end");
        assert_near(b[0], Vec2::new(4.15, -0.04), "thick outer start");
        assert_near(a[2], Vec2::new(3.85, 0.04), "thin inner end");
        assert_near(b[3], Vec2::new(3.85, 0.04), "thick inner start");
    }

    #[test]
    fn mitring_moves_corners_without_adding_geometry() {
        // Same quad count as a square wall, with and without an opening: the mitre
        // slides corners along the centreline, it does not re-partition the faces.
        let scene = rect_room(4.0, 3.0);
        let (wall, ends) = (scene.walls[0], mitre_walls(&scene)[0]);
        assert_ne!(ends, WallEnds::square(&wall), "wall 0 should be mitred");

        let mut solid = MeshBuffers::default();
        wall_mesh(&wall, &[], ends, &mut solid);
        assert_eq!(solid.vertex_count() / 4, 6);

        let mut with_door = MeshBuffers::default();
        let door = opening(0, OpeningKind::Door, 2.0, 0.0);
        wall_mesh(&wall, &[door], ends, &mut with_door);
        assert_eq!(with_door.vertex_count() / 4, 13);
    }

    #[test]
    fn a_mitred_face_still_runs_the_full_length_of_its_side() {
        // The long faces are what a viewer sees; each must reach its own two corners,
        // so the outer face grows past the centreline while the inner one shrinks.
        let scene = rect_room(4.0, 3.0);
        let (wall, ends) = (scene.walls[0], mitre_walls(&scene)[0]);
        let mut mesh = MeshBuffers::default();
        wall_mesh(&wall, &[], ends, &mut mesh);

        let on_side = |z: f32| {
            mesh.positions
                .chunks(3)
                .filter(|v| (v[2] - z).abs() < 1e-4)
                .map(|v| v[0])
                .fold((f32::MAX, f32::MIN), |(lo, hi), x| (lo.min(x), hi.max(x)))
        };
        assert_eq!(on_side(-0.06), (-0.06, 4.06)); // outer face, extended both ends
        assert_eq!(on_side(0.06), (0.06, 3.94)); // inner face, pulled back both ends
    }

    #[test]
    fn mitred_end_caps_still_face_away_from_the_wall() {
        // The caps are no longer square to the wall — they lie in the mitre plane — so
        // check they did not wind themselves inside out on the way.
        let scene = rect_room(4.0, 3.0);
        for (index, wall) in scene.walls.iter().enumerate() {
            let mut mesh = MeshBuffers::default();
            wall_mesh(wall, &[], mitre_walls(&scene)[index], &mut mesh);
            let centre = Vec3::new(
                (wall.start.x + wall.end.x) * 0.5,
                wall.height * 0.5,
                (wall.start.y + wall.end.y) * 0.5,
            );
            for (centroid, normal) in face_normals(&mesh) {
                assert!(
                    normal.is_finite(),
                    "wall {index}: non-finite normal {normal}"
                );
                assert!(
                    (centroid - centre).dot(normal) > 0.0,
                    "wall {index}: inward-facing normal {normal} at {centroid}"
                );
            }
        }
    }

    #[test]
    fn a_wall_shorter_than_its_own_mitres_still_emits_finite_geometry() {
        // A 10 cm stub between two 90° corners has 6 cm bitten off each end of its inner
        // face, so that face inverts and drops out. Degenerate, but it must not produce
        // NaN normals or panic — a user mid-drag can pass through this shape.
        let scene = scene_of(&[
            lone_wall(Vec2::new(-2.0, 0.0), Vec2::ZERO),
            Wall {
                id: 1,
                ..lone_wall(Vec2::ZERO, Vec2::new(0.0, 0.1))
            },
            Wall {
                id: 2,
                ..lone_wall(Vec2::new(0.0, 0.1), Vec2::new(2.0, 0.1))
            },
        ]);
        let mesh = shell_mesh(&scene);
        assert!(mesh.triangle_count() > 0);
        assert!(
            mesh.positions
                .iter()
                .chain(&mesh.normals)
                .all(|v| v.is_finite()),
            "degenerate stub emitted non-finite geometry"
        );
    }

    /// A closed rectangular room, corner at the origin, with matching walls and floor.
    fn rect_room(width: f32, depth: f32) -> Scene {
        let mut scene = Scene::default();
        let corners = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(width, 0.0),
            Vec2::new(width, depth),
            Vec2::new(0.0, depth),
        ];
        for i in 0..4 {
            scene.apply(Command::AddWall(Wall {
                id: i as u32,
                start: corners[i],
                end: corners[(i + 1) % 4],
                thickness: 0.12,
                height: 2.5,
                origin: WallOrigin::Drawn,
            }));
        }
        scene.apply(Command::SetFloorOutline(corners));
        scene
    }

    fn mesh_triangles(mesh: &MeshBuffers) -> Vec<[Vec3; 3]> {
        mesh.indices
            .chunks(3)
            .map(|tri| {
                std::array::from_fn(|i| {
                    let v = tri[i] as usize * 3;
                    Vec3::from_slice(&mesh.positions[v..v + 3])
                })
            })
            .collect()
    }

    #[test]
    fn rectangular_floor_triangulates_facing_up_and_covers_its_area() {
        let mut mesh = MeshBuffers::default();
        floor_mesh(&rect_room(4.0, 3.0), &mut mesh);
        assert_eq!(mesh.triangle_count(), 2); // n - 2 for a 4-gon
        let mut area = 0.0;
        for [a, b, c] in mesh_triangles(&mesh) {
            let normal = (b - a).cross(c - a);
            assert!(normal.y > 0.0, "floor triangle faces down: {normal}");
            area += normal.length() * 0.5;
        }
        assert!((area - 12.0).abs() < 1e-4, "area {area}");
    }

    #[test]
    fn deleting_walls_never_reshapes_the_floor() {
        // The floor is the document's footprint, not a function of the walls: delete
        // one, two, or all of them and the floor stays the full 4×3 = 12.
        for delete_count in 0..=4 {
            let mut scene = rect_room(4.0, 3.0);
            for id in 0..delete_count {
                scene.apply(Command::DeleteWall(id));
            }
            assert_eq!(scene.walls.len(), (4 - delete_count) as usize);
            let mut mesh = MeshBuffers::default();
            floor_mesh(&scene, &mut mesh);
            assert_eq!(
                mesh.triangle_count(),
                2,
                "{delete_count} deleted: floor changed"
            );
            let area: f32 = mesh_triangles(&mesh)
                .into_iter()
                .map(|[a, b, c]| (b - a).cross(c - a).length() * 0.5)
                .sum();
            assert!(
                (area - 12.0).abs() < 1e-4,
                "{delete_count} deleted: area {area}"
            );
        }
    }

    #[test]
    fn concave_l_room_triangulates_without_spilling_outside() {
        // An L: 6 vertices, so 4 triangles, and the covered area is the L, not its bbox.
        let mut scene = Scene::default();
        let corners = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(4.0, 0.0),
            Vec2::new(4.0, 2.0),
            Vec2::new(2.0, 2.0),
            Vec2::new(2.0, 4.0),
            Vec2::new(0.0, 4.0),
        ];
        for i in 0..6 {
            scene.apply(Command::AddWall(Wall {
                id: i as u32,
                start: corners[i],
                end: corners[(i + 1) % 6],
                thickness: 0.12,
                height: 2.5,
                origin: WallOrigin::Drawn,
            }));
        }
        scene.apply(Command::SetFloorOutline(corners));
        let mut mesh = MeshBuffers::default();
        floor_mesh(&scene, &mut mesh);
        assert_eq!(mesh.triangle_count(), 4);
        let mut area = 0.0;
        for [a, b, c] in mesh_triangles(&mesh) {
            assert!((b - a).cross(c - a).y > 0.0, "triangle faces down");
            area += (b - a).cross(c - a).length() * 0.5;
        }
        // L area = 4×2 + 2×2 = 12, strictly less than the 4×4 = 16 bounding box.
        assert!((area - 12.0).abs() < 1e-4, "area {area}");
    }

    #[test]
    fn open_floor_placement_follows_the_cursor() {
        let placement =
            resolve_placement(&corner_room(), &chair_asset(), Vec2::new(2.1, 1.7), 0.35);
        assert_eq!(placement.anchor, Anchor::Floor);
        assert_eq!(placement.position, Vec3::new(2.1, 0.0, 1.7));
        assert_eq!(placement.yaw, 0.0);
    }

    #[test]
    fn nearby_wall_seats_the_back_face_against_it() {
        let placement =
            resolve_placement(&corner_room(), &chair_asset(), Vec2::new(2.1, 0.4), 0.35);
        assert_eq!(placement.anchor, Anchor::AgainstWall(0));
        // 0.06 wall half-thickness + 0.285 chair half-depth
        assert!((placement.position.z - 0.345).abs() < 1e-5);
        assert!((placement.position.x - 2.1).abs() < 1e-5);
        // Facing +Z, into the room and away from the wall.
        assert!((placement.yaw - 0.0).abs() < 1e-5);
    }

    #[test]
    fn placement_stays_on_the_floor() {
        for cursor in [
            Vec2::new(2.1, 0.2),
            Vec2::new(2.1, 1.7),
            Vec2::new(0.3, 3.2),
        ] {
            assert_eq!(
                resolve_placement(&corner_room(), &chair_asset(), cursor, 0.35)
                    .position
                    .y,
                0.0
            );
        }
    }

    #[test]
    fn perpendicular_wall_yaws_the_asset_to_match() {
        let placement =
            resolve_placement(&corner_room(), &chair_asset(), Vec2::new(0.3, 1.7), 0.35);
        assert_eq!(placement.anchor, Anchor::AgainstWall(1));
        assert!((placement.position.x - 0.345).abs() < 1e-5);
        assert!((placement.yaw - std::f32::consts::FRAC_PI_2).abs() < 1e-5);
    }

    #[test]
    fn placement_slides_along_the_wall_instead_of_overhanging_it() {
        let placement =
            resolve_placement(&corner_room(), &chair_asset(), Vec2::new(4.6, 0.3), 0.35);
        assert_eq!(placement.anchor, Anchor::AgainstWall(0));
        assert!((placement.position.x - (4.2 - 0.415)).abs() < 1e-5);
    }

    #[test]
    fn overlapping_the_wall_pushes_the_asset_back_out() {
        let placement =
            resolve_placement(&corner_room(), &chair_asset(), Vec2::new(2.1, 0.02), 0.35);
        assert!((placement.position.z - 0.345).abs() < 1e-5);
    }

    #[test]
    fn the_nearest_wall_wins_in_a_corner() {
        let placement =
            resolve_placement(&corner_room(), &chair_asset(), Vec2::new(0.25, 0.4), 0.35);
        assert_eq!(placement.anchor, Anchor::AgainstWall(1));
    }

    #[test]
    fn short_walls_centre_the_asset_rather_than_inverting_the_clamp() {
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(Wall {
            id: 7,
            start: Vec2::ZERO,
            end: Vec2::new(0.4, 0.0),
            thickness: 0.12,
            height: 2.5,
            origin: WallOrigin::Drawn,
        }));
        let placement = resolve_placement(&scene, &chair_asset(), Vec2::new(0.35, 0.3), 0.35);
        assert!((placement.position.x - 0.2).abs() < 1e-5);
    }
}
