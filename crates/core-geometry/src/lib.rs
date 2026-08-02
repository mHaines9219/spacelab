//! Turns the scene document into meshes: prismatic wall extrusion, triangulation, snapping and clearance queries.

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

pub fn wall_mesh(wall: &Wall, openings: &[Opening], out: &mut MeshBuffers) {
    let offset = wall.normal() * wall.thickness * 0.5;
    let footprint = [
        wall.start - offset,
        wall.end - offset,
        wall.end + offset,
        wall.start + offset,
    ];
    let low = footprint.map(|p| ground(p, 0.0));
    let high = footprint.map(|p| ground(p, wall.height));

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
    emit_face(wall, -1.0, &cuts, out);
    emit_face(wall, 1.0, &cuts, out);
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
fn emit_face(wall: &Wall, s: f32, cuts: &[(f32, f32, &Opening)], out: &mut MeshBuffers) {
    let len = wall.length();
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

    let mut cursor = 0.0;
    for &(a0, a1, o) in cuts {
        let (sill, head) = (o.sill.max(0.0), o.head().min(height));
        quad(out, cursor, a0, 0.0, height); // full-height wall before the opening
        quad(out, a0, a1, 0.0, sill); // strip below the sill (empty for a door)
        quad(out, a0, a1, head, height); // strip above the head
        cursor = a1;
    }
    quad(out, cursor, len, 0.0, height); // wall after the last opening
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
        out.quad(p(a0, sill, -1.0), p(a0, sill, 1.0), p(a1, sill, 1.0), p(a1, sill, -1.0));
    }
    out.quad(p(a0, head, -1.0), p(a1, head, -1.0), p(a1, head, 1.0), p(a0, head, 1.0));
    // Jambs at each end, normals pointing inward along the wall.
    out.quad(p(a0, sill, -1.0), p(a0, head, -1.0), p(a0, head, 1.0), p(a0, sill, 1.0));
    out.quad(p(a1, sill, -1.0), p(a1, sill, 1.0), p(a1, head, 1.0), p(a1, head, -1.0));
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
fn signed_area2(poly: &[Vec2]) -> f32 {
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
                && !idx.iter().any(|&v| {
                    v != a && v != b && v != c && point_in_triangle(poly[v], pa, pb, pc)
                })
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
    for wall in &scene.walls {
        let openings: Vec<Opening> = scene.openings_on(wall.id).copied().collect();
        wall_mesh(wall, &openings, &mut out);
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
    use core_scene::{Command, OpeningKind, WallId};

    const CHAIR: Asset = Asset {
        extent: Vec3::new(0.83, 0.69, 0.57),
    };

    fn corner_room() -> Scene {
        let mut scene = Scene::default();
        for wall in [
            Wall {
                id: 0,
                start: Vec2::ZERO,
                end: Vec2::new(4.2, 0.0),
                thickness: 0.12,
                height: 2.5,
            },
            Wall {
                id: 1,
                start: Vec2::ZERO,
                end: Vec2::new(0.0, 3.4),
                thickness: 0.12,
                height: 2.5,
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
        wall_mesh(&corner_room().walls[0], &[], &mut mesh);
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
        wall_mesh(&wall, &[door], &mut mesh);
        let (a0, a1) = door.span();
        for q in quads(&mesh) {
            let c = q.iter().copied().sum::<Vec3>() / 4.0;
            // A face quad is one lying on a long face (|z| = half-thickness). If its
            // centroid sits inside the doorway footprint and below the head, it's a leak.
            let on_face = (c.z.abs() - 0.06).abs() < 1e-3;
            let inside = c.x > a0 + 1e-3 && c.x < a1 - 1e-3 && c.y < door.head() - 1e-3;
            assert!(!(on_face && inside), "face quad {c} sits inside the doorway");
        }
    }

    #[test]
    fn a_door_adds_a_head_and_two_jambs_but_no_sill() {
        // Solid wall = 6 quads. A floor door splits each long face into (before, above,
        // after) = 3, so 2 caps + 2 ends + 6 face strips = 10, plus head + 2 jambs = 13.
        let wall = corner_room().walls[0];
        let mut mesh = MeshBuffers::default();
        wall_mesh(&wall, &[opening(0, OpeningKind::Door, 2.1, 0.0)], &mut mesh);
        assert_eq!(mesh.vertex_count() / 4, 13);
    }

    #[test]
    fn a_window_adds_a_sill_reveal_that_a_door_omits() {
        // A window has a strip below it on each face (+2 vs the door) and a sill reveal
        // (+1): 13 + 3 = 16 quads.
        let wall = corner_room().walls[0];
        let mut mesh = MeshBuffers::default();
        wall_mesh(&wall, &[opening(0, OpeningKind::Window, 2.1, 0.9)], &mut mesh);
        assert_eq!(mesh.vertex_count() / 4, 16);
    }

    #[test]
    fn reveal_normals_face_into_the_opening_void() {
        let wall = corner_room().walls[0];
        let win = opening(0, OpeningKind::Window, 2.1, 0.9);
        let mut mesh = MeshBuffers::default();
        wall_mesh(&wall, &[win], &mut mesh);
        // The opening's centre point on the wall centreline; reveal normals should point
        // roughly towards it (sill up, head down, jambs inward).
        let centre = Vec3::new(win.along, win.sill + win.height * 0.5, 0.0);
        for (c, n) in face_normals(&mesh) {
            let near_void = (c.x - win.along).abs() < 0.46
                && c.y > win.sill - 1e-3
                && c.y < win.head() + 1e-3
                && c.z.abs() < 0.05; // reveals live within the thickness, not on the faces
            if near_void {
                assert!((centre - c).dot(n) > 0.0, "reveal normal {n} at {c} faces away from the void");
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
            wall_mesh(&wall, &[], &mut mesh);
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
        wall_mesh(&wall, &[], &mut mesh);
        let zs: Vec<f32> = mesh.positions.chunks(3).map(|v| v[2]).collect();
        let ys: Vec<f32> = mesh.positions.chunks(3).map(|v| v[1]).collect();
        assert!((zs.iter().cloned().fold(f32::MIN, f32::max) - 0.06).abs() < 1e-5);
        assert!((zs.iter().cloned().fold(f32::MAX, f32::min) + 0.06).abs() < 1e-5);
        assert_eq!(ys.iter().cloned().fold(f32::MIN, f32::max), wall.height);
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
            assert_eq!(mesh.triangle_count(), 2, "{delete_count} deleted: floor changed");
            let area: f32 = mesh_triangles(&mesh)
                .into_iter()
                .map(|[a, b, c]| (b - a).cross(c - a).length() * 0.5)
                .sum();
            assert!((area - 12.0).abs() < 1e-4, "{delete_count} deleted: area {area}");
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
        let placement = resolve_placement(&corner_room(), &CHAIR, Vec2::new(2.1, 1.7), 0.35);
        assert_eq!(placement.anchor, Anchor::Floor);
        assert_eq!(placement.position, Vec3::new(2.1, 0.0, 1.7));
        assert_eq!(placement.yaw, 0.0);
    }

    #[test]
    fn nearby_wall_seats_the_back_face_against_it() {
        let placement = resolve_placement(&corner_room(), &CHAIR, Vec2::new(2.1, 0.4), 0.35);
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
                resolve_placement(&corner_room(), &CHAIR, cursor, 0.35)
                    .position
                    .y,
                0.0
            );
        }
    }

    #[test]
    fn perpendicular_wall_yaws_the_asset_to_match() {
        let placement = resolve_placement(&corner_room(), &CHAIR, Vec2::new(0.3, 1.7), 0.35);
        assert_eq!(placement.anchor, Anchor::AgainstWall(1));
        assert!((placement.position.x - 0.345).abs() < 1e-5);
        assert!((placement.yaw - std::f32::consts::FRAC_PI_2).abs() < 1e-5);
    }

    #[test]
    fn placement_slides_along_the_wall_instead_of_overhanging_it() {
        let placement = resolve_placement(&corner_room(), &CHAIR, Vec2::new(4.6, 0.3), 0.35);
        assert_eq!(placement.anchor, Anchor::AgainstWall(0));
        assert!((placement.position.x - (4.2 - 0.415)).abs() < 1e-5);
    }

    #[test]
    fn overlapping_the_wall_pushes_the_asset_back_out() {
        let placement = resolve_placement(&corner_room(), &CHAIR, Vec2::new(2.1, 0.02), 0.35);
        assert!((placement.position.z - 0.345).abs() < 1e-5);
    }

    #[test]
    fn the_nearest_wall_wins_in_a_corner() {
        let placement = resolve_placement(&corner_room(), &CHAIR, Vec2::new(0.25, 0.4), 0.35);
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
        }));
        let placement = resolve_placement(&scene, &CHAIR, Vec2::new(0.35, 0.3), 0.35);
        assert!((placement.position.x - 0.2).abs() < 1e-5);
    }
}
