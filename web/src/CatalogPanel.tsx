import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogEntry } from "./viewport";
import { createThumbnailer, type Thumbnailer } from "./thumbnailer";

const IN_PER_M = 39.3700787;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const catLabel = (c: string) => (c === "all" ? "All" : cap(c));
const dimsLabel = (d: { w: number; h: number; d: number }) =>
  `${Math.round(d.w * IN_PER_M)} × ${Math.round(d.d * IN_PER_M)} in`;

/**
 * Floating furniture catalog. Reads /assets/catalog.json, filters by a broad category
 * and a free-text search, and places the clicked asset in the room. Placement itself
 * goes through Rust (via the viewport handle); this panel is pure browse + intent.
 */
export function CatalogPanel({ onPlace }: { onPlace: (entry: CatalogEntry) => void }) {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [failed, setFailed] = useState(false);

  const thumbRef = useRef<Thumbnailer | null>(null);
  if (!thumbRef.current) thumbRef.current = createThumbnailer();
  useEffect(() => () => thumbRef.current?.dispose(), []);

  useEffect(() => {
    fetch("/assets/catalog.json")
      .then((r) => r.json())
      .then((data: CatalogEntry[]) => setEntries(data))
      .catch(() => setFailed(true));
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) if (e.category) set.add(e.category);
    return ["all", ...[...set].sort()];
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (category !== "all" && e.category !== category) return false;
      if (!q) return true;
      return (
        e.title.toLowerCase().includes(q) ||
        (e.category ?? "").toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [entries, category, query]);

  return (
    <div className="catalog">
      <div className="catalog-head">
        <strong>furniture</strong>
        <input
          className="catalog-search"
          type="search"
          placeholder="search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="catalog-cats">
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            className={c === category ? "cat active" : "cat"}
            onClick={() => setCategory(c)}
          >
            {catLabel(c)}
          </button>
        ))}
      </div>
      <div className="catalog-list">
        {failed && <p className="catalog-empty">Couldn’t load the catalog.</p>}
        {!failed && entries.length === 0 && <p className="catalog-empty">Loading…</p>}
        {entries.length > 0 && filtered.length === 0 && (
          <p className="catalog-empty">No matches.</p>
        )}
        {filtered.map((e) => (
          <button
            key={e.asset_id}
            type="button"
            className="catalog-card"
            title={`Add ${e.title}`}
            onClick={() => onPlace(e)}
          >
            <Thumb url={`/assets/${e.blob}`} alt={e.title} thumbnailer={thumbRef.current!} />
            <span className="card-name">{e.title}</span>
            <span className="card-dims">{dimsLabel(e.dims_m)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A catalog thumbnail that renders its GLB only once it scrolls into view. */
function Thumb({
  url,
  alt,
  thumbnailer,
}: {
  url: string;
  alt: string;
  thumbnailer: Thumbnailer;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          io.disconnect();
          thumbnailer
            .render(url)
            .then((d) => !cancelled && setSrc(d))
            .catch(() => {});
        }
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [url, thumbnailer]);

  return (
    <span className="thumb" ref={ref}>
      {src ? <img src={src} alt={alt} /> : <span className="thumb-spinner" />}
    </span>
  );
}
