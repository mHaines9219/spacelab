//! Parametric scene document: walls, openings, furnishings, and the command layer all mutations flow through.

use glam::{Vec2, Vec3};

pub type WallId = u32;
pub type FurnishingId = u32;
pub type OpeningId = u32;

/// Ground-plane coordinates are metres as `Vec2(x, z)`; `Vec3` is `(x, up, z)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Wall {
    pub id: WallId,
    pub start: Vec2,
    pub end: Vec2,
    pub thickness: f32,
    pub height: f32,
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

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Anchor {
    Floor,
    AgainstWall(WallId),
}

/// A door or window. Ordinal matches the flag the wasm boundary exchanges with the web.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpeningKind {
    Door,
    Window,
}

/// A parametric cut *owned by* a wall: a door or window. Position is a distance along
/// the wall centreline, so moving or resizing the wall carries the opening with it —
/// the opening never stores world coordinates of its own.
#[derive(Clone, Copy, Debug, PartialEq)]
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

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub position: Vec3,
    pub yaw: f32,
    pub anchor: Anchor,
}

/// Catalog metadata the constraint solver needs. `extent` is width/height/depth in
/// metres, with local `+Z` as the asset's front.
#[derive(Clone, Copy, Debug)]
pub struct Asset {
    pub extent: Vec3,
}

#[derive(Clone, Copy, Debug)]
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
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

#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub walls: Vec<Wall>,
    /// Doors and windows, each owned by a wall (`Opening::wall`). Kept in a flat list
    /// rather than on the walls so the `Copy` `Wall` stays cheap and deleting a wall is
    /// a single retain over both lists.
    pub openings: Vec<Opening>,
    pub furnishings: Vec<Furnishing>,
    pub floor_material: FloorMaterial,
    pub wall_material: WallMaterial,
    /// The room's floor footprint (metres, in loop order). Owned by the document
    /// independently of the walls, so removing a wall never reshapes the floor.
    pub floor_outline: Vec<Vec2>,
}

pub enum Command {
    AddWall(Wall),
    DeleteWall(WallId),
    /// Remove every wall — used when regenerating a room from scratch.
    ClearWalls,
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
    /// Set the floor footprint (metres, loop order). Empty means no floor.
    SetFloorOutline(Vec<Vec2>),
}

impl Scene {
    /// Sole mutation path. Funnelling every edit through one place is what keeps
    /// undo and collaboration a refactor rather than a rewrite.
    pub fn apply(&mut self, command: Command) {
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

    /// The two finishes are independent choices — picking a floor must not disturb the
    /// walls, and vice versa.
    #[test]
    fn floor_and_wall_finishes_are_independent() {
        let mut scene = one_chair();
        scene.apply(Command::SetWallMaterial(WallMaterial::Clay));
        scene.apply(Command::SetFloorMaterial(FloorMaterial::Tile));
        assert_eq!(scene.wall_material, WallMaterial::Clay);
        assert_eq!(scene.floor_material, FloorMaterial::Tile);
    }

    #[test]
    fn add_and_remove_furnishings() {
        let mut scene = one_chair();
        scene.apply(Command::AddFurnishing(Furnishing {
            id: 2,
            asset: Asset {
                extent: Vec3::new(1.0, 0.5, 1.0),
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
