import type { BullpenItem } from "./viewport";
import type { Thumbnailer } from "./thumbnailer";
import { Thumb } from "./CatalogPanel";

/**
 * The bullpen: a tray of furnishings the user has set aside. Each card re-imports its
 * item into the room on click (bringing back its size and rotation, which Rust kept),
 * or discards it with the ✕. Membership is document state read back from Rust; this
 * panel is pure browse + intent, like the catalog.
 */
export function Bullpen({
  items,
  thumbnailer,
  onReimport,
  onDiscard,
}: {
  items: BullpenItem[];
  thumbnailer: Thumbnailer;
  onReimport: (id: number) => void;
  onDiscard: (id: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="bullpen">
      <div className="bullpen-head">
        <strong>set aside</strong>
        <span className="hint">click to bring back</span>
      </div>
      <div className="bullpen-list">
        {items.map(({ id, entry }) => (
          <div key={id} className="bullpen-card">
            <button
              type="button"
              className="bullpen-reimport"
              title={`Bring ${entry.title} back into the room`}
              onClick={() => onReimport(id)}
            >
              <Thumb url={`/assets/${entry.blob}`} alt={entry.title} thumbnailer={thumbnailer} />
              <span className="card-name">{entry.title}</span>
            </button>
            <button
              type="button"
              className="bullpen-discard"
              title={`Discard ${entry.title}`}
              onClick={() => onDiscard(id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
