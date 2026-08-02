import { describe, expect, it } from "vitest";
import { localStyleResolver, tokenize, type StyleProposal } from "./styleSearch";
import type { CatalogEntry } from "./viewport";

// A compact stand-in for the real catalog, holding the categories/tags the resolver
// keys off. It mirrors the shipping catalog's shape without depending on its exact
// contents, so these tests describe the resolver's behaviour rather than the asset list.
const entry = (
  asset_id: string,
  category: string,
  tags: string[],
  title = asset_id,
): CatalogEntry => ({
  asset_id,
  title,
  category,
  tags,
  dims_m: { w: 1, h: 1, d: 1 },
  blob: `models/${asset_id}.glb`,
});

const CATALOG: CatalogEntry[] = [
  entry("couch", "seating", ["sofa", "couch", "living-room"], "Couch, Medium"),
  entry("armchair", "seating", ["chair", "armchair", "accent", "lounge"], "Sheen Armchair"),
  entry("dining-chair", "seating", ["chair", "dining", "desk"], "Chair"),
  entry("round-table", "table", ["table", "round", "dining"], "Round Table"),
  entry("nightstand", "storage", ["nightstand", "bedside", "bedroom"], "Night Stand"),
  entry("cabinet", "storage", ["cabinet", "sideboard", "storage"], "Cabinet"),
  entry("bookcase", "storage", ["bookcase", "shelf", "storage"], "Bookcase"),
  entry("floor-lamp", "lighting", ["floor-lamp", "lamp", "lighting"], "Floor Lamp"),
  entry("bed", "bed", ["bed", "double", "bedroom"], "Bed (Double)"),
  entry("rug", "decor", ["rug", "floor", "decor"], "Rug"),
  entry("plant", "decor", ["plant", "greenery", "decor"], "Potted Plant"),
];

const idsOf = (p: StyleProposal) => p.furniture.flatMap((f) => Array(f.count).fill(f.entry.asset_id));

describe("tokenize", () => {
  it("keeps era digits and drops filler words", () => {
    expect(tokenize("I want a 70s bedroom set")).toEqual(["70s", "bedroom"]);
  });
});

describe("localStyleResolver", () => {
  it("furnishes a bedroom with a bed and two nightstands", async () => {
    const p = await localStyleResolver("a cozy 70s bedroom", CATALOG);
    const ids = idsOf(p);
    expect(ids).toContain("bed");
    // Two flanking nightstands: the composition asks for two of the bedside slot, and the
    // nightstand is the only bedside-tagged storage, so it repeats.
    expect(ids.filter((id) => id === "nightstand").length).toBe(2);
    expect(ids).not.toContain("couch"); // a sofa is not bedroom furniture
  });

  it("reads '70s' as retro finishes: dark wood, clay, evening", async () => {
    const p = await localStyleResolver("70s living room", CATALOG);
    expect(p.finishes).toEqual({ floorIndex: 1, wallIndex: 4, lightingIndex: 2 });
  });

  it("reads 'minimal' as light wood, warm white, noon", async () => {
    const p = await localStyleResolver("a minimal modern space", CATALOG);
    expect(p.finishes).toEqual({ floorIndex: 0, wallIndex: 0, lightingIndex: 0 });
  });

  it("defaults to a living room when no room word is present", async () => {
    const p = await localStyleResolver("something industrial", CATALOG);
    expect(p.styleLabel).toContain("living room");
    const ids = idsOf(p);
    expect(ids).toContain("couch"); // the living-room sofa slot
  });

  it("industrial reads as concrete floor and overcast light", async () => {
    const p = await localStyleResolver("industrial loft", CATALOG);
    expect(p.finishes.floorIndex).toBe(3); // Concrete
    expect(p.finishes.lightingIndex).toBe(3); // Overcast
  });

  it("blends two matched styles' votes over the neutral base", async () => {
    // "sage" (botanical) sets wall Sage(3); the room word 'office' does not vote on walls.
    const p = await localStyleResolver("a sage green office", CATALOG);
    expect(p.finishes.wallIndex).toBe(3);
    expect(p.styleLabel).toContain("office");
  });

  it("furnishes an office with a desk-ish table and a bookcase, no bed", async () => {
    const ids = idsOf(await localStyleResolver("home office", CATALOG));
    expect(ids).toContain("bookcase");
    expect(ids).not.toContain("bed");
  });

  it("pulls in an explicitly named piece the room template omits", async () => {
    // A bedroom composition has no bookcase slot; naming it should still place one.
    const ids = idsOf(await localStyleResolver("a bedroom with a bookcase", CATALOG));
    expect(ids).toContain("bookcase");
  });

  it("caps the set at eight pieces", async () => {
    const p = await localStyleResolver("a cozy 70s living room with a plant and a rug", CATALOG);
    expect(idsOf(p).length).toBeLessThanOrEqual(8);
  });

  it("always returns valid finish ordinals, even for an empty prompt", async () => {
    const p = await localStyleResolver("", CATALOG);
    expect(p.finishes.floorIndex).toBeGreaterThanOrEqual(0);
    expect(p.finishes.floorIndex).toBeLessThanOrEqual(3);
    expect(p.finishes.wallIndex).toBeLessThanOrEqual(4);
    expect(p.finishes.lightingIndex).toBeLessThanOrEqual(3);
  });

  it("produces a rationale that names the finishes it chose", async () => {
    const p = await localStyleResolver("70s bedroom", CATALOG);
    expect(p.rationale.join(" ")).toMatch(/dark wood/i);
    expect(p.rationale.join(" ")).toMatch(/clay/i);
  });
});
