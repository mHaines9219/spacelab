/**
 * Where to put the camera so the whole room is in shot.
 *
 * The previous framing derived a distance from the footprint alone —
 * `span * 0.75, span * 1.15 + 2.4, span * 0.85` — and never consulted the camera. That
 * works at the aspect ratio it was tuned against and fails away from it: field of view
 * is vertical, so the *horizontal* one narrows as the viewport does, and a wide room in
 * a tall window runs off both sides. A 10 x 3 m room at aspect 0.5 needed ~5.2 m of
 * half-width and had 4.1 m. Nothing in the old formula could notice, because the aspect
 * ratio was not one of its inputs.
 *
 * So the distance is *solved* rather than guessed: project the room's corners onto the
 * camera basis and take the smallest distance that keeps every one of them inside both
 * frustum planes.
 *
 * The viewing **angle** is deliberately unchanged. The old formula's direction is kept
 * exactly, including its size-dependent steepening (the `+ 2.0` term), because that was
 * a real aesthetic decision — a steeper look-down in small rooms stops near walls
 * crowding the floor. Only the distance was wrong, so only the distance moved.
 */

/** An axis-aligned box in world space, metres. */
export type Bounds = { min: [number, number, number]; max: [number, number, number] };

/** Where the camera goes and what it looks at. */
export type Framing = { position: [number, number, number]; target: [number, number, number] };

/**
 * Never sit closer than this, in metres.
 *
 * An empty document reports a zero-size footprint, and fitting a box of nothing puts the
 * camera on top of its own target — the view goes black and orbiting does nothing, which
 * reads as a broken renderer rather than an empty room.
 */
const MIN_DISTANCE_M = 3;

/** A little air around the room so walls do not touch the edge of the canvas. */
const DEFAULT_MARGIN = 1.06;

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1];
};

/**
 * The direction the camera sits in, relative to its target — the house style, preserved
 * verbatim from the formula this replaces. `span` is the larger footprint dimension; the
 * constant in the height term is what steepens the angle for small rooms.
 */
export function viewDirection(span: number): Vec3 {
  return normalize([0.75 * span, 1.15 * span + 2.0, 0.85 * span]);
}

/**
 * Camera placement that fits `bounds` in a `fovDeg` / `aspect` frustum.
 *
 * `fovDeg` is three.js's vertical field of view. `aspect` is width / height; a value that
 * is not a positive finite number falls back to 1, since a camera mid-resize can briefly
 * report a zero-height canvas and NaN placement is unrecoverable — the camera never comes
 * back without a reload.
 */
export function frameBounds(
  bounds: Bounds,
  fovDeg: number,
  aspect: number,
  margin: number = DEFAULT_MARGIN,
): Framing {
  const { min, max } = bounds;
  const usableAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;

  const centreX = (min[0] + max[0]) / 2;
  const centreZ = (min[2] + max[2]) / 2;
  const span = Math.max(max[0] - min[0], max[2] - min[2], 1);

  // Slightly above the floor rather than the box centre: it keeps the floor plane —
  // the thing being laid out — in the lower half of the frame instead of edge-on.
  const target: Vec3 = [centreX, min[1] + 0.4, centreZ];
  const direction = viewDirection(span);

  const tanHalfV = Math.tan((fovDeg * Math.PI) / 360);
  const tanHalfH = tanHalfV * usableAspect;

  // Camera-aligned basis. `direction` points from the target towards the camera, so
  // `along` below is depth away from the subject and the other two are screen axes.
  const right = normalize(cross(direction, [0, 1, 0]));
  const up = cross(right, direction);

  let distance = MIN_DISTANCE_M;
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        const v = sub([x, y, z], target);
        const along = dot(v, direction);
        // Distance at which this corner lands exactly on each frustum plane. Whichever
        // plane it would breach first sets the requirement.
        const needed = Math.max(
          along + Math.abs(dot(v, right)) / tanHalfH,
          along + Math.abs(dot(v, up)) / tanHalfV,
        );
        distance = Math.max(distance, needed * margin);
      }
    }
  }

  return {
    target,
    position: [
      target[0] + direction[0] * distance,
      target[1] + direction[1] * distance,
      target[2] + direction[2] * distance,
    ],
  };
}
