import { useEffect, useRef, useState } from "react";
import { createViewport, type Stats } from "./viewport";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    let dispose: (() => void) | undefined;
    createViewport(canvas, setStats).then(
      (teardown) => (dispose = teardown),
      (cause) => setError(String(cause)),
    );
    return () => dispose?.();
  }, []);

  return (
    <>
      <canvas ref={canvasRef} />
      <div className="hud">
        <strong>M0 spike</strong>
        {error ? (
          <span className="error">{error}</span>
        ) : stats ? (
          <>
            <Row label="fps" value={stats.fps.toFixed(0)} />
            <Row label="frame" value={`${stats.frameMs.toFixed(2)} ms`} />
            <Row label="render (cpu)" value={`${stats.renderMs.toFixed(2)} ms`} />
            <Row
              label="rust↔js drag"
              value={`${stats.dragUs.toFixed(2)} µs`}
            />
            <Row label="triangles" value={stats.triangles.toLocaleString()} />
            <Row
              label="wasm"
              value={
                stats.wasmBytes ? `${(stats.wasmBytes / 1024).toFixed(0)} KB` : "—"
              }
            />
            <Row label="anchor" value={stats.snapped ? "against wall" : "floor"} />
          </>
        ) : (
          <span>loading…</span>
        )}
        <span className="hint">drag the chair · orbit to look around</span>
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
