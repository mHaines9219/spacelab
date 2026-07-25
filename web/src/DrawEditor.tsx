import { useRef, useState } from "react";

// Top-down floorplan drawing. The user clicks to drop corners; a live rubber-band
// shows the pending segment with its length; they can type an exact length (feet +
// inches) to place the next corner precisely; snapping-to-start or the "close room"
// button completes the loop. Output is a metric polygon the Rust document extrudes.

const PX_PER_M = 46;
const M_PER_FT = 0.3048;
const M_PER_IN = 0.0254;
const GRID_M = 6 * M_PER_IN; // 6-inch grid
const CLOSE_M = 0.3; // snap-to-start radius
const ORTHO_DEG = 8; // straighten near-horizontal / near-vertical segments
const ALIGN_M = 0.2; // lock an axis onto an earlier corner it lines up with (~8")

type Pt = { x: number; z: number };

const snapGrid = (v: number) => Math.round(v / GRID_M) * GRID_M;
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z);
const fmtLen = (m: number) => {
  const totalIn = m / M_PER_IN;
  const ft = Math.floor(totalIn / 12);
  const inch = Math.round(totalIn - ft * 12);
  return `${ft}′ ${inch}″`;
};

export function DrawEditor({
  onBack,
  onComplete,
}: {
  onBack: () => void;
  onComplete: (coordsM: number[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [points, setPoints] = useState<Pt[]>([]);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [ft, setFt] = useState("");
  const [inch, setInch] = useState("");

  const last = points[points.length - 1];
  const nearStart =
    points.length >= 3 && cursor != null && dist(cursor, points[0]) < CLOSE_M;
  const pending = last && cursor ? dist(last, cursor) : 0;

  const originPx = (): Pt => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: (rect?.width ?? 0) / 2, z: (rect?.height ?? 0) / 2 };
  };
  const toPx = (p: Pt) => {
    const o = originPx();
    return { x: o.x + p.x * PX_PER_M, y: o.z + p.z * PX_PER_M };
  };

  const worldAt = (clientX: number, clientY: number): Pt => {
    const rect = svgRef.current!.getBoundingClientRect();
    const o = originPx();
    let x = (clientX - rect.left - o.x) / PX_PER_M;
    let z = (clientY - rect.top - o.z) / PX_PER_M;
    if (last) {
      // Straighten segments that are nearly axis-aligned to the previous corner.
      const angle = (Math.atan2(Math.abs(z - last.z), Math.abs(x - last.x)) * 180) / Math.PI;
      if (angle < ORTHO_DEG) z = last.z;
      else if (angle > 90 - ORTHO_DEG) x = last.x;
    }
    // Alignment lock: pull each axis onto the nearest earlier corner it lines up
    // with, so the last leg can run parallel to an earlier wall and the loop
    // closes square. The start corner is checked first, so it wins ties — making
    // "line up with the origin, then close" the easiest lock to land.
    const rawX = x;
    const rawZ = z;
    let bestX = ALIGN_M;
    let bestZ = ALIGN_M;
    for (const p of points) {
      const dx = Math.abs(rawX - p.x);
      if (dx < bestX) {
        bestX = dx;
        x = p.x;
      }
      const dz = Math.abs(rawZ - p.z);
      if (dz < bestZ) {
        bestZ = dz;
        z = p.z;
      }
    }
    return { x: snapGrid(x), z: snapGrid(z) };
  };

  const finish = (pts: Pt[]) => onComplete(pts.flatMap((p) => [p.x, p.z]));

  const onMove = (e: React.MouseEvent) => setCursor(worldAt(e.clientX, e.clientY));

  const onClick = (e: React.MouseEvent) => {
    const p = worldAt(e.clientX, e.clientY);
    if (nearStart) {
      finish(points);
      return;
    }
    // Ignore a zero-length click on top of the previous corner.
    if (last && dist(last, p) < GRID_M / 2) return;
    setPoints([...points, p]);
  };

  // Direct distance entry: place the next corner at the typed length along the
  // current cursor direction.
  const addExact = () => {
    if (!last || !cursor) return;
    const len = (Number(ft) || 0) * M_PER_FT + (Number(inch) || 0) * M_PER_IN;
    const d = dist(last, cursor);
    if (len < 0.05 || d < 1e-4) return;
    const ux = (cursor.x - last.x) / d;
    const uz = (cursor.z - last.z) / d;
    setPoints([...points, { x: last.x + ux * len, z: last.z + uz * len }]);
    setFt("");
    setInch("");
  };

  const undo = () => setPoints(points.slice(0, -1));

  const path = points.map((p) => toPx(p));
  const cursorPx = cursor ? toPx(cursor) : null;

  // Alignment guides: when the cursor's axis is locked onto an earlier corner
  // (see worldAt), draw a guide line through it. The start corner reads green,
  // echoing the close-the-room affordance.
  const svgRect = svgRef.current?.getBoundingClientRect();
  const svgW = svgRect?.width ?? 0;
  const svgH = svgRect?.height ?? 0;
  const guideX =
    cursor && points.length ? points.find((p) => p !== last && p.x === cursor.x) : undefined;
  const guideZ =
    cursor && points.length ? points.find((p) => p !== last && p.z === cursor.z) : undefined;
  const guideColor = (p: Pt) => (p === points[0] ? "#8fd28f" : "#3f6ea5");

  return (
    <div className="overlay draw">
      <svg
        ref={svgRef}
        className="draw-canvas"
        onMouseMove={onMove}
        onClick={onClick}
      >
        <defs>
          <pattern
            id="grid"
            width={GRID_M * PX_PER_M * 2}
            height={GRID_M * PX_PER_M * 2}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${GRID_M * PX_PER_M * 2} 0 L 0 0 0 ${GRID_M * PX_PER_M * 2}`}
              fill="none"
              stroke="#2a2e35"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />

        {/* alignment guides — cursor axis locked onto an earlier corner */}
        {cursorPx && guideX && (
          <line
            x1={cursorPx.x}
            y1={0}
            x2={cursorPx.x}
            y2={svgH}
            stroke={guideColor(guideX)}
            strokeWidth="1"
            strokeDasharray="2 5"
            opacity="0.7"
          />
        )}
        {cursorPx && guideZ && (
          <line
            x1={0}
            y1={cursorPx.y}
            x2={svgW}
            y2={cursorPx.y}
            stroke={guideColor(guideZ)}
            strokeWidth="1"
            strokeDasharray="2 5"
            opacity="0.7"
          />
        )}

        {/* committed edges */}
        {path.length > 1 && (
          <polyline
            points={path.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="#5b9dff"
            strokeWidth="2.5"
          />
        )}

        {/* rubber-band to cursor */}
        {last && cursorPx && (
          <>
            <line
              x1={toPx(last).x}
              y1={toPx(last).y}
              x2={cursorPx.x}
              y2={cursorPx.y}
              stroke="#5b9dff"
              strokeWidth="1.5"
              strokeDasharray="5 4"
            />
            <text
              x={(toPx(last).x + cursorPx.x) / 2 + 8}
              y={(toPx(last).y + cursorPx.y) / 2 - 8}
              fill="#cfd3da"
              fontSize="12"
              fontFamily="ui-monospace, monospace"
            >
              {fmtLen(pending)}
            </text>
          </>
        )}

        {/* corners */}
        {path.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={i === 0 && nearStart ? 8 : 4}
            fill={i === 0 && nearStart ? "#8fd28f" : "#5b9dff"}
          />
        ))}
      </svg>

      <div className="draw-bar">
        <strong>draw the room</strong>
        <span className="hint">
          {points.length === 0
            ? "click to place the first corner"
            : nearStart
              ? "click the green dot to close the room"
              : "click to add a corner, or type an exact length"}
        </span>
        {last && (
          <span className="field">
            <input
              type="number"
              min="0"
              placeholder="ft"
              value={ft}
              onChange={(e) => setFt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addExact()}
            />
            <span className="unit">ft</span>
            <input
              type="number"
              min="0"
              max="11"
              placeholder="in"
              value={inch}
              onChange={(e) => setInch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addExact()}
            />
            <span className="unit">in</span>
            <button type="button" className="reset" onClick={addExact}>
              add
            </button>
          </span>
        )}
        <span className="draw-actions">
          <button type="button" className="reset" onClick={onBack}>
            back
          </button>
          {points.length > 0 && (
            <button type="button" className="reset" onClick={undo}>
              undo corner
            </button>
          )}
          {points.length >= 3 && (
            <button type="button" className="primary" onClick={() => finish(points)}>
              close room
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
