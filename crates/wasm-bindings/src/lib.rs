//! wasm-bindgen boundary. Coarse typed-array interface only — never per-object JSON.
//!
//! `Document` is the real M1 binding onto the Rust scene: the web layer describes an
//! intent (a rectangle, a drawn polygon, a delete) and reads back geometry buffers.
//! Room construction lives here, not in JS, per the "no document/geometry logic in
//! JavaScript" rule.

use core_geometry::{
    MeshBuffers, clearance::crowded, floor_mesh, mitre_walls, resolve_placement, seat_opening,
    wall_mesh,
};
use core_scene::{
    Anchor, Asset, Command, FloorMaterial, Furnishing, FurnishingId, LightingPreset, Opening,
    OpeningId, OpeningKind, Placement, Scene, Wall, WallId, WallMaterial, WallOrigin,
};
use glam::{Vec2, Vec3};
use wasm_bindgen::prelude::*;

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

/// Catalog-ish default sizes (metres) for a freshly placed opening, keyed by kind:
/// a ~36×80" door on the floor, a ~39×47" window at a 3' sill.
const DOOR_SIZE: (f32, f32, f32) = (0.9, 2.03, 0.0); // width, height, sill
const WINDOW_SIZE: (f32, f32, f32) = (1.0, 1.2, 0.9);

/// Cap on retained undo snapshots. The scene is tiny, so this is generous.
const HISTORY_CAP: usize = 200;

#[wasm_bindgen]
pub struct Document {
    scene: Scene,
    floor: MeshBuffers,
    walls: MeshBuffers,
    /// Undo stack: a snapshot of the scene taken before each user action.
    history: Vec<Scene>,
    /// Next furnishing id to hand out. Monotonic; ids are never reused.
    next_id: FurnishingId,
    /// Next opening id to hand out. Monotonic; a separate namespace from furnishings.
    next_opening_id: OpeningId,
    /// Next wall id to hand out. Monotonic and never reused, so a regenerated wall can
    /// never collide with one the user drew. Persisted state — a save file has to carry
    /// it, or reloading restarts the counter on top of live ids.
    next_wall_id: WallId,
    /// The furnishing the furniture ops (drag/rotate/scale) act on. UI state, not
    /// document state, so it stays off the undo snapshots (which clone the Scene).
    selected: Option<FurnishingId>,
    /// The opening the door/window ops act on. UI state, same as `selected`.
    selected_opening: Option<OpeningId>,
}

#[wasm_bindgen]
impl Document {
    /// A blank document: no walls (the room comes from `set_rectangle`/`set_polygon`)
    /// and no furnishings (the web places them from the catalog via `add_furnishing`).
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let mut document = Self {
            scene: Scene::default(),
            floor: MeshBuffers::default(),
            walls: MeshBuffers::default(),
            history: Vec::new(),
            next_id: 1,
            next_opening_id: 1,
            next_wall_id: 0,
            selected: None,
            selected_opening: None,
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
    ///
    /// A fresh rectangular room opens toward the camera: only the two far walls
    /// (meeting at the origin corner) are raised, so the near two never block the
    /// view in. The floor keeps its full rectangular footprint regardless, and the
    /// missing walls can be added back by hand from the 3D view.
    pub fn set_rectangle(&mut self, width: f32, depth: f32) {
        self.checkpoint();
        let corners = [
            Vec2::new(0.0, 0.0),
            Vec2::new(width, 0.0),
            Vec2::new(width, depth),
            Vec2::new(0.0, depth),
        ];
        self.build_room(
            &[(corners[3], corners[0]), (corners[0], corners[1])],
            &corners,
        );
    }

    /// Replace the room with an arbitrary closed loop. `coords` is `[x0, z0, x1, z1, …]`
    /// in metres, in draw order; the loop is closed automatically.
    pub fn set_polygon(&mut self, coords: &[f32]) {
        let points: Vec<Vec2> = coords.chunks_exact(2).map(|c| Vec2::new(c[0], c[1])).collect();
        if points.len() >= 3 {
            self.checkpoint();
            // A traced room raises every wall the user drew — the two-wall default is
            // only for the generated rectangle.
            let n = points.len();
            let segments: Vec<(Vec2, Vec2)> =
                (0..n).map(|i| (points[i], points[(i + 1) % n])).collect();
            self.build_room(&segments, &points);
        }
    }

    /// Remove one wall by id, then rebuild geometry. Leaves the room open — the floor
    /// spans whatever connected outline remains.
    pub fn delete_wall(&mut self, id: u32) {
        self.checkpoint();
        self.scene.apply(Command::DeleteWall(id));
        self.rebuild();
    }

    /// Append a single wall between two ground points (metres), then rebuild. Hand-drawn,
    /// so regenerating the room leaves it standing.
    pub fn add_wall(&mut self, sx: f32, sz: f32, ex: f32, ez: f32) {
        self.checkpoint();
        let wall = self.new_wall(Vec2::new(sx, sz), Vec2::new(ex, ez), WallOrigin::Drawn);
        self.scene.apply(Command::AddWall(wall));
        self.rebuild();
    }

    /// A wall with a freshly allocated id.
    ///
    /// Ids come from one monotonic counter and are never reused. They used to come from
    /// two places that disagreed — `build_room` numbered from the segment index while
    /// `add_wall` took `max + 1` — which only stayed harmless because regenerating wiped
    /// everything first. The moment hand-drawn walls survive a regenerate, those two
    /// allocators hand out the same id, and `wall`/`openings_on`/`delete_wall` all key
    /// off it: a silent wrong-wall bug rather than a crash.
    fn new_wall(&mut self, start: Vec2, end: Vec2, origin: WallOrigin) -> Wall {
        let id = self.next_wall_id;
        self.next_wall_id += 1;
        Wall {
            id,
            start,
            end,
            thickness: WALL_THICKNESS,
            height: WALL_HEIGHT,
            origin,
        }
    }

    /// Regenerate the room's own walls from `segments`, and set the floor to `outline`.
    ///
    /// Two things are deliberately left alone. The floor footprint is whatever `outline`
    /// describes, independent of how many `segments` are raised, so a room can open on one
    /// or more sides without reshaping its floor. And **walls the user drew by hand stay
    /// up** — only [`WallOrigin::Generated`] walls are replaced, so resizing a room no
    /// longer destroys the walls someone added to it.
    fn build_room(&mut self, segments: &[(Vec2, Vec2)], outline: &[Vec2]) {
        let walls: Vec<Wall> = segments
            .iter()
            .map(|&(start, end)| self.new_wall(start, end, WallOrigin::Generated))
            .collect();
        self.scene.apply(Command::ReplaceGeneratedWalls(walls));
        // The floor footprint is stored on the document, so later wall edits leave it be.
        self.scene.apply(Command::SetFloorOutline(outline.to_vec()));
        // Furnishings persist across room edits; the web re-reads their transforms.
        self.rebuild();
    }

    /// Re-emit floor and wall meshes from the current scene. Called after every edit.
    fn rebuild(&mut self) {
        self.floor = MeshBuffers::default();
        floor_mesh(&self.scene, &mut self.floor);
        self.walls = MeshBuffers::default();
        // Mitres are a property of the whole wall graph, so they are solved once per
        // rebuild rather than per wall.
        for (wall, ends) in self.scene.walls.iter().zip(mitre_walls(&self.scene)) {
            let openings: Vec<Opening> = self.scene.openings_on(wall.id).copied().collect();
            wall_mesh(wall, &openings, ends, &mut self.walls);
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

    // --- Detected rooms ----------------------------------------------------
    //
    // What the walls actually enclose, which is *not* the floor: `floor_outline` is the
    // document's own footprint and stays put when a wall is deleted (see `floor_mesh`).
    // The names carry `detected_` because `has_room`/`room_bounds` above mean the floor.
    // These three read together — outlines is a flat run of `[x, z, …]` split by the
    // corner counts, in the same order as the areas. Solved on demand rather than cached
    // on `rebuild`, since nothing needs it every frame.

    /// Number of enclosed areas the walls make, largest first.
    pub fn detected_room_count(&self) -> usize {
        core_geometry::rooms(&self.scene).len()
    }

    /// Every detected room's corners, concatenated as `[x, z, …]`. Split with
    /// `room_corner_counts`.
    pub fn detected_room_outlines(&self) -> Vec<f32> {
        core_geometry::rooms(&self.scene)
            .iter()
            .flat_map(|r| r.outline.iter().flat_map(|p| [p.x, p.y]))
            .collect()
    }

    /// Corners per room, in the same order — the split points for `detected_room_outlines`.
    pub fn detected_room_corner_counts(&self) -> Vec<u32> {
        core_geometry::rooms(&self.scene)
            .iter()
            .map(|r| r.outline.len() as u32)
            .collect()
    }

    /// Floor area in m² per detected room, largest first.
    pub fn detected_room_areas(&self) -> Vec<f32> {
        core_geometry::rooms(&self.scene)
            .iter()
            .map(|r| r.area())
            .collect()
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

    // --- Wall finish -------------------------------------------------------

    /// Current wall paint finish as an ordinal matching `WallMaterial`.
    pub fn wall_material(&self) -> u8 {
        self.scene.wall_material as u8
    }

    /// Choose the wall paint finish by ordinal; returns the resulting ordinal.
    pub fn set_wall_material(&mut self, index: u8) -> u8 {
        let material = match index {
            0 => WallMaterial::WarmWhite,
            1 => WallMaterial::CoolGrey,
            2 => WallMaterial::Greige,
            3 => WallMaterial::Sage,
            _ => WallMaterial::Clay,
        };
        self.checkpoint();
        self.scene.apply(Command::SetWallMaterial(material));
        self.wall_material()
    }

    // --- Lighting ----------------------------------------------------------

    /// Current lighting mood as an ordinal matching `LightingPreset`.
    pub fn lighting(&self) -> u8 {
        self.scene.lighting as u8
    }

    /// Choose the lighting mood by ordinal; returns the resulting ordinal.
    pub fn set_lighting(&mut self, index: u8) -> u8 {
        let preset = match index {
            0 => LightingPreset::Noon,
            1 => LightingPreset::Morning,
            2 => LightingPreset::Evening,
            _ => LightingPreset::Overcast,
        };
        self.checkpoint();
        self.scene.apply(Command::SetLighting(preset));
        self.lighting()
    }

    // --- Furnishing catalog & selection -----------------------------------

    /// Place a catalog asset in the room and select it. `ex/ey/ez` are the asset's
    /// real-world extent (width/height/depth, metres). Returns the new furnishing id;
    /// the web maps that id to the catalog entry (which GLB to load). Drops at the room
    /// centre (origin if no room yet), then reseats so it snaps if the centre is near a
    /// wall.
    pub fn add_furnishing(&mut self, ex: f32, ey: f32, ez: f32) -> u32 {
        self.checkpoint();
        let id = self.next_id;
        self.next_id += 1;
        let drop = self.drop_target();
        self.scene.apply(Command::AddFurnishing(Furnishing {
            id,
            asset: Asset {
                extent: Vec3::new(ex, ey, ez),
            },
            placement: Placement {
                position: Vec3::new(drop.x, 0.0, drop.y),
                yaw: 0.0,
                anchor: Anchor::Floor,
            },
            scale: Vec3::ONE,
            stashed: false,
        }));
        self.selected = Some(id);
        self.reseat(id, drop);
        id
    }

    /// A staggered drop point near the room centre, so successive placements (and
    /// re-imports from the bullpen) don't stack exactly on top of each other.
    fn drop_target(&self) -> Vec2 {
        let n = (self.scene.placed_furnishings().count() % 5) as f32;
        self.room_centre() + Vec2::splat(0.3) * n
    }

    /// Remove the selected furnishing (if any). Returns true if one was removed.
    pub fn remove_selected(&mut self) -> bool {
        match self.selected.take() {
            Some(id) => {
                self.checkpoint();
                self.scene.apply(Command::RemoveFurnishing(id));
                true
            }
            None => false,
        }
    }

    /// Remove any furnishing by id (placed or stashed). Returns true if one was removed.
    /// Used to discard a bullpen item for good; clears selection if it was the target.
    pub fn remove_furnishing(&mut self, id: u32) -> bool {
        if self.scene.furnishing(id).is_none() {
            return false;
        }
        self.checkpoint();
        self.scene.apply(Command::RemoveFurnishing(id));
        if self.selected == Some(id) {
            self.selected = None;
        }
        true
    }

    // --- Bullpen (set aside / re-import) -----------------------------------
    // A stashed furnishing stays in the document — keeping its scale, yaw, and identity,
    // and riding undo — but is pulled out of the room: excluded from `furnishing_ids`
    // (so it stops rendering) and surfaced in `stashed_ids` for the bullpen tray.

    /// Set the selected furnishing aside into the bullpen. Returns its id (so the web
    /// can move its tray card), or -1 if nothing was selected. Clears the selection,
    /// since the item is no longer in the room.
    pub fn stash_selected(&mut self) -> i32 {
        match self.live_selection() {
            Some(id) => {
                self.checkpoint();
                self.scene.apply(Command::SetStashed { id, stashed: true });
                self.selected = None;
                id as i32
            }
            None => -1,
        }
    }

    /// Bring a bullpen item back into the room and select it. It re-enters at the
    /// staggered room centre with its scale and rotation intact (only its old position
    /// is discarded). Returns its transform, or empty if the id isn't a stashed item.
    pub fn unstash(&mut self, id: u32) -> Vec<f32> {
        match self.scene.furnishing(id) {
            Some(f) if f.stashed => {}
            _ => return Vec::new(),
        }
        self.checkpoint();
        self.scene.apply(Command::SetStashed { id, stashed: false });
        self.selected = Some(id);
        // Re-seat at a fresh drop point but preserve the rotation the user had set —
        // re-seating alone would reface the item to whatever wall it lands near.
        let yaw = self.furnishing(id).placement.yaw;
        let drop = self.drop_target();
        self.reseat(id, drop);
        self.scene.apply(Command::SetYaw { id, yaw });
        self.transform(id)
    }

    /// Ids of furnishings set aside in the bullpen, in stash order — the web maps each
    /// to its catalog entry to draw a tray card.
    pub fn stashed_ids(&self) -> Vec<u32> {
        self.scene.stashed_furnishings().map(|f| f.id).collect()
    }

    /// Ids of placed furnishings whose floor footprints overlap another item, ascending.
    /// The document decides what counts as crowded; the web layer only flags what it is
    /// handed. Recompute after any edit that moves, turns, resizes or adds an item.
    pub fn crowded_ids(&self) -> Vec<u32> {
        crowded(&self.scene)
    }

    /// Select a furnishing by id (no-op if it doesn't exist). Selection is UI state,
    /// so it is not checkpointed.
    pub fn select(&mut self, id: u32) {
        if self.scene.furnishing(id).is_some() {
            self.selected = Some(id);
            self.selected_opening = None;
        }
    }

    pub fn deselect(&mut self) {
        self.selected = None;
    }

    /// The selected furnishing id, or -1 if nothing is selected.
    pub fn selected_id(&self) -> i32 {
        self.selected.map_or(-1, |id| id as i32)
    }

    /// Ids of furnishings placed in the room, in placement order — the web iterates
    /// these to sync meshes. Excludes bullpen (stashed) items, which don't render.
    pub fn furnishing_ids(&self) -> Vec<u32> {
        self.scene.placed_furnishings().map(|f| f.id).collect()
    }

    /// Transform of a specific furnishing (empty if it doesn't exist). Used to re-place
    /// meshes after a rebuild or undo.
    pub fn furnishing_transform(&self, id: u32) -> Vec<f32> {
        match self.scene.furnishing(id) {
            Some(f) => transform_of(f),
            None => Vec::new(),
        }
    }

    // --- Openings (doors & windows) ---------------------------------------
    // Openings are cut into the wall mesh itself, so every op that changes one rebuilds
    // wall geometry; the web re-uploads it. Positioning stays in Rust (`seat_opening`).

    /// Add a door (`kind == 0`) or window (`kind == 1`) to `wall_id`, snapped so its
    /// centre sits at the projection of the world point `(x, z)` onto that wall and the
    /// whole opening stays within the wall. Selects it. Returns the new id, or -1 if the
    /// wall doesn't exist.
    pub fn add_opening(&mut self, kind: u8, wall_id: u32, x: f32, z: f32) -> i32 {
        let Some(wall) = self.scene.wall(wall_id).copied() else {
            return -1;
        };
        let (opening_kind, (width, height, sill)) = match kind {
            0 => (OpeningKind::Door, DOOR_SIZE),
            _ => (OpeningKind::Window, WINDOW_SIZE),
        };
        self.checkpoint();
        let id = self.next_opening_id;
        self.next_opening_id += 1;
        let along = seat_opening(&wall, Vec2::new(x, z), width);
        self.scene.apply(Command::AddOpening(Opening {
            id,
            wall: wall_id,
            kind: opening_kind,
            along,
            width,
            height: height.min(wall.height),
            sill,
        }));
        self.selected_opening = Some(id);
        self.rebuild();
        id as i32
    }

    /// All opening ids, in insertion order — the web iterates these to sync proxies.
    pub fn opening_ids(&self) -> Vec<u32> {
        self.scene.openings.iter().map(|o| o.id).collect()
    }

    /// Everything the renderer needs to place one opening's glass/selection proxy, in a
    /// coarse array: `[cx, cy, cz, yaw, width, height, thickness, kind]`. `kind` is 0 for
    /// a door, 1 for a window. Empty if the opening (or its wall) is gone.
    pub fn opening_transform(&self, id: u32) -> Vec<f32> {
        let Some(o) = self.scene.opening(id) else {
            return Vec::new();
        };
        let Some(wall) = self.scene.wall(o.wall) else {
            return Vec::new();
        };
        let centre = wall.point_at(o.along);
        let n = wall.normal();
        vec![
            centre.x,
            o.sill + o.height * 0.5,
            centre.y,
            n.x.atan2(n.y),
            o.width,
            o.height,
            wall.thickness,
            matches!(o.kind, OpeningKind::Window) as u8 as f32,
        ]
    }

    /// Select an opening by id (no-op if it doesn't exist). Clears any furnishing
    /// selection so the two never fight over the keyboard.
    pub fn select_opening(&mut self, id: u32) {
        if self.scene.opening(id).is_some() {
            self.selected_opening = Some(id);
            self.selected = None;
        }
    }

    pub fn deselect_opening(&mut self) {
        self.selected_opening = None;
    }

    /// The selected opening id, or -1 if none is selected.
    pub fn selected_opening_id(&self) -> i32 {
        self.selected_opening.map_or(-1, |id| id as i32)
    }

    /// Remove the selected opening (if any). Returns true if one was removed.
    pub fn remove_selected_opening(&mut self) -> bool {
        match self.live_opening() {
            Some(id) => {
                self.checkpoint();
                self.scene.apply(Command::RemoveOpening(id));
                self.selected_opening = None;
                self.rebuild();
                true
            }
            None => false,
        }
    }

    /// Slide the selected opening along its wall so its centre tracks the world point
    /// `(x, z)`, re-clamped to stay inside the wall. Rebuilds wall geometry. Returns true
    /// if it moved. The web checkpoints once at the drag's start, as with furniture.
    pub fn drag_opening(&mut self, x: f32, z: f32) -> bool {
        let Some(id) = self.live_opening() else {
            return false;
        };
        let o = *self.scene.opening(id).expect("live opening exists");
        let Some(wall) = self.scene.wall(o.wall).copied() else {
            return false;
        };
        let along = seat_opening(&wall, Vec2::new(x, z), o.width);
        self.scene.apply(Command::MoveOpening { id, along });
        self.rebuild();
        true
    }

    /// Set one real-world dimension of the selected opening in inches: axis 0 = width,
    /// 1 = height, 2 = sill. Re-clamps position (a wider opening may need re-centring) and
    /// caps against the wall height. Rebuilds geometry. Returns true if applied.
    pub fn set_opening_dimension(&mut self, axis: u8, inches: f32) -> bool {
        let Some(id) = self.live_opening() else {
            return false;
        };
        let o = *self.scene.opening(id).expect("live opening exists");
        let Some(wall) = self.scene.wall(o.wall).copied() else {
            return false;
        };
        self.checkpoint();
        let metres = (inches / M_TO_IN).max(MIN_DIMENSION_M);
        let (mut width, mut height, mut sill) = (o.width, o.height, o.sill);
        match axis {
            0 => width = metres,
            1 => height = metres.min(wall.height),
            _ => sill = metres.min(wall.height - MIN_DIMENSION_M),
        }
        // Keep the opening inside the wall vertically as well as along its length.
        height = height.min(wall.height - sill);
        let along = seat_opening(&wall, wall.point_at(o.along), width);
        self.scene.apply(Command::ResizeOpening {
            id,
            width,
            height,
            sill,
        });
        self.scene.apply(Command::MoveOpening { id, along });
        self.rebuild();
        true
    }

    /// Selected opening's size in inches as `[width, height, sill]`, or empty if none.
    pub fn opening_dimensions(&self) -> Vec<f32> {
        match self.live_opening().and_then(|id| self.scene.opening(id)) {
            Some(o) => vec![o.width * M_TO_IN, o.height * M_TO_IN, o.sill * M_TO_IN],
            None => Vec::new(),
        }
    }

    /// The selected opening, but only if it still exists — an undo can drop it while
    /// `selected_opening` still points at it, and the ops must not touch a ghost.
    fn live_opening(&self) -> Option<OpeningId> {
        self.selected_opening
            .filter(|id| self.scene.opening(*id).is_some())
    }

    // --- Selected-furnishing manipulation ---------------------------------
    // Each op targets the selected furnishing and returns its transform, or an empty
    // array if nothing is selected (or it vanished under an undo).

    /// The selected id, but only if it still exists — a furnishing can vanish under an
    /// undo while `selected` still points at it, and the ops must not touch a ghost.
    fn live_selection(&self) -> Option<FurnishingId> {
        self.selected
            .filter(|id| self.scene.furnishing(*id).is_some())
    }

    /// Drag hot path, called once per pointer move: cursor metres in, transform out.
    /// Orientation is preserved: re-seating snaps the position flush to a wall but
    /// keeps whatever yaw the user rotated to, rather than re-orienting to the wall.
    pub fn drag(&mut self, x: f32, z: f32) -> Vec<f32> {
        let Some(id) = self.live_selection() else {
            return Vec::new();
        };
        let yaw = self.furnishing(id).placement.yaw;
        self.reseat(id, Vec2::new(x, z));
        self.scene.apply(Command::SetYaw { id, yaw });
        self.transform(id)
    }

    /// Rotate by `steps` arrow presses (positive = counter-clockwise). Spins in
    /// place; a later drag re-snaps the position but keeps this rotation.
    pub fn rotate(&mut self, steps: f32) -> Vec<f32> {
        let Some(id) = self.live_selection() else {
            return Vec::new();
        };
        self.checkpoint();
        let yaw = self.furnishing(id).placement.yaw + steps * ROTATE_STEP;
        self.scene.apply(Command::SetYaw { id, yaw });
        self.transform(id)
    }

    /// Uniform scale nudge: one `↑` press is `presses = 1`, one `↓` is `-1`.
    pub fn scale_by(&mut self, presses: f32) -> Vec<f32> {
        let Some(id) = self.live_selection() else {
            return Vec::new();
        };
        self.checkpoint();
        let factor = SCALE_STEP.powf(presses);
        let scale = self.furnishing(id).scale * factor;
        self.set_scale(id, scale)
    }

    /// Set one real-world dimension in inches: axis 0 = width, 1 = depth, 2 = height.
    pub fn set_dimension(&mut self, axis: u8, inches: f32) -> Vec<f32> {
        let Some(id) = self.live_selection() else {
            return Vec::new();
        };
        self.checkpoint();
        let metres = (inches / M_TO_IN).max(MIN_DIMENSION_M);
        let f = self.furnishing(id);
        let mut scale = f.scale;
        match axis {
            0 => scale.x = metres / f.asset.extent.x,
            1 => scale.z = metres / f.asset.extent.z,
            _ => scale.y = metres / f.asset.extent.y,
        }
        self.set_scale(id, scale)
    }

    /// Restore the selected asset to its catalog proportions (unit scale on every axis).
    pub fn reset_scale(&mut self) -> Vec<f32> {
        let Some(id) = self.live_selection() else {
            return Vec::new();
        };
        self.checkpoint();
        self.set_scale(id, Vec3::ONE)
    }

    /// Selected asset's current real-world size in inches as `[width, depth, height]`,
    /// or empty if nothing is selected.
    pub fn dimensions(&self) -> Vec<f32> {
        let Some(id) = self.live_selection() else {
            return Vec::new();
        };
        let f = self.furnishing(id);
        let d = f.asset.extent * f.scale * M_TO_IN;
        vec![d.x, d.z, d.y]
    }

    fn furnishing(&self, id: FurnishingId) -> Furnishing {
        *self.scene.furnishing(id).expect("furnishing id exists")
    }

    /// Effective footprint the constraint solver sees once scale is applied.
    fn scaled_asset(&self, id: FurnishingId) -> Asset {
        let f = self.furnishing(id);
        Asset {
            extent: f.asset.extent * f.scale,
        }
    }

    /// Apply a new scale, then re-seat at the current position so a resized asset
    /// stays flush against its wall instead of clipping into or floating off it.
    /// Orientation is preserved: scaling never re-orients an asset the user rotated.
    fn set_scale(&mut self, id: FurnishingId, scale: Vec3) -> Vec<f32> {
        let yaw = self.furnishing(id).placement.yaw;
        self.scene.apply(Command::SetScale { id, scale });
        let p = self.furnishing(id).placement.position;
        self.reseat(id, Vec2::new(p.x, p.z));
        self.scene.apply(Command::SetYaw { id, yaw });
        self.transform(id)
    }

    /// Resolve and apply a placement for a ground-plane target, using the scaled footprint.
    fn reseat(&mut self, id: FurnishingId, target: Vec2) -> Vec<f32> {
        let placement = resolve_placement(&self.scene, &self.scaled_asset(id), target, SNAP_RADIUS);
        self.scene.apply(Command::Reposition { id, placement });
        self.transform(id)
    }

    /// Centre of the room footprint (origin if there is no room).
    fn room_centre(&self) -> Vec2 {
        let outline = &self.scene.floor_outline;
        if outline.is_empty() {
            Vec2::ZERO
        } else {
            outline.iter().copied().sum::<Vec2>() / outline.len() as f32
        }
    }

    fn transform(&self, id: FurnishingId) -> Vec<f32> {
        transform_of(&self.furnishing(id))
    }
}

/// Everything the renderer needs to draw one furnishing, in one coarse array:
/// `[x, up, z, yaw, scale_x, scale_y, scale_z, snapped]`.
fn transform_of(f: &Furnishing) -> Vec<f32> {
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

impl Default for Document {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A representative catalog extent (the sheen armchair), for tests that need one.
    fn chair(doc: &mut Document) -> u32 {
        doc.add_furnishing(0.83, 0.69, 0.57)
    }

    #[test]
    fn undo_reverts_actions_one_at_a_time() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        // A generated rectangle opens toward the camera: two far walls, full floor.
        assert_eq!(doc.wall_count(), 2);

        let id = chair(&mut doc);
        doc.rotate(1.0);
        assert!(
            doc.furnishing_transform(id)[3].abs() > 0.0,
            "rotate should change yaw"
        );

        // Undo the rotate: yaw back to 0, furnishing + room intact.
        assert!(doc.undo());
        assert_eq!(doc.furnishing_transform(id)[3], 0.0);
        assert_eq!(doc.furnishing_ids(), vec![id]);
        assert_eq!(doc.wall_count(), 2);

        // Undo the placement: furnishing gone, room intact.
        assert!(doc.undo());
        assert!(doc.furnishing_ids().is_empty());
        assert_eq!(doc.wall_count(), 2);

        // Undo the room creation: back to an empty scene.
        assert!(doc.undo());
        assert_eq!(doc.wall_count(), 0);

        // Nothing left to undo.
        assert!(!doc.undo());
    }

    /// The wall finish rides the same command funnel as everything else, so undo covers
    /// it for free — and picking a wall colour must not disturb the floor's.
    #[test]
    fn wall_finish_is_selectable_and_undoable_without_touching_the_floor() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        assert_eq!(doc.wall_material(), 0);

        doc.set_floor_material(2);
        assert_eq!(doc.set_wall_material(3), 3);
        assert_eq!(doc.floor_material(), 2, "wall finish must not move the floor");

        // Undo the wall finish only: walls revert, the floor keeps its choice.
        assert!(doc.undo());
        assert_eq!(doc.wall_material(), 0);
        assert_eq!(doc.floor_material(), 2);
        assert_eq!(doc.wall_count(), 2, "the room is untouched by a finish change");
    }

    /// Out-of-range ordinals clamp to the last variant rather than panicking, matching
    /// `set_floor_material`'s catch-all arm.
    #[test]
    fn out_of_range_finish_and_lighting_ordinals_clamp() {
        let mut doc = Document::new();
        assert_eq!(doc.set_wall_material(99), 4);
        assert_eq!(doc.set_lighting(99), 3);
    }

    /// Lighting rides the same funnel, so undo covers it — and it is independent of
    /// both finishes.
    #[test]
    fn lighting_is_selectable_and_undoable_without_touching_the_finishes() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        assert_eq!(doc.lighting(), 0);

        doc.set_floor_material(2);
        doc.set_wall_material(3);
        assert_eq!(doc.set_lighting(2), 2);
        assert_eq!(doc.floor_material(), 2);
        assert_eq!(doc.wall_material(), 3);

        // Undo the lighting only: mood reverts, both finishes keep their choice.
        assert!(doc.undo());
        assert_eq!(doc.lighting(), 0);
        assert_eq!(doc.floor_material(), 2);
        assert_eq!(doc.wall_material(), 3);
    }

    #[test]
    fn ops_after_undoing_a_selected_furnishing_away_are_safe_no_ops() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let id = chair(&mut doc);
        // Undo the placement; `selected` still points at the now-gone furnishing.
        assert!(doc.undo());
        assert_eq!(doc.selected_id(), id as i32);
        // These must not panic — they should no-op to an empty transform.
        assert!(doc.drag(1.0, 1.0).is_empty());
        assert!(doc.rotate(1.0).is_empty());
        assert!(doc.scale_by(1.0).is_empty());
        assert!(doc.dimensions().is_empty());
    }

    #[test]
    fn a_rectangle_opens_with_two_walls_but_a_full_floor() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        // Only the two far walls (meeting at the origin corner) are raised…
        assert_eq!(doc.wall_count(), 2);
        // …but the floor keeps the full 4×3 rectangular footprint.
        assert_eq!(doc.room_bounds(), vec![0.0, 0.0, 4.0, 3.0]);
    }

    // --- Resizing keeps what the user drew ---------------------------------

    #[test]
    fn resizing_a_room_keeps_the_walls_the_user_added() {
        // The bug this fixes: `set_rectangle` rebuilt the wall list from scratch, so
        // resizing silently destroyed every wall someone had added by hand.
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        doc.add_wall(4.0, 0.0, 4.0, 3.0);
        assert_eq!(doc.wall_count(), 3);

        doc.set_rectangle(5.0, 3.0);

        // Two regenerated walls plus the hand-drawn one, which is still where it was.
        assert_eq!(doc.wall_count(), 3);
        let segments = doc.wall_segments();
        assert!(
            segments.chunks(4).any(|s| s == [4.0, 0.0, 4.0, 3.0]),
            "the hand-added wall is gone: {segments:?}"
        );
        assert_eq!(doc.room_bounds(), vec![0.0, 0.0, 5.0, 3.0]);
    }

    #[test]
    fn resizing_keeps_a_door_on_a_hand_added_wall() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        doc.add_wall(4.0, 0.0, 4.0, 3.0);
        let drawn = *doc.wall_ids().last().unwrap();
        assert!(doc.add_opening(0, drawn, 4.0, 1.5) >= 0);
        assert_eq!(doc.opening_ids().len(), 1);

        doc.set_rectangle(5.0, 3.0);

        // Losing the door while keeping its wall would be a worse bug than the original.
        assert_eq!(doc.opening_ids().len(), 1, "the surviving wall lost its door");
    }

    #[test]
    fn wall_ids_never_collide_after_a_regenerate() {
        // Two allocators used to disagree — `build_room` numbered from the segment index
        // while `add_wall` took `max + 1` — and only the wholesale wipe hid it. This is
        // the exact sequence that produced two walls sharing an id, which `wall(id)`,
        // `openings_on(id)` and `delete_wall(id)` would all then resolve to the wrong one.
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0); // ids 0, 1
        doc.delete_wall(doc.wall_ids()[1]); // drop one, so max() falls back
        doc.add_wall(4.0, 0.0, 4.0, 3.0); // used to take max + 1 = 1
        doc.set_rectangle(5.0, 3.0); // used to regenerate as 0, 1

        let mut ids = doc.wall_ids();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate wall ids: {ids:?}");
    }

    #[test]
    fn a_hand_added_wall_survives_repeated_resizes() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        doc.add_wall(4.0, 0.0, 4.0, 3.0);
        for width in [5.0, 6.0, 3.5, 4.0] {
            doc.set_rectangle(width, 3.0);
        }
        // Still exactly one drawn wall and two generated ones — regenerating neither
        // deletes the drawn wall nor accumulates copies of the generated ones.
        assert_eq!(doc.wall_count(), 3);
    }

    #[test]
    fn undo_puts_back_a_wall_that_a_resize_replaced() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        doc.add_wall(4.0, 0.0, 4.0, 3.0);
        let before = doc.wall_segments();
        doc.set_rectangle(9.0, 9.0);
        assert_ne!(doc.wall_segments(), before);
        assert!(doc.undo());
        assert_eq!(doc.wall_segments(), before);
    }

    #[test]
    fn the_default_rectangle_has_a_floor_but_encloses_no_room() {
        // The two distinctions this binding exists to make. `has_room` is about the
        // floor, which a fresh rectangle always has; `detected_room_count` is about
        // what the walls enclose, and two walls in an L enclose nothing.
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        assert!(doc.has_room());
        assert_eq!(doc.detected_room_count(), 0);
        assert!(doc.detected_room_areas().is_empty());
        assert!(doc.detected_room_outlines().is_empty());
    }

    #[test]
    fn closing_the_open_sides_by_hand_makes_the_room_detectable() {
        // Add back the two walls `set_rectangle` leaves out and the loop closes.
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        doc.add_wall(4.0, 0.0, 4.0, 3.0);
        doc.add_wall(4.0, 3.0, 0.0, 3.0);
        assert_eq!(doc.detected_room_count(), 1);
        assert_eq!(doc.detected_room_corner_counts(), vec![4]);
        assert!((doc.detected_room_areas()[0] - 12.0).abs() < 1e-4);
        // Flat [x, z, …] over the four centreline corners.
        assert_eq!(doc.detected_room_outlines().len(), 8);
        // Deleting one of them opens the loop again.
        doc.delete_wall(doc.wall_ids()[0]);
        assert_eq!(doc.detected_room_count(), 0);
        // …and the floor is untouched by any of it.
        assert_eq!(doc.room_bounds(), vec![0.0, 0.0, 4.0, 3.0]);
    }

    #[test]
    fn a_traced_polygon_encloses_the_room_it_traced() {
        let mut doc = Document::new();
        doc.set_polygon(&[0.0, 0.0, 4.0, 0.0, 4.0, 2.0, 2.0, 2.0, 2.0, 4.0, 0.0, 4.0]);
        assert_eq!(doc.detected_room_count(), 1);
        assert_eq!(doc.detected_room_corner_counts(), vec![6]);
        // The L is 4×2 + 2×2 = 12, not its 4×4 bounding box.
        assert!((doc.detected_room_areas()[0] - 12.0).abs() < 1e-4);
    }

    #[test]
    fn a_traced_polygon_raises_every_wall() {
        let mut doc = Document::new();
        // A four-corner traced loop keeps all four walls — the two-wall default is
        // only for the generated rectangle.
        doc.set_polygon(&[0.0, 0.0, 4.0, 0.0, 4.0, 3.0, 0.0, 3.0]);
        assert_eq!(doc.wall_count(), 4);
    }

    #[test]
    fn undo_restores_a_deleted_wall() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        doc.delete_wall(0);
        assert_eq!(doc.wall_count(), 1);
        assert!(doc.undo());
        assert_eq!(doc.wall_count(), 2);
    }

    #[test]
    fn a_drag_is_one_undo_step_via_a_single_checkpoint() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let id = chair(&mut doc);
        let start = doc.furnishing_transform(id);
        // The web checkpoints once at the first move, then streams positions.
        doc.checkpoint();
        doc.drag(1.4, 1.0);
        doc.drag(1.2, 1.0);
        doc.drag(1.0, 1.0);
        assert_ne!(
            doc.furnishing_transform(id)[0],
            start[0],
            "drag should move the furnishing"
        );
        // One undo returns to the pre-drag position, not through each move.
        assert!(doc.undo());
        assert_eq!(doc.furnishing_transform(id)[0], start[0]);
        assert_eq!(doc.furnishing_transform(id)[2], start[2]);
    }

    #[test]
    fn dragging_a_rotated_furnishing_keeps_its_rotation() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let id = chair(&mut doc);
        doc.rotate(3.0);
        let yaw = doc.furnishing_transform(id)[3];
        assert!(yaw.abs() > 0.0, "rotate should give the chair a non-zero yaw");
        // Grab and move it out in open floor: the position changes but the yaw the
        // user rotated to must survive, rather than snapping back to the default.
        doc.checkpoint();
        doc.drag(2.0, 1.5);
        assert_eq!(
            doc.furnishing_transform(id)[3],
            yaw,
            "a drag must hold the rotation, not reset it"
        );
    }

    #[test]
    fn add_furnishing_hands_out_unique_ids_and_selects_the_new_one() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let a = doc.add_furnishing(0.8, 0.7, 0.6);
        let b = doc.add_furnishing(1.0, 0.5, 1.0);
        assert_ne!(a, b);
        assert_eq!(doc.furnishing_ids(), vec![a, b]);
        assert_eq!(doc.selected_id(), b as i32);
        // Removing the selected one clears selection and drops it from the list.
        assert!(doc.remove_selected());
        assert_eq!(doc.furnishing_ids(), vec![a]);
        assert_eq!(doc.selected_id(), -1);
    }

    #[test]
    fn stashing_pulls_a_furnishing_from_the_room_into_the_bullpen_and_back() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let id = chair(&mut doc);
        // Resize it so we can prove the size survives the round-trip.
        doc.set_dimension(0, 40.0); // 40" wide
        let width_before = doc.dimensions()[0];

        // Set aside: gone from the room, present in the bullpen, selection cleared.
        assert_eq!(doc.stash_selected(), id as i32);
        assert!(doc.furnishing_ids().is_empty());
        assert_eq!(doc.stashed_ids(), vec![id]);
        assert_eq!(doc.selected_id(), -1);

        // Re-import: back in the room, out of the bullpen, re-selected, same width.
        let t = doc.unstash(id);
        assert_eq!(t.len(), 8);
        assert_eq!(doc.furnishing_ids(), vec![id]);
        assert!(doc.stashed_ids().is_empty());
        assert_eq!(doc.selected_id(), id as i32);
        assert!((doc.dimensions()[0] - width_before).abs() < 1e-3, "width should survive");
    }

    #[test]
    fn stashing_is_undoable_and_bullpen_items_can_be_discarded() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let id = chair(&mut doc);
        doc.stash_selected();
        assert_eq!(doc.stashed_ids(), vec![id]);

        // Undo returns it to the room.
        assert!(doc.undo());
        assert!(doc.stashed_ids().is_empty());
        assert_eq!(doc.furnishing_ids(), vec![id]);

        // Discard a stashed item for good.
        doc.select(id);
        doc.stash_selected();
        assert!(doc.remove_furnishing(id));
        assert!(doc.stashed_ids().is_empty());
        assert!(doc.furnishing_ids().is_empty());
        assert!(doc.furnishing_transform(id).is_empty());
    }

    #[test]
    fn unstash_rejects_ids_that_are_not_stashed() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let id = chair(&mut doc); // placed, not stashed
        assert!(doc.unstash(id).is_empty());
        assert!(doc.unstash(999).is_empty());
    }

    #[test]
    fn add_opening_snaps_onto_the_wall_and_cuts_it() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let solid_verts = doc.wall_positions().len();

        // Wall 1 runs along +X from the origin; a door dropped near its far end snaps in.
        let id = doc.add_opening(0, 1, 3.6, 0.0);
        assert_eq!(id, 1);
        assert_eq!(doc.selected_opening_id(), 1);
        assert_eq!(doc.opening_ids(), vec![1]);
        // Cutting the wall changes its geometry (more strips + reveals than a solid wall).
        assert_ne!(doc.wall_positions().len(), solid_verts);

        // The transform centre sits on the wall centreline, clamped to fit (0.9 wide, so
        // its centre can reach at most 4.0 - 0.45 = 3.55).
        let t = doc.opening_transform(1);
        assert!((t[0] - 3.55).abs() < 1e-4, "centre x {}", t[0]);
        assert_eq!(t[2], 0.0); // on the z=0 wall
        assert_eq!(t[7], 0.0); // door flag
    }

    #[test]
    fn add_opening_to_a_missing_wall_is_rejected() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        assert_eq!(doc.add_opening(0, 99, 1.0, 0.0), -1);
        assert!(doc.opening_ids().is_empty());
    }

    #[test]
    fn window_carries_a_sill_and_reports_its_dimensions() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let id = doc.add_opening(1, 0, 2.0, 0.0) as u32;
        assert_eq!(doc.opening_transform(id)[7], 1.0); // window flag
        let dims = doc.opening_dimensions(); // inches: width, height, sill
        assert!((dims[2] / 39.37 - 0.9).abs() < 1e-3, "sill {}", dims[2]);

        // Narrowing it below the wall keeps it seated; widening past the wall re-centres.
        assert!(doc.set_opening_dimension(0, 12.0)); // 12" wide
        assert!((doc.opening_dimensions()[0] - 12.0).abs() < 1e-2);
    }

    #[test]
    fn dragging_a_window_slides_it_along_the_wall() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let id = doc.add_opening(1, 1, 1.0, 0.0) as u32;
        let x0 = doc.opening_transform(id)[0];
        doc.checkpoint();
        assert!(doc.drag_opening(3.0, 0.0));
        let x1 = doc.opening_transform(id)[0];
        assert!(x1 > x0, "window should slide towards +X: {x0} -> {x1}");
        // One undo returns it to where the drag began.
        assert!(doc.undo());
        assert!((doc.opening_transform(id)[0] - x0).abs() < 1e-4);
    }

    #[test]
    fn deleting_a_wall_removes_its_openings_and_undo_restores_both() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        doc.add_opening(0, 1, 2.0, 0.0);
        assert_eq!(doc.opening_ids().len(), 1);
        doc.delete_wall(1);
        assert!(doc.opening_ids().is_empty(), "opening should die with its wall");
        assert!(doc.undo());
        assert_eq!(doc.wall_count(), 2);
        assert_eq!(doc.opening_ids().len(), 1, "undo restores the wall's opening");
    }

    #[test]
    fn opening_ops_after_undoing_it_away_are_safe_no_ops() {
        let mut doc = Document::new();
        doc.set_rectangle(4.0, 3.0);
        let id = doc.add_opening(0, 0, 2.0, 0.0) as u32;
        assert!(doc.undo()); // opening gone; selected_opening still points at it
        assert_eq!(doc.selected_opening_id(), id as i32);
        assert!(!doc.drag_opening(1.0, 0.0));
        assert!(!doc.remove_selected_opening());
        assert!(!doc.set_opening_dimension(0, 40.0));
        assert!(doc.opening_dimensions().is_empty());
    }

    #[test]
    fn the_staggered_drop_lands_the_second_chair_crowding_the_first() {
        let mut doc = Document::new();
        doc.set_rectangle(6.0, 5.0);

        let first = chair(&mut doc);
        assert!(
            doc.crowded_ids().is_empty(),
            "one chair alone has nothing to crowd"
        );

        // Placement only staggers by 0.3 m a step, which is well inside a 0.83 m chair —
        // exactly the "items can freely overlap" gap this query exists to surface.
        let second = chair(&mut doc);
        assert_eq!(doc.crowded_ids(), vec![first, second]);

        // Drag the second one clear and the warning goes with it. Well inside the room,
        // so this tests clearance rather than accidentally testing wall snapping.
        doc.drag(1.5, 1.5);
        assert!(doc.crowded_ids().is_empty());
    }

    #[test]
    fn setting_a_crowding_chair_aside_clears_the_room() {
        let mut doc = Document::new();
        doc.set_rectangle(6.0, 5.0);
        let first = chair(&mut doc);
        let second = chair(&mut doc);
        assert_eq!(doc.crowded_ids(), vec![first, second]);

        assert_eq!(doc.stash_selected(), second as i32);
        assert!(
            doc.crowded_ids().is_empty(),
            "a bullpen item is not in the room to crowd it"
        );

        // Re-import lands clear rather than back on top: `unstash` un-flags the item
        // before it reads the drop point, so the stagger counts it in and steps one
        // further out (0.6 m) than the 0.57 m-deep chair it was overlapping.
        doc.unstash(second);
        assert!(doc.crowded_ids().is_empty());
    }

    #[test]
    fn crowding_follows_undo_because_it_is_read_from_the_document() {
        let mut doc = Document::new();
        doc.set_rectangle(6.0, 5.0);
        let first = chair(&mut doc);
        let second = chair(&mut doc);
        // The web checkpoints once at the drag's start, then streams positions.
        doc.checkpoint();
        doc.drag(1.5, 1.5);
        assert!(doc.crowded_ids().is_empty());

        // Undo the drag and the chairs are back on top of each other. Nothing caches
        // the warning — it is re-read from the document, so it rewinds with it.
        assert!(doc.undo());
        assert_eq!(doc.crowded_ids(), vec![first, second]);
    }
}
