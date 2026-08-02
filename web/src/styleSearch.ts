import type { CatalogEntry } from "./viewport";

/**
 * AI-assisted style search — the "describe a look and let the app furnish it" feature.
 *
 * This is deliberately a **web-layer** concern, the same way `CatalogPanel`'s keyword
 * filter is: it produces *intent* (which catalog assets to place, which finishes to
 * choose) and nothing here touches the document or the geometry. Everything it proposes
 * is applied by routing back through Rust — `addFromCatalog`, `setFloorMaterial`,
 * `setWallMaterial`, `setLighting` — so Rule #1 (no document/geometry logic in JS) holds.
 *
 * The resolver is a pure function of `(prompt, catalog)`, which is why it lives behind the
 * {@link StyleResolver} type: today it is a local, deterministic heuristic — a curated
 * lexicon of rooms and aesthetics scored against the catalog's own categories and tags,
 * with no network and no key. That fits the plan's "AI is assistive, not core" line and
 * the permissive-only, offline-first constraints. A future LLM-backed resolver satisfies
 * the same signature (returning a `Promise`), so the UI and the apply path do not change
 * when it arrives.
 *
 * It scores by *category and tag*, never by hardcoded `asset_id`, so a growing catalog
 * (the file-based ingest model) improves the results without edits here.
 */

/** Finish choices, as ordinals matching the Rust `FloorMaterial` / `WallMaterial` /
 * `LightingPreset` enums and the label arrays in `App.tsx`. */
export type Finishes = { floorIndex: number; wallIndex: number; lightingIndex: number };

/** A furnishing pick, plus how many of it to place (e.g. two flanking nightstands). */
export type FurniturePick = { entry: CatalogEntry; count: number };

/** What the resolver proposes for a prompt: a set to place, finishes, and the reasons. */
export type StyleProposal = {
  prompt: string;
  /** Ordered picks to place; each may repeat (`count`). Empty when nothing matched. */
  furniture: FurniturePick[];
  finishes: Finishes;
  /** e.g. "1970s retro bedroom" — the room and aesthetic the resolver settled on. */
  styleLabel: string;
  /** Short human-readable lines explaining the choices, for the proposal card. */
  rationale: string[];
  /** Which resolver produced this, shown on the card so the user knows whether the LLM
   * ran or the local heuristic did (including after a fallback). e.g. "local", an
   * OpenRouter model slug, or "…(offline fallback)". */
  source: string;
};

/** Valid ordinal counts for each finish, matching the Rust enums. Exported so the LLM
 * resolver can clamp a model's answer to a real choice. */
export const FINISH_COUNTS = { floor: 4, wall: 5, light: 4 } as const;

/** The most pieces any single proposal will place, whatever the resolver. */
export const MAX_FURNITURE = 8;

/** The pluggable resolver contract. Async so an LLM-backed implementation drops in
 * without touching callers. The local default resolves synchronously but still returns
 * a resolved promise. */
export type StyleResolver = (
  prompt: string,
  catalog: CatalogEntry[],
) => Promise<StyleProposal>;

// --- Lexicon -------------------------------------------------------------------

/** One slot in a room's composition: a category to fill, how many, and tags that bias
 * which entry within the category wins. `prefer` is a nudge, not a filter. */
type Slot = { category: string; count: number; prefer?: string[] };

type RoomKind = {
  key: string;
  label: string;
  /** Prompt words that select this room. */
  match: string[];
  composition: Slot[];
};

/** Living room is the default when no room word is present. */
const ROOMS: RoomKind[] = [
  {
    key: "bedroom",
    label: "bedroom",
    match: ["bedroom", "bed", "sleep", "sleeping", "nightstand", "master"],
    composition: [
      { category: "bed", count: 1 },
      { category: "storage", count: 2, prefer: ["nightstand", "bedside"] },
      { category: "lighting", count: 1 },
      { category: "decor", count: 1, prefer: ["rug"] },
      { category: "decor", count: 1, prefer: ["plant", "greenery"] },
    ],
  },
  {
    key: "office",
    label: "office",
    match: ["office", "desk", "study", "work", "workspace", "studio"],
    composition: [
      { category: "table", count: 1, prefer: ["desk"] },
      { category: "seating", count: 1, prefer: ["desk", "chair"] },
      { category: "storage", count: 1, prefer: ["bookcase", "shelf"] },
      { category: "lighting", count: 1 },
      { category: "decor", count: 1, prefer: ["plant", "greenery"] },
    ],
  },
  {
    key: "dining",
    label: "dining room",
    match: ["dining", "dinner", "kitchen", "eat", "eating"],
    composition: [
      { category: "table", count: 1, prefer: ["dining", "round"] },
      { category: "seating", count: 2, prefer: ["dining", "chair"] },
      { category: "storage", count: 1, prefer: ["cabinet", "sideboard"] },
      { category: "lighting", count: 1 },
      { category: "decor", count: 1, prefer: ["plant", "greenery"] },
    ],
  },
  {
    key: "living",
    label: "living room",
    match: ["living", "lounge", "family", "sitting", "tv", "den"],
    composition: [
      { category: "seating", count: 1, prefer: ["sofa", "couch"] },
      { category: "seating", count: 1, prefer: ["armchair", "accent", "lounge"] },
      { category: "table", count: 1, prefer: ["coffee", "round"] },
      { category: "storage", count: 1, prefer: ["cabinet", "sideboard"] },
      { category: "lighting", count: 1 },
      { category: "decor", count: 1, prefer: ["rug"] },
      { category: "decor", count: 1, prefer: ["plant", "greenery"] },
    ],
  },
];

const DEFAULT_ROOM = ROOMS[ROOMS.length - 1]; // living room

/** An aesthetic. Its finish indices vote for a look; its `affinities` bias furniture
 * scoring toward tags that suit the style. */
type Style = {
  key: string;
  label: string;
  match: string[];
  floorIndex: number;
  wallIndex: number;
  lightingIndex: number;
  affinities: string[];
};

// Finish ordinals (kept in step with App.tsx's FLOORS / WALLS / LIGHTING arrays and the
// Rust enums): floor 0 WoodLight 1 WoodDark 2 Tile 3 Concrete · wall 0 WarmWhite 1 CoolGrey
// 2 Greige 3 Sage 4 Clay · light 0 Noon 1 Morning 2 Evening 3 Overcast.
const STYLES: Style[] = [
  {
    key: "retro70s",
    label: "1970s retro",
    match: ["70s", "1970s", "seventies", "retro", "funky", "disco", "vintage", "groovy"],
    floorIndex: 1,
    wallIndex: 4,
    lightingIndex: 2,
    affinities: ["armchair", "lounge", "accent", "rug", "plant"],
  },
  {
    key: "midcentury",
    label: "mid-century modern",
    match: ["midcentury", "mid-century", "mcm", "danish", "teak", "eames"],
    floorIndex: 1,
    wallIndex: 2,
    lightingIndex: 1,
    affinities: ["armchair", "lounge", "accent"],
  },
  {
    key: "minimal",
    label: "modern minimal",
    match: ["minimal", "minimalist", "scandi", "scandinavian", "nordic", "modern", "clean", "simple"],
    floorIndex: 0,
    wallIndex: 0,
    lightingIndex: 0,
    affinities: [],
  },
  {
    key: "cozy",
    label: "warm & cozy",
    match: ["cozy", "cosy", "warm", "hygge", "snug", "rustic", "farmhouse", "inviting"],
    floorIndex: 1,
    wallIndex: 2,
    lightingIndex: 2,
    affinities: ["rug", "plant", "armchair", "lounge"],
  },
  {
    key: "industrial",
    label: "industrial loft",
    match: ["industrial", "loft", "urban", "concrete", "raw", "warehouse"],
    floorIndex: 3,
    wallIndex: 1,
    lightingIndex: 3,
    affinities: ["cabinet", "bookcase", "shelf"],
  },
  {
    key: "coastal",
    label: "bright & airy",
    match: ["coastal", "beach", "airy", "bright", "breezy", "light", "sunny", "fresh"],
    floorIndex: 0,
    wallIndex: 0,
    lightingIndex: 1,
    affinities: ["plant", "rug"],
  },
  {
    key: "botanical",
    label: "botanical",
    match: ["sage", "green", "botanical", "garden", "nature", "jungle", "earthy"],
    floorIndex: 0,
    wallIndex: 3,
    lightingIndex: 1,
    affinities: ["plant", "greenery", "rug"],
  },
  {
    key: "moody",
    label: "moody",
    match: ["moody", "dark", "dramatic", "masculine", "noir", "bold"],
    floorIndex: 1,
    wallIndex: 1,
    lightingIndex: 2,
    affinities: ["cabinet", "armchair"],
  },
];

/** A gentle neutral applied under every proposal so there is always an answer; matched
 * styles outvote it. */
const BASE_STYLE: Finishes = { floorIndex: 0, wallIndex: 0, lightingIndex: 1 };

const STOPWORDS = new Set([
  "a", "an", "the", "with", "and", "for", "of", "in", "to", "some", "my", "me", "i",
  "want", "like", "give", "make", "set", "room", "look", "feel", "please", "would",
  "this", "that", "into", "up", "it", "add",
]);

/** Lowercase, split on non-alphanumeric, keep meaningful tokens. `70s`/`1970s` survive
 * because digits are kept. */
export function tokenize(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const MATCH_WEIGHT = 3;
const BASE_WEIGHT = 1;

/** Clamp a model-supplied (or otherwise untrusted) index to a valid finish ordinal. */
export function clampIndex(value: unknown, count: number, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < count
    ? (value as number)
    : fallback;
}

/**
 * Turn raw `(asset_id, count)` picks into a validated proposal — the join point every
 * resolver funnels through so the *same* guarantees hold no matter who chose: unknown ids
 * are dropped (a model can hallucinate one; the catalog can shrink under a save), counts
 * are pinned to 1–4, and the whole set is capped at {@link MAX_FURNITURE}. Order is
 * preserved and a repeated id is merged into one pick's count.
 */
export function assembleProposal(input: {
  prompt: string;
  catalog: CatalogEntry[];
  picks: { asset_id: string; count: number }[];
  finishes: Finishes;
  styleLabel: string;
  rationale: string[];
  source: string;
}): StyleProposal {
  const byId = new Map(input.catalog.map((e) => [e.asset_id, e]));
  const order: string[] = [];
  const counts = new Map<string, number>();
  let total = 0;
  for (const raw of input.picks) {
    const entry = byId.get(raw.asset_id);
    if (!entry) continue;
    const want = Math.max(1, Math.min(4, Number.isInteger(raw.count) ? raw.count : 1));
    for (let n = 0; n < want && total < MAX_FURNITURE; n++) {
      if (!counts.has(entry.asset_id)) {
        counts.set(entry.asset_id, 0);
        order.push(entry.asset_id);
      }
      counts.set(entry.asset_id, counts.get(entry.asset_id)! + 1);
      total++;
    }
  }
  return {
    prompt: input.prompt,
    furniture: order.map((id) => ({ entry: byId.get(id)!, count: counts.get(id)! })),
    finishes: {
      floorIndex: clampIndex(input.finishes.floorIndex, FINISH_COUNTS.floor, 0),
      wallIndex: clampIndex(input.finishes.wallIndex, FINISH_COUNTS.wall, 0),
      lightingIndex: clampIndex(input.finishes.lightingIndex, FINISH_COUNTS.light, 0),
    },
    styleLabel: input.styleLabel,
    rationale: input.rationale,
    source: input.source,
  };
}

/** Highest-voted index in a tally, tie broken by the lowest index (stable, arbitrary but
 * deterministic). */
function argmax(votes: Map<number, number>, fallback: number): number {
  let best = fallback;
  let bestVotes = -1;
  for (const [index, count] of [...votes.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestVotes) {
      best = index;
      bestVotes = count;
    }
  }
  return best;
}

function detectRoom(tokens: Set<string>): RoomKind {
  for (const room of ROOMS) {
    if (room.match.some((m) => tokens.has(m))) return room;
  }
  return DEFAULT_ROOM;
}

function detectStyles(tokens: Set<string>): Style[] {
  return STYLES.filter((s) => s.match.some((m) => tokens.has(m)));
}

/** Blend the matched styles' finish votes over a neutral base into one finish choice. */
function resolveFinishes(styles: Style[]): Finishes {
  const floor = new Map<number, number>([[BASE_STYLE.floorIndex, BASE_WEIGHT]]);
  const wall = new Map<number, number>([[BASE_STYLE.wallIndex, BASE_WEIGHT]]);
  const light = new Map<number, number>([[BASE_STYLE.lightingIndex, BASE_WEIGHT]]);
  const add = (m: Map<number, number>, index: number) =>
    m.set(index, (m.get(index) ?? 0) + MATCH_WEIGHT);
  for (const s of styles) {
    add(floor, s.floorIndex);
    add(wall, s.wallIndex);
    add(light, s.lightingIndex);
  }
  return {
    floorIndex: argmax(floor, BASE_STYLE.floorIndex),
    wallIndex: argmax(wall, BASE_STYLE.wallIndex),
    lightingIndex: argmax(light, BASE_STYLE.lightingIndex),
  };
}

/** How well one entry suits a slot, given the prompt and the active style affinities.
 * `usedCount` penalises reusing an entry another slot already claimed, so a varied set
 * is preferred but reuse is still possible when nothing else fits. */
function scoreEntry(
  entry: CatalogEntry,
  slot: Slot,
  promptTokens: Set<string>,
  affinities: Set<string>,
  usedCount: number,
): number {
  let score = 0;
  const titleTokens = tokenize(entry.title);
  for (const tag of entry.tags) {
    if (promptTokens.has(tag)) score += 3;
    if (affinities.has(tag)) score += 2;
    if (slot.prefer?.includes(tag)) score += 2;
  }
  for (const t of titleTokens) if (promptTokens.has(t)) score += 2;
  if (entry.category && promptTokens.has(entry.category)) score += 1;
  return score - usedCount * 4;
}

/**
 * Resolve a prompt into a concrete proposal. Pure and synchronous under the hood; the
 * `Promise` is for signature parity with a future LLM resolver.
 */
export const localStyleResolver: StyleResolver = async (prompt, catalog) => {
  const tokenList = tokenize(prompt);
  const tokens = new Set(tokenList);
  const room = detectRoom(tokens);
  const styles = detectStyles(tokens);
  const finishes = resolveFinishes(styles);
  const affinities = new Set(styles.flatMap((s) => s.affinities));

  const picks: FurniturePick[] = [];
  const used = new Map<string, number>(); // asset_id -> times chosen

  const chooseForSlot = (slot: Slot): CatalogEntry | null => {
    const candidates = catalog.filter((e) => e.category === slot.category);
    if (candidates.length === 0) return null;
    let best: CatalogEntry | null = null;
    let bestScore = -Infinity;
    candidates.forEach((entry, i) => {
      const score =
        scoreEntry(entry, slot, tokens, affinities, used.get(entry.asset_id) ?? 0) -
        i * 0.001; // stable tie-break toward catalog order
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    });
    return best;
  };

  for (const slot of room.composition) {
    if (totalPlaced(picks) >= MAX_FURNITURE) break;
    const entry = chooseForSlot(slot);
    if (!entry) continue;
    const remaining = MAX_FURNITURE - totalPlaced(picks);
    const count = Math.min(slot.count, remaining);
    if (count <= 0) continue;
    picks.push({ entry, count });
    used.set(entry.asset_id, (used.get(entry.asset_id) ?? 0) + count);
  }

  // Extras: a catalog entry the prompt names outright ("…and a bookcase") that the room
  // composition did not already place. Lets a request pull in something off-template.
  for (const entry of catalog) {
    if (totalPlaced(picks) >= MAX_FURNITURE) break;
    if (used.has(entry.asset_id)) continue;
    const named =
      entry.tags.some((t) => tokens.has(t)) ||
      tokenize(entry.title).some((t) => tokens.has(t));
    if (!named) continue;
    picks.push({ entry, count: 1 });
    used.set(entry.asset_id, 1);
  }

  const styleLabel = buildLabel(styles, room);
  const rationale = buildRationale(styles, room, finishes, picks);

  return { prompt, furniture: picks, finishes, styleLabel, rationale, source: "local" };
};

function totalPlaced(picks: FurniturePick[]): number {
  return picks.reduce((n, p) => n + p.count, 0);
}

function buildLabel(styles: Style[], room: RoomKind): string {
  const stylePart = styles.map((s) => s.label).join(" · ");
  return stylePart ? `${stylePart} ${room.label}` : room.label;
}

/** Display labels for each finish ordinal, the single source the proposal card, the
 * rationale text and the LLM prompt all read from. Index matches the Rust enum. */
export const FLOOR_LABELS = ["Light wood", "Dark wood", "Tile", "Concrete"] as const;
export const WALL_LABELS = ["Warm white", "Cool grey", "Greige", "Sage", "Clay"] as const;
export const LIGHT_LABELS = ["Noon", "Morning", "Evening", "Overcast"] as const;

function buildRationale(
  styles: Style[],
  room: RoomKind,
  finishes: Finishes,
  picks: FurniturePick[],
): string[] {
  const lines: string[] = [];
  const styleText = styles.length
    ? styles.map((s) => s.label).join(" and ")
    : "a neutral";
  lines.push(`Read this as ${styleText} ${room.label}.`);
  lines.push(
    `${FLOOR_LABELS[finishes.floorIndex].toLowerCase()} floor, ` +
      `${WALL_LABELS[finishes.wallIndex].toLowerCase()} walls, ` +
      `${LIGHT_LABELS[finishes.lightingIndex].toLowerCase()} light.`,
  );
  if (picks.length) {
    const names = picks
      .map((p) => (p.count > 1 ? `${p.count}× ${p.entry.title}` : p.entry.title))
      .join(", ");
    lines.push(`Furnished with ${names}.`);
  } else {
    lines.push("No catalog pieces matched — try naming a room or a style.");
  }
  return lines;
}
