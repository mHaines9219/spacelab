import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogEntry } from "./viewport";
import type { Thumbnailer } from "./thumbnailer";
import {
  FLOOR_LABELS,
  LIGHT_LABELS,
  WALL_LABELS,
  type StyleProposal,
  type StyleResolver,
} from "./styleSearch";
import { defaultResolver } from "./resolver";

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
export function CatalogPanel({
  onPlace,
  onApplyStyle,
  thumbnailer,
  resolver = defaultResolver,
}: {
  onPlace: (entry: CatalogEntry) => void;
  /** Apply a whole AI proposal: place its furniture and set its finishes. */
  onApplyStyle: (proposal: StyleProposal) => void | Promise<void>;
  thumbnailer: Thumbnailer;
  /** Defaults to the app resolver (LLM if a key is configured, else local); overridable
   * so a test can swap it. */
  resolver?: StyleResolver;
}) {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [failed, setFailed] = useState(false);

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
      <StyleSearch
        entries={entries}
        thumbnailer={thumbnailer}
        resolver={resolver}
        onApplyStyle={onApplyStyle}
      />
      <div className="catalog-head">
        <strong>
          furniture{" "}
          {entries.length > 0 && (
            <span className="catalog-count">
              {filtered.length === entries.length
                ? entries.length
                : `${filtered.length}/${entries.length}`}
            </span>
          )}
        </strong>
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
            <Thumb url={`/assets/${e.blob}`} alt={e.title} thumbnailer={thumbnailer} />
            <span className="card-name">{e.title}</span>
            <span className="card-dims">{dimsLabel(e.dims_m)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * AI-assisted style search. The user describes a look ("a cozy 70s bedroom") and the
 * resolver proposes a coherent set plus floor/wall/light finishes; the user reviews the
 * proposal and applies it. Applying routes through the same Rust paths a manual place or
 * finish click uses — this component only produces intent.
 */
function StyleSearch({
  entries,
  thumbnailer,
  resolver,
  onApplyStyle,
}: {
  entries: CatalogEntry[];
  thumbnailer: Thumbnailer;
  resolver: StyleResolver;
  onApplyStyle: (proposal: StyleProposal) => void | Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [proposal, setProposal] = useState<StyleProposal | null>(null);
  const [busy, setBusy] = useState(false);

  const design = async () => {
    const text = prompt.trim();
    if (!text || entries.length === 0 || busy) return;
    setBusy(true);
    try {
      setProposal(await resolver(text, entries));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai">
      <div className="ai-head">
        <strong>design with AI</strong>
      </div>
      <div className="ai-input">
        <input
          className="ai-prompt"
          type="text"
          placeholder="a cozy 70s bedroom…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && design()}
        />
        <button
          type="button"
          className="ai-go"
          disabled={!prompt.trim() || entries.length === 0 || busy}
          onClick={design}
        >
          {busy ? "…" : "design"}
        </button>
      </div>

      {proposal && (
        <div className="ai-proposal">
          <div className="ai-label">
            {proposal.styleLabel}
            <span className="ai-source" title="which resolver produced this">
              {proposal.source}
            </span>
          </div>
          {proposal.rationale.map((line, i) => (
            <p key={i} className="ai-why">
              {line}
            </p>
          ))}
          {proposal.furniture.length > 0 && (
            <div className="ai-strip">
              {proposal.furniture.map((p, i) => (
                <span key={i} className="ai-chip" title={p.entry.title}>
                  <Thumb
                    url={`/assets/${p.entry.blob}`}
                    alt={p.entry.title}
                    thumbnailer={thumbnailer}
                  />
                  {p.count > 1 && <span className="ai-count">×{p.count}</span>}
                </span>
              ))}
            </div>
          )}
          <div className="ai-finishes">
            <span>{FLOOR_LABELS[proposal.finishes.floorIndex]}</span>
            <span>{WALL_LABELS[proposal.finishes.wallIndex]}</span>
            <span>{LIGHT_LABELS[proposal.finishes.lightingIndex]}</span>
          </div>
          <div className="ai-actions">
            <button
              type="button"
              className="ai-apply"
              disabled={proposal.furniture.length === 0 || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onApplyStyle(proposal);
                  setProposal(null);
                } finally {
                  setBusy(false);
                }
              }}
            >
              place this set
            </button>
            <button type="button" className="reset" onClick={() => setProposal(null)}>
              dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A catalog thumbnail that renders its GLB only once it scrolls into view. */
export function Thumb({
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
