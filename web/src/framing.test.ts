import { describe, expect, it } from "vitest";
import { frameBounds, viewDirection, type Bounds, type Framing } from "./framing";

const FOV = 50;

/** A room `w` x `d` metres with `h`-high walls, centred on the origin. */
const room = (w: number, d: number, h = 2.5): Bounds => ({
  min: [-w / 2, 0, -d / 2],
  max: [w / 2, h, d / 2],
});

/**
 * Does every corner of `bounds` actually land inside the frustum?
 *
 * This is the property under test rather than a restatement of the implementation: it
 * re-derives the camera basis from the returned position and target, so an arithmetic
 * error in `frameBounds` cannot cancel itself out here.
 */
function worstOverflow(bounds: Bounds, framing: Framing, fov: number, aspect: number): number {
  const { position, target } = framing;
  const back: [number, number, number] = [
    position[0] - target[0],
    position[1] - target[1],
    position[2] - target[2],
  ];
  const len = Math.hypot(...back);
  const dir: [number, number, number] = [back[0] / len, back[1] / len, back[2] / len];
  const rightRaw: [number, number, number] = [-dir[2], 0, dir[0]];
  const rl = Math.hypot(...rightRaw);
  const right: [number, number, number] = [rightRaw[0] / rl, rightRaw[1] / rl, rightRaw[2] / rl];
  const up: [number, number, number] = [
    right[1] * dir[2] - right[2] * dir[1],
    right[2] * dir[0] - right[0] * dir[2],
    right[0] * dir[1] - right[1] * dir[0],
  ];

  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * aspect;

  // How far outside the frustum the worst corner sits, as a ratio: <= 1 means it fits.
  let worst = 0;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const v = [x - position[0], y - position[1], z - position[2]] as const;
        const depth = -(v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]);
        if (depth <= 0) return Infinity; // behind the camera
        const sx = Math.abs(v[0] * right[0] + v[1] * right[1] + v[2] * right[2]);
        const sy = Math.abs(v[0] * up[0] + v[1] * up[1] + v[2] * up[2]);
        worst = Math.max(worst, sx / (depth * tanH), sy / (depth * tanV));
      }
    }
  }
  return worst;
}

/**
 * The framing this replaces, kept so the fit tests can be shown to *discriminate*.
 * A fit assertion that also passes on the old placement would be proving nothing.
 */
function legacyFraming(bounds: Bounds): Framing {
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2], 1);
  return {
    target: [cx, 0.4, cz],
    position: [cx + span * 0.75, span * 1.15 + 2.4, cz + span * 0.85],
  };
}

describe("camera framing", () => {
  it("fits the room at the aspect ratio the old formula was tuned against", () => {
    const bounds = room(10, 3);
    expect(worstOverflow(bounds, frameBounds(bounds, FOV, 1.78), FOV, 1.78)).toBeLessThanOrEqual(1);
  });

  it("still fits a wide room in a tall window, which is the case that was broken", () => {
    const bounds = room(10, 3);
    const aspect = 0.5;

    // The bug, reproduced: the old placement pushes a corner outside the frustum.
    expect(worstOverflow(bounds, legacyFraming(bounds), FOV, aspect)).toBeGreaterThan(1);

    expect(worstOverflow(bounds, frameBounds(bounds, FOV, aspect), FOV, aspect)).toBeLessThanOrEqual(1);
  });

  it("fits a large square room in a narrow window", () => {
    const bounds = room(12, 12);
    const aspect = 0.6;
    expect(worstOverflow(bounds, legacyFraming(bounds), FOV, aspect)).toBeGreaterThan(1);
    expect(worstOverflow(bounds, frameBounds(bounds, FOV, aspect), FOV, aspect)).toBeLessThanOrEqual(1);
  });

  it("fits across a sweep of room shapes and viewport shapes", () => {
    for (const [w, d] of [
      [2, 2],
      [3, 4],
      [10, 3],
      [3, 10],
      [12, 12],
      [25, 6],
    ]) {
      for (const aspect of [0.4, 0.75, 1, 1.78, 3.2]) {
        const bounds = room(w, d);
        const overflow = worstOverflow(bounds, frameBounds(bounds, FOV, aspect), FOV, aspect);
        expect(overflow, `${w}x${d} at aspect ${aspect}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("includes wall height, not just the floor footprint", () => {
    // A tall room and a short one share a footprint, so a floor-only fit would place
    // the camera identically for both and clip the taller walls.
    const short = frameBounds(room(4, 4, 1), FOV, 1.78);
    const tall = frameBounds(room(4, 4, 6), FOV, 1.78);
    expect(tall.position[1]).toBeGreaterThan(short.position[1]);
    expect(worstOverflow(room(4, 4, 6), tall, FOV, 1.78)).toBeLessThanOrEqual(1);
  });

  it("keeps the viewing angle the old formula chose", () => {
    // Only the distance was wrong. If the direction drifts, every room in the app is
    // framed from a new angle and the lighting presets — tuned off this axis — go with it.
    const bounds = room(6, 5);
    const { position, target } = frameBounds(bounds, FOV, 1.78);
    const offset = [position[0] - target[0], position[1] - target[1], position[2] - target[2]];
    const len = Math.hypot(...offset);
    const expected = viewDirection(6);
    for (let i = 0; i < 3; i++) expect(offset[i] / len).toBeCloseTo(expected[i], 6);
  });

  it("moves the camera closer as the viewport gets wider", () => {
    const bounds = room(8, 4);
    const distance = (aspect: number) => {
      const { position, target } = frameBounds(bounds, FOV, aspect);
      return Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]);
    };
    expect(distance(0.5)).toBeGreaterThan(distance(1));
    expect(distance(1)).toBeGreaterThan(distance(2));
  });

  it("keeps the camera off its own target when the document is empty", () => {
    // `room_bounds()` reports all zeros before any room exists. Fitting a box of nothing
    // would otherwise put the camera at the target: black view, orbit does nothing.
    const empty: Bounds = { min: [0, 0, 0], max: [0, 0, 0] };
    const { position, target } = frameBounds(empty, FOV, 1.78);
    const distance = Math.hypot(
      position[0] - target[0],
      position[1] - target[1],
      position[2] - target[2],
    );
    expect(distance).toBeGreaterThanOrEqual(3);
    expect(position.every(Number.isFinite)).toBe(true);
  });

  it("survives the aspect ratio a mid-resize canvas reports", () => {
    // A zero-height canvas gives 0, Infinity or NaN. NaN placement is unrecoverable —
    // the camera never comes back without a reload — so it must never be produced.
    const bounds = room(5, 4);
    for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { position, target } = frameBounds(bounds, FOV, aspect);
      expect([...position, ...target].every(Number.isFinite), `aspect ${aspect}`).toBe(true);
    }
  });
});
