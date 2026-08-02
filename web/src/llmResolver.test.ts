import { describe, expect, it, vi } from "vitest";
import {
  buildMessages,
  createLlmResolver,
  parseModelJson,
  proposalFromModel,
} from "./llmResolver";
import type { CatalogEntry } from "./viewport";

const entry = (asset_id: string, category: string, tags: string[]): CatalogEntry => ({
  asset_id,
  title: asset_id,
  category,
  tags,
  dims_m: { w: 1, h: 1, d: 1 },
  blob: `models/${asset_id}.glb`,
});

const CATALOG: CatalogEntry[] = [
  entry("couch", "seating", ["sofa", "couch"]),
  entry("bed", "bed", ["bed"]),
  entry("nightstand", "storage", ["nightstand"]),
  entry("lamp", "lighting", ["lamp"]),
];

const idsOf = (furniture: { entry: CatalogEntry; count: number }[]) =>
  furniture.flatMap((f) => Array(f.count).fill(f.entry.asset_id));

/** A fake OpenRouter chat response whose content is `content`. */
const reply = (content: string, ok = true, status = 200) =>
  vi.fn(async () => ({
    ok,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
  })) as unknown as typeof fetch;

const GOOD =
  '{"styleLabel":"retro bedroom","furniture":[{"asset_id":"bed","count":1},' +
  '{"asset_id":"nightstand","count":2}],"floorIndex":1,"wallIndex":4,' +
  '"lightingIndex":2,"rationale":["Warm and low-lit."]}';

describe("parseModelJson", () => {
  it("extracts the object from a fenced, prose-wrapped reply", () => {
    const wrapped = "Sure!\n```json\n{\"floorIndex\": 2}\n```\nHope that helps.";
    expect(parseModelJson(wrapped)).toEqual({ floorIndex: 2 });
  });

  it("throws when there is no object", () => {
    expect(() => parseModelJson("no json here")).toThrow();
  });
});

describe("proposalFromModel", () => {
  it("drops unknown ids, clamps counts to four, and caps the set at eight", () => {
    const answer = {
      styleLabel: "x",
      furniture: [
        { asset_id: "ghost", count: 2 }, // not in catalog → dropped
        { asset_id: "nightstand", count: 99 }, // clamped to 4
        { asset_id: "couch", count: 6 }, // clamped to 4, but cap stops it at 8 total
      ],
      floorIndex: 1,
      wallIndex: 4,
      lightingIndex: 2,
      rationale: ["ok"],
    };
    const p = proposalFromModel(answer, "prompt", CATALOG, "test-model");
    const ids = idsOf(p.furniture);
    expect(ids).not.toContain("ghost");
    expect(ids.length).toBe(8); // 4 nightstands + 4 couches, cap reached
    expect(ids.filter((i) => i === "nightstand").length).toBe(4);
  });

  it("clamps out-of-range finish indices back to zero", () => {
    const p = proposalFromModel(
      { furniture: [{ asset_id: "bed", count: 1 }], floorIndex: 99, wallIndex: -1, lightingIndex: 2 },
      "prompt",
      CATALOG,
      "m",
    );
    expect(p.finishes.floorIndex).toBe(0);
    expect(p.finishes.wallIndex).toBe(0);
    expect(p.finishes.lightingIndex).toBe(2);
  });
});

describe("buildMessages", () => {
  it("hands the model the real asset ids and the finish ordinals", () => {
    const [system, user] = buildMessages("a 70s bedroom", CATALOG);
    expect(system.content).toMatch(/asset_id/);
    expect(user.content).toContain("nightstand");
    expect(user.content).toMatch(/1=Dark wood/); // finish index enumerated
  });
});

describe("createLlmResolver", () => {
  const config = { apiKey: "sk-or-test" };

  it("returns the model's validated proposal, tagged with the model as source", async () => {
    const resolve = createLlmResolver({ ...config, model: "test/model" }, reply(GOOD));
    const p = await resolve("a 70s bedroom", CATALOG);
    expect(p.source).toBe("test/model");
    expect(idsOf(p.furniture).filter((i) => i === "nightstand").length).toBe(2);
    expect(p.finishes).toEqual({ floorIndex: 1, wallIndex: 4, lightingIndex: 2 });
  });

  it("falls back to the local resolver on a non-200 response", async () => {
    const resolve = createLlmResolver(config, reply("", false, 500));
    const p = await resolve("a 70s bedroom", CATALOG);
    expect(p.source).toContain("offline fallback");
    expect(p.furniture.length).toBeGreaterThan(0); // the heuristic still furnishes it
  });

  it("falls back when the network throws", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const p = await createLlmResolver(config, throwing)("a minimal office", CATALOG);
    expect(p.source).toContain("offline fallback");
  });

  it("falls back when the model picks nothing usable", async () => {
    const empty = reply('{"styleLabel":"x","furniture":[],"floorIndex":0,"wallIndex":0,"lightingIndex":0,"rationale":[]}');
    const p = await createLlmResolver(config, empty)("a cozy den", CATALOG);
    expect(p.source).toContain("offline fallback");
  });
});
