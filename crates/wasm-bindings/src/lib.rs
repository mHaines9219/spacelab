//! wasm-bindgen boundary. Coarse typed-array interface only — never per-object JSON.

use core_geometry::{MeshBuffers, resolve_placement, shell_mesh};
use core_scene::{
    Anchor, Asset, Command, Furnishing, FurnishingId, Placement, Scene, Wall, WallId,
};
use glam::{Vec2, Vec3};
use wasm_bindgen::prelude::*;

const CHAIR: FurnishingId = 1;
const SNAP_RADIUS: f32 = 0.35;

/// M0 spike scene: two walls, one chair, one drag constraint. Throwaway by design —
/// it exists to measure the Rust/JS seam, not to grow into the app.
#[wasm_bindgen]
pub struct Spike {
    scene: Scene,
    shell: MeshBuffers,
    chair: Asset,
}

#[wasm_bindgen]
impl Spike {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let mut scene = Scene::default();
        for (id, start, end) in [
            (0 as WallId, Vec2::ZERO, Vec2::new(4.2, 0.0)),
            (1, Vec2::ZERO, Vec2::new(0.0, 3.4)),
        ] {
            scene.apply(Command::AddWall(Wall {
                id,
                start,
                end,
                thickness: 0.12,
                height: 2.5,
            }));
        }

        let chair = Asset {
            extent: Vec3::new(0.83, 0.69, 0.57),
        };
        scene.apply(Command::AddFurnishing(Furnishing {
            id: CHAIR,
            asset: chair,
            placement: Placement {
                position: Vec3::ZERO,
                yaw: 0.0,
                anchor: Anchor::Floor,
            },
        }));

        let shell = shell_mesh(&scene);
        Self {
            scene,
            shell,
            chair,
        }
    }

    pub fn shell_positions(&self) -> Vec<f32> {
        self.shell.positions.clone()
    }

    pub fn shell_normals(&self) -> Vec<f32> {
        self.shell.normals.clone()
    }

    pub fn shell_indices(&self) -> Vec<u32> {
        self.shell.indices.clone()
    }

    pub fn shell_triangles(&self) -> usize {
        self.shell.triangle_count()
    }

    /// Drag hot path, called once per pointer move: cursor metres in,
    /// `[x, up, z, yaw, snapped]` out.
    pub fn drag(&mut self, x: f32, z: f32) -> Vec<f32> {
        let placement = resolve_placement(&self.scene, &self.chair, Vec2::new(x, z), SNAP_RADIUS);
        self.scene.apply(Command::Reposition {
            id: CHAIR,
            placement,
        });
        vec![
            placement.position.x,
            placement.position.y,
            placement.position.z,
            placement.yaw,
            matches!(placement.anchor, Anchor::AgainstWall(_)) as u8 as f32,
        ]
    }
}

impl Default for Spike {
    fn default() -> Self {
        Self::new()
    }
}
