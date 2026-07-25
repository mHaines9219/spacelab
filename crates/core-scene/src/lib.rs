//! Parametric scene document: walls, openings, furnishings, and the command layer all mutations flow through.

use glam::{Vec2, Vec3};

pub type WallId = u32;
pub type FurnishingId = u32;

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

#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub walls: Vec<Wall>,
    pub furnishings: Vec<Furnishing>,
    pub floor_material: FloorMaterial,
    /// The room's floor footprint (metres, in loop order). Owned by the document
    /// independently of the walls, so removing a wall never reshapes the floor.
    pub floor_outline: Vec<Vec2>,
}

pub enum Command {
    AddWall(Wall),
    DeleteWall(WallId),
    /// Remove every wall — used when regenerating a room from scratch.
    ClearWalls,
    AddFurnishing(Furnishing),
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
    /// Choose the floor's surface finish.
    SetFloorMaterial(FloorMaterial),
    /// Set the floor footprint (metres, loop order). Empty means no floor.
    SetFloorOutline(Vec<Vec2>),
}

impl Scene {
    /// Sole mutation path. Funnelling every edit through one place is what keeps
    /// undo and collaboration a refactor rather than a rewrite.
    pub fn apply(&mut self, command: Command) {
        match command {
            Command::AddWall(wall) => self.walls.push(wall),
            Command::DeleteWall(id) => self.walls.retain(|w| w.id != id),
            Command::ClearWalls => self.walls.clear(),
            Command::AddFurnishing(furnishing) => self.furnishings.push(furnishing),
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
            Command::SetFloorMaterial(material) => self.floor_material = material,
            Command::SetFloorOutline(outline) => self.floor_outline = outline,
        }
    }

    pub fn wall(&self, id: WallId) -> Option<&Wall> {
        self.walls.iter().find(|w| w.id == id)
    }

    pub fn furnishing(&self, id: FurnishingId) -> Option<&Furnishing> {
        self.furnishings.iter().find(|f| f.id == id)
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
    fn floor_material_defaults_to_light_wood_and_is_settable() {
        let mut scene = one_chair();
        assert_eq!(scene.floor_material, FloorMaterial::WoodLight);
        scene.apply(Command::SetFloorMaterial(FloorMaterial::Concrete));
        assert_eq!(scene.floor_material, FloorMaterial::Concrete);
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
}
