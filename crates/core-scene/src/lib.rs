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
}

#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub walls: Vec<Wall>,
    pub furnishings: Vec<Furnishing>,
}

pub enum Command {
    AddWall(Wall),
    AddFurnishing(Furnishing),
    Reposition {
        id: FurnishingId,
        placement: Placement,
    },
}

impl Scene {
    /// Sole mutation path. Funnelling every edit through one place is what keeps
    /// undo and collaboration a refactor rather than a rewrite.
    pub fn apply(&mut self, command: Command) {
        match command {
            Command::AddWall(wall) => self.walls.push(wall),
            Command::AddFurnishing(furnishing) => self.furnishings.push(furnishing),
            Command::Reposition { id, placement } => {
                if let Some(furnishing) = self.furnishings.iter_mut().find(|f| f.id == id) {
                    furnishing.placement = placement;
                }
            }
        }
    }

    pub fn wall(&self, id: WallId) -> Option<&Wall> {
        self.walls.iter().find(|w| w.id == id)
    }
}
