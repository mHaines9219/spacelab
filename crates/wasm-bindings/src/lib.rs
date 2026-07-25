//! wasm-bindgen boundary. Coarse typed-array interface only — never per-object JSON.
//!
//! `Document` is the real M1 binding onto the Rust scene: the web layer describes an
//! intent (a rectangle, a drawn polygon, a delete) and reads back geometry buffers.
//! Room construction lives here, not in JS, per the "no document/geometry logic in
//! JavaScript" rule.

use core_geometry::{MeshBuffers, floor_mesh, resolve_placement, wall_mesh};
use core_scene::{
    Anchor, Asset, Command, FloorMaterial, Furnishing, FurnishingId, Placement, Scene, Wall,
};
use glam::{Vec2, Vec3};
use wasm_bindgen::prelude::*;

const CHAIR: FurnishingId = 1;
const SNAP_RADIUS: f32 = 0.35;
/// Arrow-key rotate step: 15° per press.
const ROTATE_STEP: f32 = std::f32::consts::PI / 12.0;
/// Arrow-key scale nudge: ±5% per press, uniform across axes.
const SCALE_STEP: f32 = 1.05;
const M_TO_IN: f32 = 39.370_08;
/// Floor on any single dimension so a typed 0 (or negative) can't collapse the asset.
const MIN_DIMENSION_M: f32 = 0.05;
/// Defaults for generated walls until per-wall editing exposes them.
const WALL_HEIGHT: f32 = 2.5;
const WALL_THICKNESS: f32 = 0.12;

/// Cap on retained undo snapshots. The scene is tiny, so this is generous.
const HISTORY_CAP: usize = 200;

#[wasm_bindgen]
pub struct Document {
    scene: Scene,
    floor: MeshBuffers,
    walls: MeshBuffers,
    /// Undo stack: a snapshot of the scene taken before each user action.
    history: Vec<Scene>,
}

#[wasm_bindgen]
impl Document {
    /// A blank document: no walls yet (the room comes from `set_rectangle`/`set_polygon`)
    /// plus the one demo furnishing.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let mut scene = Scene::default();
        scene.apply(Command::AddFurnishing(Furnishing {
            id: CHAIR,
            asset: Asset {
                extent: Vec3::new(0.83, 0.69, 0.57),
            },
            placement: Placement {
                position: Vec3::ZERO,
                yaw: 0.0,
                anchor: Anchor::Floor,
            },
            scale: Vec3::ONE,
        }));
        let mut document = Self {
            scene,
            floor: MeshBuffers::default(),
            walls: MeshBuffers::default(),
            history: Vec::new(),
        };
        document.rebuild();
        document
    }

    // --- Undo --------------------------------------------------------------

    /// Snapshot the scene before a user action. Discrete actions call this internally;
    /// the web calls it once at the start of a drag (which then mutates per pointer move
    /// without further snapshots), so one gesture is one undo step.
    pub fn checkpoint(&mut self) {
        self.history.push(self.scene.clone());
        if self.history.len() > HISTORY_CAP {
            self.history.remove(0);
        }
    }

    /// Restore the scene to before the last action. Returns false if nothing to undo.
    pub fn undo(&mut self) -> bool {
        match self.history.pop() {
            Some(scene) => {
                self.scene = scene;
                self.rebuild();
                true
            }
            None => false,
        }
    }

    pub fn wall_count(&self) -> usize {
        self.scene.walls.len()
    }

    // --- Room construction -------------------------------------------------

    /// Replace the room with an axis-aligned rectangle, corner at the origin.
    pub fn set_rectangle(&mut self, width: f32, depth: f32) {
        self.checkpoint();
        self.build_room(&[
            Vec2::new(0.0, 0.0),
            Vec2::new(width, 0.0),
            Vec2::new(width, depth),
            Vec2::new(0.0, depth),
        ]);
    }

    /// Replace the room with an arbitrary closed loop. `coords` is `[x0, z0, x1, z1, …]`
    /// in metres, in draw order; the loop is closed automatically.
    pub fn set_polygon(&mut self, coords: &[f32]) {
        let points: Vec<Vec2> = coords.chunks_exact(2).map(|c| Vec2::new(c[0], c[1])).collect();
        if points.len() >= 3 {
            self.checkpoint();
            self.build_room(&points);
        }
    }

    /// Remove one wall by id, then rebuild geometry. Leaves the room open — the floor
    /// spans whatever connected outline remains.
    pub fn delete_wall(&mut self, id: u32) {
        self.checkpoint();
        self.scene.apply(Command::DeleteWall(id));
        self.rebuild();
    }

    /// Append a single wall between two ground points (metres), then rebuild.
    pub fn add_wall(&mut self, sx: f32, sz: f32, ex: f32, ez: f32) {
        self.checkpoint();
        let id = self.scene.walls.iter().map(|w| w.id).max().map_or(0, |m| m + 1);
        self.scene.apply(Command::AddWall(Wall {
            id,
            start: Vec2::new(sx, sz),
            end: Vec2::new(ex, ez),
            thickness: WALL_THICKNESS,
            height: WALL_HEIGHT,
        }));
        self.rebuild();
    }

    fn build_room(&mut self, points: &[Vec2]) {
        self.scene.apply(Command::ClearWalls);
        let n = points.len();
        for i in 0..n {
            self.scene.apply(Command::AddWall(Wall {
                id: i as u32,
                start: points[i],
                end: points[(i + 1) % n],
                thickness: WALL_THICKNESS,
                height: WALL_HEIGHT,
            }));
        }
        // The floor footprint is stored on the document, so later wall edits leave it be.
        self.scene.apply(Command::SetFloorOutline(points.to_vec()));
        // Drop the furnishing into the middle of the fresh room.
        let centre = points.iter().copied().sum::<Vec2>() / n as f32;
        self.reseat(centre);
        self.rebuild();
    }

    /// Re-emit floor and wall meshes from the current scene. Called after every edit.
    fn rebuild(&mut self) {
        self.floor = MeshBuffers::default();
        floor_mesh(&self.scene, &mut self.floor);
        self.walls = MeshBuffers::default();
        for wall in &self.scene.walls {
            wall_mesh(wall, &mut self.walls);
        }
    }

    // --- Geometry read-back ------------------------------------------------

    pub fn floor_positions(&self) -> Vec<f32> {
        self.floor.positions.clone()
    }
    pub fn floor_normals(&self) -> Vec<f32> {
        self.floor.normals.clone()
    }
    pub fn floor_uvs(&self) -> Vec<f32> {
        self.floor.uvs.clone()
    }
    pub fn floor_indices(&self) -> Vec<u32> {
        self.floor.indices.clone()
    }

    pub fn wall_positions(&self) -> Vec<f32> {
        self.walls.positions.clone()
    }
    pub fn wall_normals(&self) -> Vec<f32> {
        self.walls.normals.clone()
    }
    pub fn wall_uvs(&self) -> Vec<f32> {
        self.walls.uvs.clone()
    }
    pub fn wall_indices(&self) -> Vec<u32> {
        self.walls.indices.clone()
    }

    /// Wall centrelines as `[start_x, start_z, end_x, end_z, …]`, for the 2D plan.
    pub fn wall_segments(&self) -> Vec<f32> {
        self.scene
            .walls
            .iter()
            .flat_map(|w| [w.start.x, w.start.y, w.end.x, w.end.y])
            .collect()
    }

    /// Wall ids parallel to `wall_segments`, so the plan can target a delete.
    pub fn wall_ids(&self) -> Vec<u32> {
        self.scene.walls.iter().map(|w| w.id).collect()
    }

    /// True once a room (floor) exists — independent of how many walls remain.
    pub fn has_room(&self) -> bool {
        !self.scene.floor_outline.is_empty()
    }

    /// Footprint bounds `[min_x, min_z, max_x, max_z]` from the floor outline (not the
    /// walls, which can be deleted); zeros if there is no room.
    pub fn room_bounds(&self) -> Vec<f32> {
        if self.scene.floor_outline.is_empty() {
            return vec![0.0; 4];
        }
        let mut min = Vec2::splat(f32::INFINITY);
        let mut max = Vec2::splat(f32::NEG_INFINITY);
        for &p in &self.scene.floor_outline {
            min = min.min(p);
            max = max.max(p);
        }
        vec![min.x, min.y, max.x, max.y]
    }

    // --- Floor finish ------------------------------------------------------

    /// Current floor finish as an ordinal matching `FloorMaterial`.
    pub fn floor_material(&self) -> u8 {
        self.scene.floor_material as u8
    }

    /// Choose the floor finish by ordinal; returns the resulting ordinal.
    pub fn set_floor_material(&mut self, index: u8) -> u8 {
        let material = match index {
            0 => FloorMaterial::WoodLight,
            1 => FloorMaterial::WoodDark,
            2 => FloorMaterial::Tile,
            _ => FloorMaterial::Concrete,
        };
        self.checkpoint();
        self.scene.apply(Command::SetFloorMaterial(material));
        self.floor_material()
    }

    // --- Furnishing manipulation ------------------------------------------

    /// Drag hot path, called once per pointer move: cursor metres in, transform out.
    pub fn drag(&mut self, x: f32, z: f32) -> Vec<f32> {
        self.reseat(Vec2::new(x, z))
    }

    /// Rotate by `steps` arrow presses (positive = counter-clockwise). Spins in
    /// place; the next drag re-snaps. Returns the transform.
    pub fn rotate(&mut self, steps: f32) -> Vec<f32> {
        self.checkpoint();
        let yaw = self.furnishing().placement.yaw + steps * ROTATE_STEP;
        self.scene.apply(Command::SetYaw { id: CHAIR, yaw });
        self.transform()
    }

    /// Uniform scale nudge: one `↑` press is `presses = 1`, one `↓` is `-1`.
    pub fn scale_by(&mut self, presses: f32) -> Vec<f32> {
        self.checkpoint();
        let factor = SCALE_STEP.powf(presses);
        let scale = self.furnishing().scale * factor;
        self.set_scale(scale)
    }

    /// Set one real-world dimension in inches: axis 0 = width, 1 = depth, 2 = height.
    pub fn set_dimension(&mut self, axis: u8, inches: f32) -> Vec<f32> {
        self.checkpoint();
        let metres = (inches / M_TO_IN).max(MIN_DIMENSION_M);
        let f = self.furnishing();
        let mut scale = f.scale;
        match axis {
            0 => scale.x = metres / f.asset.extent.x,
            1 => scale.z = metres / f.asset.extent.z,
            _ => scale.y = metres / f.asset.extent.y,
        }
        self.set_scale(scale)
    }

    /// Restore the asset to its catalog proportions (unit scale on every axis).
    pub fn reset_scale(&mut self) -> Vec<f32> {
        self.checkpoint();
        self.set_scale(Vec3::ONE)
    }

    /// Current real-world size in inches as `[width, depth, height]`, for the panel.
    pub fn dimensions(&self) -> Vec<f32> {
        let f = self.furnishing();
        let d = f.asset.extent * f.scale * M_TO_IN;
        vec![d.x, d.z, d.y]
    }

    /// The chair's current transform, for re-placing it after a room is (re)built.
    pub fn chair_transform(&self) -> Vec<f32> {
        self.transform()
    }

    fn furnishing(&self) -> Furnishing {
        *self.scene.furnishing(CHAIR).expect("chair is added in new()")
    }

    /// Effective footprint the constraint solver sees once scale is applied.
    fn scaled_asset(&self) -> Asset {
        let f = self.furnishing();
        Asset {
            extent: f.asset.extent * f.scale,
        }
    }

    /// Apply a new scale, then re-seat at the current position so a resized asset
    /// stays flush against its wall instead of clipping into or floating off it.
    /// Orientation is preserved: scaling never re-orients an asset the user rotated.
    fn set_scale(&mut self, scale: Vec3) -> Vec<f32> {
        let yaw = self.furnishing().placement.yaw;
        self.scene.apply(Command::SetScale { id: CHAIR, scale });
        let p = self.furnishing().placement.position;
        self.reseat(Vec2::new(p.x, p.z));
        self.scene.apply(Command::SetYaw { id: CHAIR, yaw });
        self.transform()
    }

    /// Resolve and apply a placement for a ground-plane target, using the scaled footprint.
    fn reseat(&mut self, target: Vec2) -> Vec<f32> {
        let placement = resolve_placement(&self.scene, &self.scaled_asset(), target, SNAP_RADIUS);
        self.scene.apply(Command::Reposition {
            id: CHAIR,
            placement,
        });
        self.transform()
    }

    /// Everything the renderer needs to draw the chair, in one coarse array:
    /// `[x, up, z, yaw, scale_x, scale_y, scale_z, snapped]`.
    fn transform(&self) -> Vec<f32> {
        let f = self.furnishing();
        vec![
            f.placement.position.x,
            f.placement.position.y,
            f.placement.position.z,
            f.placement.yaw,
            f.scale.x,
            f.scale.y,
            f.scale.z,
            matches!(f.placement.anchor, Anchor::AgainstWall(_)) as u8 as f32,
        ]
    }
}

impl Default for Document {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undo_reverts_actions_one_at_a_time() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        assert_eq!(doc.wall_count(), 4);

        doc.rotate(1.0);
        assert!(doc.chair_transform()[3].abs() > 0.0, "rotate should change yaw");

        // Undo the rotate: yaw back to 0, room intact.
        assert!(doc.undo());
        assert_eq!(doc.chair_transform()[3], 0.0);
        assert_eq!(doc.wall_count(), 4);

        // Undo the room creation: back to an empty scene.
        assert!(doc.undo());
        assert_eq!(doc.wall_count(), 0);

        // Nothing left to undo.
        assert!(!doc.undo());
    }

    #[test]
    fn undo_restores_a_deleted_wall() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        doc.delete_wall(0);
        assert_eq!(doc.wall_count(), 3);
        assert!(doc.undo());
        assert_eq!(doc.wall_count(), 4);
    }

    #[test]
    fn a_drag_is_one_undo_step_via_a_single_checkpoint() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let start = doc.chair_transform();
        // The web checkpoints once at the first move, then streams positions.
        doc.checkpoint();
        doc.drag(1.4, 1.0);
        doc.drag(1.2, 1.0);
        doc.drag(1.0, 1.0);
        assert_ne!(doc.chair_transform()[0], start[0], "drag should move the chair");
        // One undo returns to the pre-drag position, not through each move.
        assert!(doc.undo());
        assert_eq!(doc.chair_transform()[0], start[0]);
        assert_eq!(doc.chair_transform()[2], start[2]);
    }
}
