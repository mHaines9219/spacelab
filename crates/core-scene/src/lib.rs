//! Parametric scene document: walls, openings, furnishings, and the command layer all mutations flow through.

use glam::{Vec2, Vec3};
use serde::{Deserialize, Serialize};

pub type WallId = u32;
pub type FurnishingId = u32;
pub type OpeningId = u32;

/// Who put a wall there. The distinction exists so regenerating the room — resizing a
/// rectangle, say — can replace what the app generated without destroying what the user
/// drew. See [`Command::ReplaceGeneratedWalls`].
///
/// `Drawn` is the default on purpose, and it is the safe direction: a wall of unknown
/// provenance survives a regenerate. The opposite default would silently delete a user's
/// walls the first time they resized a room — which is the bug this type exists to fix.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WallOrigin {
    /// Raised by the app from a rectangle or a traced outline. Regenerating replaces it.
    Generated,
    /// Added by hand in the 3D view. Regenerating leaves it alone.
    #[default]
    Drawn,
}

/// Ground-plane coordinates are metres as `Vec2(x, z)`; `Vec3` is `(x, up, z)`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Wall {
    pub id: WallId,
    pub start: Vec2,
    pub end: Vec2,
    pub thickness: f32,
    pub height: f32,
    pub origin: WallOrigin,
}

impl Wall {
    pub fn length(&self) -> f32 {
        self.start.distance(self.end)
    }

    pub fn direction(&self) -> Vec2 {
        (self.end - self.start) / self.length()
    }

    pub fn normal(&self) -> Vec2 {
        let d = self.direction();
        Vec2::new(-d.y, d.x)
    }

    pub fn project(&self, p: Vec2) -> f32 {
        (p - self.start)
            .dot(self.direction())
            .clamp(0.0, self.length())
    }

    pub fn point_at(&self, along: f32) -> Vec2 {
        self.start + self.direction() * along
    }

    /// Unit normal pointing towards the side of the wall `p` lies on.
    pub fn facing(&self, p: Vec2) -> Vec2 {
        let n = self.normal();
        if (p - self.point_at(self.project(p))).dot(n) < 0.0 {
            -n
        } else {
            n
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Default, Serialize, Deserialize)]
pub enum Anchor {
    #[default]
    Floor,
    AgainstWall(WallId),
}

/// A door or window. Ordinal matches the flag the wasm boundary exchanges with the web.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum OpeningKind {
    #[default]
    Door,
    Window,
}

/// A parametric cut *owned by* a wall: a door or window. Position is a distance along
/// the wall centreline, so moving or resizing the wall carries the opening with it —
/// the opening never stores world coordinates of its own.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Opening {
    pub id: OpeningId,
    pub wall: WallId,
    pub kind: OpeningKind,
    /// Centre of the opening measured along the wall centreline from `wall.start`, metres.
    pub along: f32,
    pub width: f32,
    pub height: f32,
    /// Sill height above the floor, metres. Doors sit on the floor (`sill == 0`).
    pub sill: f32,
}

impl Opening {
    /// Half-open horizontal span `[start, end]` along the wall centreline.
    pub fn span(&self) -> (f32, f32) {
        (self.along - self.width * 0.5, self.along + self.width * 0.5)
    }

    /// Top of the opening above the floor, metres.
    pub fn head(&self) -> f32 {
        self.sill + self.height
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Placement {
    pub position: Vec3,
    pub yaw: f32,
    pub anchor: Anchor,
}

/// Catalog metadata the constraint solver needs. `extent` is width/height/depth in
/// metres, with local `+Z` as the asset's front.
// Not `Copy`: `asset_id` is a `String`. Cheap to clone at this scale, and the document
// owning which catalog entry a furnishing is beats saving a pointer-copy.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Asset {
    pub extent: Vec3,
    /// Which catalog entry this is, e.g. `"couch-medium"`. The document owns the
    /// association because the room is not described by boxes of the right size — it is
    /// described by *which things* are in it. Before this field the mapping lived only in
    /// a JavaScript `Map`, so a saved room restored as correctly-sized invisible boxes.
    pub asset_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Furnishing {
    pub id: FurnishingId,
    pub asset: Asset,
    pub placement: Placement,
    /// Per-axis multiplier on `asset.extent`, in the asset's local frame
    /// (x width, y height, z depth). `Vec3::ONE` is the catalog size.
    pub scale: Vec3,
    /// Set aside in the "bullpen": still owned by the document (so it keeps its
    /// scale, yaw, and identity, and rides undo), but pulled out of the room —
    /// not rendered or placed until it is re-imported. See [`Command::SetStashed`].
    pub stashed: bool,
}

/// The floor's surface finish. The document owns the *choice*; the renderer owns
/// what each finish looks like (which texture, how it tiles). Ordinal matches the
/// index the wasm boundary exchanges with the web layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum FloorMaterial {
    #[default]
    WoodLight,
    WoodDark,
    Tile,
    Concrete,
}

/// The walls' paint finish. Same split as [`FloorMaterial`]: the document owns the
/// *choice*, the renderer owns what each finish looks like (here, a tint over the one
/// shared matte plaster set — walls differ by colour, not by texture). Ordinal matches
/// the index the wasm boundary exchanges with the web layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WallMaterial {
    /// The fixed off-white the walls carried before finishes were selectable, so an
    /// existing room opens looking exactly as it did.
    #[default]
    WarmWhite,
    CoolGrey,
    Greige,
    Sage,
    Clay,
}

/// The room's lighting mood. Same split again: the document owns the *choice*, the
/// renderer owns what each preset means (sun colour, angle and intensity, how much the
/// environment fills the shadows). Ordinal matches the index the wasm boundary
/// exchanges with the web layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum LightingPreset {
    /// The high neutral sun the scene carried before lighting was selectable.
    #[default]
    Noon,
    Morning,
    Evening,
    Overcast,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Scene {
    pub walls: Vec<Wall>,
    /// Doors and windows, each owned by a wall (`Opening::wall`). Kept in a flat list
    /// rather than on the walls so the `Copy` `Wall` stays cheap and deleting a wall is
    /// a single retain over both lists.
    pub openings: Vec<Opening>,
    pub furnishings: Vec<Furnishing>,
    pub floor_material: FloorMaterial,
    pub wall_material: WallMaterial,
    pub lighting: LightingPreset,
    /// The room's floor footprint (metres, in loop order). Owned by the document
    /// independently of the walls, so removing a wall never reshapes the floor.
    pub floor_outline: Vec<Vec2>,
    /// Bumped by every [`Scene::apply`], so a caller can tell "did anything change?"
    /// by watching one integer rather than instrumenting every mutation site — the
    /// 32nd site is the one that gets forgotten.
    ///
    /// It lives on `Scene` because `apply` is the only funnel that sees every mutation,
    /// and `apply` can only reach `Scene`. That means undo *rewinds* it, which would let
    /// a rewind-then-edit reproduce a revision an autosave had already seen and skip the
    /// write. `Document::replace_scene` is what closes that: every wholesale swap
    /// advances past the restored value. **`Scene` may rewind; this may only advance.**
    ///
    /// **Not persisted.** It is session-local change detection, not part of the room —
    /// the same room saved after three edits or after three hundred is the same room, and
    /// a format where those differ is neither diffable nor round-trip testable. On load
    /// the counter advances from *this* session's value anyway, so the file's is never
    /// read.
    #[serde(skip)]
    pub revision: u64,
}

pub enum Command {
    AddWall(Wall),
    DeleteWall(WallId),
    /// Remove every wall and every opening. The blunt instrument — only for genuinely
    /// starting over. Regenerating a room wants [`Command::ReplaceGeneratedWalls`].
    ClearWalls,
    /// Drop the walls this app generated and put `walls` in their place, leaving every
    /// [`WallOrigin::Drawn`] wall standing.
    ///
    /// Openings follow their own wall rather than the operation: a door on a hand-drawn
    /// wall survives, a door on a replaced wall goes with it. Clearing openings wholesale
    /// — as `ClearWalls` does — would leave a surviving wall stripped of its door, which
    /// reads as a worse bug than losing the wall outright because it is selective.
    ReplaceGeneratedWalls(Vec<Wall>),
    AddOpening(Opening),
    RemoveOpening(OpeningId),
    /// Slide an opening to a new centre position along its wall. Leaves size untouched.
    MoveOpening {
        id: OpeningId,
        along: f32,
    },
    /// Absolute width/height/sill (metres) for an opening.
    ResizeOpening {
        id: OpeningId,
        width: f32,
        height: f32,
        sill: f32,
    },
    AddFurnishing(Furnishing),
    RemoveFurnishing(FurnishingId),
    Reposition {
        id: FurnishingId,
        placement: Placement,
    },
    /// Absolute yaw, in radians. Leaves position and anchor untouched so a rotate
    /// nudge spins in place rather than re-running wall snapping.
    SetYaw {
        id: FurnishingId,
        yaw: f32,
    },
    /// Absolute per-axis scale. The caller re-seats the placement afterwards if the
    /// new footprint moved the asset off its anchor.
    SetScale {
        id: FurnishingId,
        scale: Vec3,
    },
    /// Set a furnishing aside into the bullpen (`stashed = true`) or bring it back
    /// (`false`). Toggling this never touches scale, yaw, or anchor, so a re-imported
    /// item keeps everything but its old position — which the caller re-seats.
    SetStashed {
        id: FurnishingId,
        stashed: bool,
    },
    /// Choose the floor's surface finish.
    SetFloorMaterial(FloorMaterial),
    /// Choose the walls' paint finish.
    SetWallMaterial(WallMaterial),
    /// Choose the room's lighting mood.
    SetLighting(LightingPreset),
    /// Set the floor footprint (metres, loop order). Empty means no floor.
    SetFloorOutline(Vec<Vec2>),
}

impl Scene {
    /// Sole mutation path. Funnelling every edit through one place is what keeps
    /// undo and collaboration a refactor rather than a rewrite.
    pub fn apply(&mut self, command: Command) {
        // Every mutation, one place. See `Scene::revision`.
        self.revision += 1;
        match command {
            Command::AddWall(wall) => self.walls.push(wall),
            Command::DeleteWall(id) => {
                self.walls.retain(|w| w.id != id);
                // An opening cannot outlive the wall that owns it.
                self.openings.retain(|o| o.wall != id);
            }
            Command::ClearWalls => {
                self.walls.clear();
                self.openings.clear();
            }
            Command::ReplaceGeneratedWalls(walls) => {
                // Take the openings out with their own walls, not with the operation, so
                // a door on a hand-drawn wall is still there afterwards.
                let dropped: Vec<WallId> = self
                    .walls
                    .iter()
                    .filter(|w| w.origin == WallOrigin::Generated)
                    .map(|w| w.id)
                    .collect();
                self.walls.retain(|w| w.origin != WallOrigin::Generated);
                self.openings.retain(|o| !dropped.contains(&o.wall));
                self.walls.extend(walls);
            }
            Command::AddOpening(opening) => self.openings.push(opening),
            Command::RemoveOpening(id) => self.openings.retain(|o| o.id != id),
            Command::MoveOpening { id, along } => {
                if let Some(opening) = self.openings.iter_mut().find(|o| o.id == id) {
                    opening.along = along;
                }
            }
            Command::ResizeOpening {
                id,
                width,
                height,
                sill,
            } => {
                if let Some(opening) = self.openings.iter_mut().find(|o| o.id == id) {
                    opening.width = width;
                    opening.height = height;
                    opening.sill = sill;
                }
            }
            Command::AddFurnishing(furnishing) => self.furnishings.push(furnishing),
            Command::RemoveFurnishing(id) => self.furnishings.retain(|f| f.id != id),
            Command::Reposition { id, placement } => {
                if let Some(furnishing) = self.furnishings.iter_mut().find(|f| f.id == id) {
                    furnishing.placement = placement;
                }
            }
            Command::SetYaw { id, yaw } => {
                if let Some(furnishing) = self.furnishings.iter_mut().find(|f| f.id == id) {
                    furnishing.placement.yaw = yaw;
                }
            }
            Command::SetScale { id, scale } => {
                if let Some(furnishing) = self.furnishings.iter_mut().find(|f| f.id == id) {
                    furnishing.scale = scale;
                }
            }
            Command::SetStashed { id, stashed } => {
                if let Some(furnishing) = self.furnishings.iter_mut().find(|f| f.id == id) {
                    furnishing.stashed = stashed;
                }
            }
            Command::SetFloorMaterial(material) => self.floor_material = material,
            Command::SetWallMaterial(material) => self.wall_material = material,
            Command::SetLighting(preset) => self.lighting = preset,
            Command::SetFloorOutline(outline) => self.floor_outline = outline,
        }
    }

    pub fn wall(&self, id: WallId) -> Option<&Wall> {
        self.walls.iter().find(|w| w.id == id)
    }

    pub fn furnishing(&self, id: FurnishingId) -> Option<&Furnishing> {
        self.furnishings.iter().find(|f| f.id == id)
    }

    /// Furnishings placed in the room (not set aside in the bullpen), in placement order.
    pub fn placed_furnishings(&self) -> impl Iterator<Item = &Furnishing> {
        self.furnishings.iter().filter(|f| !f.stashed)
    }

    /// Furnishings set aside in the bullpen, in the order they were stashed.
    pub fn stashed_furnishings(&self) -> impl Iterator<Item = &Furnishing> {
        self.furnishings.iter().filter(|f| f.stashed)
    }

    pub fn opening(&self, id: OpeningId) -> Option<&Opening> {
        self.openings.iter().find(|o| o.id == id)
    }

    /// Openings owned by a given wall, in insertion order.
    pub fn openings_on(&self, wall: WallId) -> impl Iterator<Item = &Opening> {
        self.openings.iter().filter(move |o| o.wall == wall)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_chair() -> Scene {
        let mut scene = Scene::default();
        scene.apply(Command::AddFurnishing(Furnishing {
            id: 1,
            asset: Asset {
                extent: Vec3::new(0.83, 0.69, 0.57),
                asset_id: "sheen-chair".into(),
            },
            placement: Placement {
                position: Vec3::new(2.0, 0.0, 1.0),
                yaw: 0.0,
                anchor: Anchor::Floor,
            },
            scale: Vec3::ONE,
            stashed: false,
        }));
        scene
    }

    #[test]
    fn set_yaw_rotates_in_place() {
        let mut scene = one_chair();
        scene.apply(Command::SetYaw {
            id: 1,
            yaw: std::f32::consts::FRAC_PI_2,
        });
        let f = scene.furnishing(1).unwrap();
        assert_eq!(f.placement.yaw, std::f32::consts::FRAC_PI_2);
        // Position and anchor are left alone.
        assert_eq!(f.placement.position, Vec3::new(2.0, 0.0, 1.0));
        assert_eq!(f.placement.anchor, Anchor::Floor);
    }

    #[test]
    fn set_scale_replaces_the_multiplier() {
        let mut scene = one_chair();
        scene.apply(Command::SetScale {
            id: 1,
            scale: Vec3::new(1.5, 1.0, 2.0),
        });
        assert_eq!(scene.furnishing(1).unwrap().scale, Vec3::new(1.5, 1.0, 2.0));
    }

    #[test]
    fn stashing_a_furnishing_pulls_it_from_the_placed_set_but_keeps_it_owned() {
        let mut scene = one_chair();
        assert_eq!(scene.placed_furnishings().count(), 1);
        assert_eq!(scene.stashed_furnishings().count(), 0);

        scene.apply(Command::SetStashed {
            id: 1,
            stashed: true,
        });
        // Still owned by the document — scale/yaw untouched — but out of the room.
        assert_eq!(scene.furnishings.len(), 1);
        assert_eq!(scene.placed_furnishings().count(), 0);
        assert_eq!(scene.stashed_furnishings().map(|f| f.id).collect::<Vec<_>>(), vec![1]);

        scene.apply(Command::SetStashed {
            id: 1,
            stashed: false,
        });
        assert_eq!(scene.placed_furnishings().count(), 1);
        assert_eq!(scene.stashed_furnishings().count(), 0);
    }

    #[test]
    fn floor_material_defaults_to_light_wood_and_is_settable() {
        let mut scene = one_chair();
        assert_eq!(scene.floor_material, FloorMaterial::WoodLight);
        scene.apply(Command::SetFloorMaterial(FloorMaterial::Concrete));
        assert_eq!(scene.floor_material, FloorMaterial::Concrete);
    }

    #[test]
    fn wall_material_defaults_to_warm_white_and_is_settable() {
        let mut scene = one_chair();
        assert_eq!(scene.wall_material, WallMaterial::WarmWhite);
        scene.apply(Command::SetWallMaterial(WallMaterial::Sage));
        assert_eq!(scene.wall_material, WallMaterial::Sage);
    }

    /// The finishes and the lighting are independent choices — picking one must not
    /// disturb the others.
    #[test]
    fn floor_wall_and_lighting_choices_are_independent() {
        let mut scene = one_chair();
        scene.apply(Command::SetWallMaterial(WallMaterial::Clay));
        scene.apply(Command::SetFloorMaterial(FloorMaterial::Tile));
        scene.apply(Command::SetLighting(LightingPreset::Evening));
        assert_eq!(scene.wall_material, WallMaterial::Clay);
        assert_eq!(scene.floor_material, FloorMaterial::Tile);
        assert_eq!(scene.lighting, LightingPreset::Evening);
    }

    #[test]
    fn lighting_defaults_to_noon_and_is_settable() {
        let mut scene = one_chair();
        assert_eq!(scene.lighting, LightingPreset::Noon);
        scene.apply(Command::SetLighting(LightingPreset::Overcast));
        assert_eq!(scene.lighting, LightingPreset::Overcast);
    }

    #[test]
    fn add_and_remove_furnishings() {
        let mut scene = one_chair();
        scene.apply(Command::AddFurnishing(Furnishing {
            id: 2,
            asset: Asset {
                extent: Vec3::new(1.0, 0.5, 1.0),
                asset_id: "night-stand".into(),
            },
            placement: Placement {
                position: Vec3::ZERO,
                yaw: 0.0,
                anchor: Anchor::Floor,
            },
            scale: Vec3::ONE,
            stashed: false,
        }));
        assert_eq!(scene.furnishings.len(), 2);
        scene.apply(Command::RemoveFurnishing(1));
        assert_eq!(scene.furnishings.len(), 1);
        assert!(scene.furnishing(1).is_none());
        assert!(scene.furnishing(2).is_some());
    }

    #[test]
    fn commands_targeting_a_missing_id_are_no_ops() {
        let mut scene = one_chair();
        scene.apply(Command::SetYaw { id: 99, yaw: 1.0 });
        scene.apply(Command::SetScale {
            id: 99,
            scale: Vec3::splat(3.0),
        });
        let f = scene.furnishing(1).unwrap();
        assert_eq!(f.placement.yaw, 0.0);
        assert_eq!(f.scale, Vec3::ONE);
    }

    fn wall(id: WallId) -> Wall {
        Wall {
            id,
            start: Vec2::ZERO,
            end: Vec2::new(4.0, 0.0),
            thickness: 0.12,
            height: 2.5,
            origin: WallOrigin::Drawn,
        }
    }

    fn door(id: OpeningId, wall: WallId) -> Opening {
        Opening {
            id,
            wall,
            kind: OpeningKind::Door,
            along: 2.0,
            width: 0.9,
            height: 2.03,
            sill: 0.0,
        }
    }

    #[test]
    fn add_move_and_resize_an_opening() {
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(wall(0)));
        scene.apply(Command::AddOpening(door(1, 0)));
        assert_eq!(scene.openings.len(), 1);
        assert_eq!(scene.opening(1).unwrap().span(), (1.55, 2.45));

        scene.apply(Command::MoveOpening { id: 1, along: 1.0 });
        assert_eq!(scene.opening(1).unwrap().along, 1.0);

        scene.apply(Command::ResizeOpening {
            id: 1,
            width: 1.2,
            height: 1.4,
            sill: 0.9,
        });
        let o = scene.opening(1).unwrap();
        assert_eq!((o.width, o.height, o.sill), (1.2, 1.4, 0.9));
        assert_eq!(o.head(), 2.3);
    }

    #[test]
    fn deleting_a_wall_takes_its_openings_with_it() {
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(wall(0)));
        scene.apply(Command::AddWall(wall(1)));
        scene.apply(Command::AddOpening(door(10, 0)));
        scene.apply(Command::AddOpening(door(11, 1)));
        assert_eq!(scene.openings.len(), 2);

        scene.apply(Command::DeleteWall(0));
        // Only wall 1's opening survives.
        assert_eq!(scene.openings_on(1).count(), 1);
        assert!(scene.opening(10).is_none());
        assert!(scene.opening(11).is_some());

        scene.apply(Command::ClearWalls);
        assert!(scene.openings.is_empty());
    }

    /// A wall of the given origin, so the two can be mixed in one scene.
    fn wall_from(id: WallId, origin: WallOrigin) -> Wall {
        Wall { origin, ..wall(id) }
    }

    #[test]
    fn regenerating_replaces_generated_walls_and_leaves_drawn_ones_standing() {
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(wall_from(0, WallOrigin::Generated)));
        scene.apply(Command::AddWall(wall_from(1, WallOrigin::Drawn)));

        scene.apply(Command::ReplaceGeneratedWalls(vec![
            wall_from(2, WallOrigin::Generated),
            wall_from(3, WallOrigin::Generated),
        ]));

        // Wall 0 went, wall 1 — the hand-drawn one — did not.
        let ids: Vec<WallId> = scene.walls.iter().map(|w| w.id).collect();
        assert_eq!(ids, vec![1, 2, 3]);
    }

    #[test]
    fn regenerating_keeps_a_door_on_a_wall_the_user_drew() {
        // The half-fix this guards against: surviving the wall but losing its door is
        // worse than losing both, because it is selective and looks like corruption.
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(wall_from(0, WallOrigin::Generated)));
        scene.apply(Command::AddWall(wall_from(1, WallOrigin::Drawn)));
        scene.apply(Command::AddOpening(door(10, 0))); // on the generated wall
        scene.apply(Command::AddOpening(door(11, 1))); // on the drawn wall

        scene.apply(Command::ReplaceGeneratedWalls(vec![wall_from(
            2,
            WallOrigin::Generated,
        )]));

        // The door on the replaced wall went with it; the one on the drawn wall stayed.
        assert!(scene.opening(10).is_none());
        assert!(scene.opening(11).is_some());
        assert_eq!(scene.openings_on(1).count(), 1);
    }

    #[test]
    fn regenerating_an_all_drawn_room_removes_nothing() {
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(wall_from(0, WallOrigin::Drawn)));
        scene.apply(Command::AddOpening(door(10, 0)));
        scene.apply(Command::ReplaceGeneratedWalls(Vec::new()));
        assert_eq!(scene.walls.len(), 1);
        assert!(scene.opening(10).is_some());
    }

    #[test]
    fn a_wall_of_unknown_origin_defaults_to_surviving() {
        // The safe direction, and the whole reason `Drawn` is the default: a wall from a
        // save file written before this field existed must not be deleted by a resize.
        assert_eq!(WallOrigin::default(), WallOrigin::Drawn);
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(Wall {
            origin: WallOrigin::default(),
            ..wall(7)
        }));
        scene.apply(Command::ReplaceGeneratedWalls(Vec::new()));
        assert_eq!(scene.walls.len(), 1, "a default-origin wall was destroyed");
    }

    #[test]
    fn opening_commands_targeting_a_missing_id_are_no_ops() {
        let mut scene = Scene::default();
        scene.apply(Command::AddWall(wall(0)));
        scene.apply(Command::AddOpening(door(1, 0)));
        scene.apply(Command::MoveOpening { id: 99, along: 0.0 });
        scene.apply(Command::ResizeOpening {
            id: 99,
            width: 5.0,
            height: 5.0,
            sill: 5.0,
        });
        let o = scene.opening(1).unwrap();
        assert_eq!(o.along, 2.0);
        assert_eq!(o.width, 0.9);
    }
}
