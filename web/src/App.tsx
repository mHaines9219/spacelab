import { useEffect, useRef, useState } from "react";
import {
  createViewport,
  type BullpenItem,
  type CatalogEntry,
  type OpeningSelection,
  type Selection,
  type Stats,
  type ViewportHandle,
} from "./viewport";
import { DrawEditor } from "./DrawEditor";
import { CatalogPanel } from "./CatalogPanel";
import { Bullpen } from "./Bullpen";
import { createThumbnailer, type Thumbnailer } from "./thumbnailer";

const M_PER_FT = 0.3048;
const M_PER_IN = 0.0254;
const feetInchesToM = (ft: number, inch: number) => ft * M_PER_FT + inch * M_PER_IN;
const mToParts = (m: number) => {
  const totalIn = m / M_PER_IN;
  let ft = Math.floor(totalIn / 12);
  let inch = Math.round(totalIn - ft * 12);
  if (inch === 12) {
    ft += 1;
    inch = 0;
  }
  return { ft, inch };
};

type Stage = "choose" | "rectangle" | "square" | "draw" | "scene";
type Room = { widthM: number; depthM: number; square: boolean };

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<ViewportHandle | null>(null);
  const [stage, setStage] = useState<Stage>("choose");
  const [room, setRoom] = useState<Room | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [wallSel, setWallSel] = useState<number | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [openingSel, setOpeningSel] = useState<OpeningSelection>(null);
  const [openingMode, setOpeningMode] = useState<"door" | "window" | null>(null);
  const [floor, setFloor] = useState(0);
  const [wall, setWall] = useState(0);
  const [lighting, setLighting] = useState(0);
  const [bullpen, setBullpen] = useState<BullpenItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // One offscreen thumbnail renderer, shared by the catalog and the bullpen so a
  // re-import's card hits the cache the catalog already warmed.
  const thumbRef = useRef<Thumbnailer | null>(null);
  if (!thumbRef.current) thumbRef.current = createThumbnailer();
  useEffect(() => () => thumbRef.current?.dispose(), []);

  useEffect(() => {
    const canvas = canvasRef.current!;
    createViewport(
      canvas,
      setStats,
      setSelection,
      setWallSel,
      setAddMode,
      setOpeningSel,
      setOpeningMode,
      setBullpen,
    ).then(
      (handle) => (handleRef.current = handle),
      (cause) => setError(String(cause)),
    );
    return () => handleRef.current?.dispose();
  }, []);

  // Cmd/Ctrl+Z undoes the last action. Skipped while a text field is focused so the
  // browser's own text undo still works there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isUndo =
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey;
      if (!isUndo || stage !== "scene") return;
      if (document.activeElement instanceof HTMLInputElement) return;
      e.preventDefault();
      const result = handleRef.current?.undo();
      if (!result) return;
      if (result.empty) {
        setRoom(null);
        setStage("choose");
        return;
      }
      setFloor(result.floorIndex);
      setWall(result.wallIndex);
      setLighting(result.lightingIndex);
      setRoom((prev) =>
        prev && result.room
          ? { ...prev, widthM: result.room.widthM, depthM: result.room.depthM }
          : prev,
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage]);

  return (
    <>
      <canvas ref={canvasRef} />

      {stage === "choose" && <ChooseScreen onPick={setStage} />}

      {(stage === "rectangle" || stage === "square") && (
        <RoomForm
          kind={stage}
          onBack={() => setStage("choose")}
          onCreate={(widthM, depthM) => {
            handleRef.current?.setRectangle(widthM, depthM);
            setRoom({ widthM, depthM, square: stage === "square" });
            setStage("scene");
          }}
        />
      )}

      {stage === "draw" && (
        <DrawEditor
          onBack={() => setStage("choose")}
          onComplete={(coordsM) => {
            handleRef.current?.setPolygon(coordsM);
            setRoom(null); // freeform: no rectangle to resize by dimensions
            setStage("scene");
          }}
        />
      )}

      {stage === "scene" && (
        <>
          <div className="hud">
            <strong>spacelab</strong>
            {error ? (
              <span className="error">{error}</span>
            ) : stats ? (
              <>
                <Row label="fps" value={stats.fps.toFixed(0)} />
                <Row label="frame" value={`${stats.frameMs.toFixed(2)} ms`} />
                <Row label="triangles" value={stats.triangles.toLocaleString()} />
                <Row label="anchor" value={stats.snapped ? "against wall" : "floor"} />
              </>
            ) : (
              <span>loading…</span>
            )}
            <button
              type="button"
              className="reset"
              onClick={() => setStage("choose")}
            >
              new floor plan
            </button>
            <button
              type="button"
              className="reset"
              onClick={() => handleRef.current?.startAddWall()}
            >
              add wall
            </button>
            <button
              type="button"
              className="reset"
              onClick={() => handleRef.current?.startAddOpening("door")}
            >
              add door
            </button>
            <button
              type="button"
              className="reset"
              onClick={() => handleRef.current?.startAddOpening("window")}
            >
              add window
            </button>
            <span className="hint">
              click a wall or furniture to select
            </span>
          </div>

          {addMode && (
            <div className="banner">
              click two points to place a wall · Esc to cancel
            </div>
          )}

          {openingMode && (
            <div className="banner">
              click a wall to place the {openingMode} · Esc to cancel
            </div>
          )}

          {wallSel !== null && (
            <div className="panel">
              <strong>wall</strong>
              <span className="hint">press Delete to remove</span>
              <button
                type="button"
                className="reset"
                onClick={() => handleRef.current?.deleteSelectedWall()}
              >
                delete wall
              </button>
            </div>
          )}

          {room && (
            <RoomSizePanel
              room={room}
              onResize={(widthM, depthM) => {
                handleRef.current?.setRectangle(widthM, depthM);
                setRoom({ ...room, widthM, depthM });
              }}
            />
          )}

          {selection && (
            <SelectionPanel
              title={selection.title}
              dims={selection.dims}
              onSetDimension={(axis, inches) =>
                handleRef.current?.setDimension(axis, inches)
              }
              onReset={() => handleRef.current?.resetScale()}
              onStash={() => handleRef.current?.stashSelected()}
              onRemove={() => handleRef.current?.removeSelected()}
            />
          )}

          {openingSel && (
            <OpeningPanel
              kind={openingSel.kind}
              dims={openingSel.dims}
              onSetDimension={(axis, inches) =>
                handleRef.current?.setOpeningDimension(axis, inches)
              }
              onRemove={() => handleRef.current?.removeSelectedOpening()}
            />
          )}

          <CatalogPanel
            thumbnailer={thumbRef.current!}
            onPlace={(entry: CatalogEntry) => handleRef.current?.addFromCatalog(entry)}
          />

          <Bullpen
            items={bullpen}
            thumbnailer={thumbRef.current!}
            onReimport={(id) => handleRef.current?.unstash(id)}
            onDiscard={(id) => handleRef.current?.discardStashed(id)}
          />

          <FinishPicker
            floor={floor}
            wall={wall}
            lighting={lighting}
            onPickFloor={(i) => {
              handleRef.current?.setFloorMaterial(i);
              setFloor(i);
            }}
            onPickWall={(i) => {
              handleRef.current?.setWallMaterial(i);
              setWall(i);
            }}
            onPickLighting={(i) => {
              handleRef.current?.setLighting(i);
              setLighting(i);
            }}
          />
        </>
      )}
    </>
  );
}

function ChooseScreen({ onPick }: { onPick: (stage: Stage) => void }) {
  const cards: { kind: Stage; title: string; blurb: string }[] = [
    { kind: "rectangle", title: "Rectangle", blurb: "Enter a length and width" },
    { kind: "square", title: "Square", blurb: "Enter one side length" },
    { kind: "draw", title: "Draw", blurb: "Trace the room yourself" },
  ];
  return (
    <div className="overlay">
      <div className="choose">
        <h1>New floor plan</h1>
        <p className="sub">How would you like to start?</p>
        <div className="cards">
          {cards.map((c) => (
            <button key={c.kind} type="button" className="card" onClick={() => onPick(c.kind)}>
              <span className="card-title">{c.title}</span>
              <span className="card-blurb">{c.blurb}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function RoomForm({
  kind,
  onBack,
  onCreate,
}: {
  kind: "rectangle" | "square";
  onBack: () => void;
  onCreate: (widthM: number, depthM: number) => void;
}) {
  const [wFt, setWFt] = useState("12");
  const [wIn, setWIn] = useState("0");
  const [dFt, setDFt] = useState("10");
  const [dIn, setDIn] = useState("0");

  const widthM = feetInchesToM(Number(wFt) || 0, Number(wIn) || 0);
  const depthM = feetInchesToM(Number(dFt) || 0, Number(dIn) || 0);
  const square = kind === "square";
  const valid = widthM >= 0.3 && (square || depthM >= 0.3);

  return (
    <div className="overlay">
      <div className="form">
        <h1>{square ? "Square room" : "Rectangular room"}</h1>
        <FeetInches
          label={square ? "Side" : "Width"}
          ft={wFt}
          inch={wIn}
          onFt={setWFt}
          onInch={setWIn}
        />
        {!square && (
          <FeetInches label="Depth" ft={dFt} inch={dIn} onFt={setDFt} onInch={setDIn} />
        )}
        <div className="form-actions">
          <button type="button" className="reset" onClick={onBack}>
            back
          </button>
          <button
            type="button"
            className="primary"
            disabled={!valid}
            onClick={() => onCreate(widthM, square ? widthM : depthM)}
          >
            create room
          </button>
        </div>
      </div>
    </div>
  );
}

function FeetInches({
  label,
  ft,
  inch,
  onFt,
  onInch,
}: {
  label: string;
  ft: string;
  inch: string;
  onFt: (v: string) => void;
  onInch: (v: string) => void;
}) {
  return (
    <label className="row feet-inches">
      <span>{label}</span>
      <span className="field">
        <input type="number" min="0" value={ft} onChange={(e) => onFt(e.target.value)} />
        <span className="unit">ft</span>
        <input
          type="number"
          min="0"
          max="11"
          value={inch}
          onChange={(e) => onInch(e.target.value)}
        />
        <span className="unit">in</span>
      </span>
    </label>
  );
}

function RoomSizePanel({
  room,
  onResize,
}: {
  room: Room;
  onResize: (widthM: number, depthM: number) => void;
}) {
  // Draft feet/inches, re-synced whenever the room dimensions change upstream.
  const [w, setW] = useState(mToParts(room.widthM));
  const [d, setD] = useState(mToParts(room.depthM));
  useEffect(() => {
    setW(mToParts(room.widthM));
    setD(mToParts(room.depthM));
  }, [room.widthM, room.depthM]);

  const commit = (wp: { ft: number; inch: number }, dp: { ft: number; inch: number }) => {
    const widthM = feetInchesToM(wp.ft, wp.inch);
    const depthM = feetInchesToM(dp.ft, dp.inch);
    if (widthM >= 0.3 && depthM >= 0.3) onResize(widthM, room.square ? widthM : depthM);
  };

  const row = (
    label: string,
    parts: { ft: number; inch: number },
    set: (p: { ft: number; inch: number }) => void,
    other: { ft: number; inch: number },
    isWidth: boolean,
  ) => (
    <label className="row">
      <span>{label}</span>
      <span className="field">
        <input
          type="number"
          min="0"
          value={parts.ft}
          onChange={(e) => set({ ...parts, ft: Number(e.target.value) || 0 })}
          onBlur={() => (isWidth ? commit(parts, other) : commit(other, parts))}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span className="unit">ft</span>
        <input
          type="number"
          min="0"
          max="11"
          value={parts.inch}
          onChange={(e) => set({ ...parts, inch: Number(e.target.value) || 0 })}
          onBlur={() => (isWidth ? commit(parts, other) : commit(other, parts))}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span className="unit">in</span>
      </span>
    </label>
  );

  return (
    <div className="room">
      <strong>room size</strong>
      {row(room.square ? "side" : "width", w, setW, d, true)}
      {!room.square && row("depth", d, setD, w, false)}
    </div>
  );
}

const AXES = ["width", "depth", "height"] as const;

function SelectionPanel({
  title,
  dims,
  onSetDimension,
  onReset,
  onStash,
  onRemove,
}: {
  title: string;
  dims: [number, number, number];
  onSetDimension: (axis: number, inches: number) => void;
  onReset: () => void;
  onStash: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="panel">
      <strong>{title}</strong>
      <span className="hint">
        ← → rotate · ↑ ↓ resize · type for exact size · R reset · Del remove
      </span>
      {AXES.map((axis, i) => (
        <DimensionField
          key={axis}
          label={axis}
          inches={dims[i]}
          onCommit={(inches) => onSetDimension(i, inches)}
        />
      ))}
      <div className="panel-actions">
        <button type="button" className="reset" onClick={onReset}>
          reset size
        </button>
        <button type="button" className="reset" onClick={onStash}>
          set aside
        </button>
        <button type="button" className="reset danger" onClick={onRemove}>
          remove
        </button>
      </div>
    </div>
  );
}

// A door exposes width + height; a window adds a sill (floor-to-opening) height.
const OPENING_AXES = ["width", "height", "sill"] as const;

function OpeningPanel({
  kind,
  dims,
  onSetDimension,
  onRemove,
}: {
  kind: "door" | "window";
  dims: [number, number, number];
  onSetDimension: (axis: number, inches: number) => void;
  onRemove: () => void;
}) {
  const axisCount = kind === "window" ? 3 : 2; // doors sit on the floor: no sill
  return (
    <div className="panel">
      <strong>{kind}</strong>
      <span className="hint">drag along the wall · type for exact size · Del remove</span>
      {OPENING_AXES.slice(0, axisCount).map((axis, i) => (
        <DimensionField
          key={axis}
          label={axis}
          inches={dims[i]}
          onCommit={(inches) => onSetDimension(i, inches)}
        />
      ))}
      <div className="panel-actions">
        <button type="button" className="reset danger" onClick={onRemove}>
          remove
        </button>
      </div>
    </div>
  );
}

function DimensionField({
  label,
  inches,
  onCommit,
}: {
  label: string;
  inches: number;
  onCommit: (inches: number) => void;
}) {
  const [draft, setDraft] = useState(inches.toFixed(1));
  useEffect(() => setDraft(inches.toFixed(1)), [inches]);

  const commit = () => {
    const value = Number(draft);
    if (Number.isFinite(value) && value > 0) onCommit(value);
    else setDraft(inches.toFixed(1));
  };

  return (
    <label className="row">
      <span>{label}</span>
      <span className="field">
        <input
          type="number"
          min="0.1"
          step="0.5"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <span className="unit">in</span>
      </span>
    </label>
  );
}

// Labels only — the finish each ordinal means lives in Rust (`FloorMaterial`,
// `WallMaterial`), and the look it maps to lives in the viewport.
const FLOORS = ["Light wood", "Dark wood", "Tile", "Concrete"] as const;
const WALLS = ["Warm white", "Cool grey", "Greige", "Sage", "Clay"] as const;
const LIGHTING = ["Noon", "Morning", "Evening", "Overcast"] as const;

function FinishPicker({
  floor,
  wall,
  lighting,
  onPickFloor,
  onPickWall,
  onPickLighting,
}: {
  floor: number;
  wall: number;
  lighting: number;
  onPickFloor: (index: number) => void;
  onPickWall: (index: number) => void;
  onPickLighting: (index: number) => void;
}) {
  return (
    <div className="floors">
      <SwatchRow label="floor" options={FLOORS} active={floor} onPick={onPickFloor} />
      <SwatchRow label="walls" options={WALLS} active={wall} onPick={onPickWall} />
      <SwatchRow
        label="light"
        options={LIGHTING}
        active={lighting}
        onPick={onPickLighting}
      />
    </div>
  );
}

function SwatchRow({
  label,
  options,
  active,
  onPick,
}: {
  label: string;
  options: readonly string[];
  active: number;
  onPick: (index: number) => void;
}) {
  return (
    <>
      <strong>{label}</strong>
      <div className="swatches">
        {options.map((option, i) => (
          <button
            key={option}
            type="button"
            className={i === active ? "swatch active" : "swatch"}
            onClick={() => onPick(i)}
          >
            {option}
          </button>
        ))}
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <span className="row">
      <span>{label}</span>
      <span>{value}</span>
    </span>
  );
}
