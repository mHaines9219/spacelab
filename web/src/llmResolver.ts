import type { CatalogEntry } from "./viewport";
import {
  assembleProposal,
  clampIndex,
  FINISH_COUNTS,
  FLOOR_LABELS,
  LIGHT_LABELS,
  localStyleResolver,
  MAX_FURNITURE,
  WALL_LABELS,
  type StyleProposal,
  type StyleResolver,
} from "./styleSearch";

/**
 * An OpenRouter-backed {@link StyleResolver}. Same contract as the local heuristic — this
 * is the "swap the model behind the seam" the local resolver was built to allow — so the
 * catalog panel and the apply path do not change to use it.
 *
 * OpenRouter speaks the OpenAI chat-completions shape, so this is one `fetch`. The model's
 * answer is never trusted: it is funnelled through {@link assembleProposal}, which drops
 * hallucinated ids, clamps counts and finish ordinals, and caps the set — the same
 * guarantees the local resolver already met. **Any failure — network down, non-200, junk
 * JSON, or an empty set after validation — falls back to the local resolver** so the
 * feature degrades to offline-quality rather than breaking.
 *
 * The key is read from `import.meta.env.VITE_OPENROUTER_API_KEY` at build time, which means
 * it is embedded in the bundle a browser downloads. That is acceptable for a local,
 * single-user tool and is called out in `README.md` and `PLAN.md`; a shared deployment
 * would move this call behind a tiny proxy, which — because it is the same `fetch` — is a
 * later change to this file alone.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 20_000;

export type LlmConfig = {
  apiKey: string;
  model?: string;
  /** Optional OpenRouter attribution headers; harmless to omit. */
  referer?: string;
  title?: string;
};

/** The JSON we ask the model to return. Kept flat and id-based so validation is trivial. */
type ModelAnswer = {
  styleLabel?: unknown;
  furniture?: unknown;
  floorIndex?: unknown;
  wallIndex?: unknown;
  lightingIndex?: unknown;
  rationale?: unknown;
};

/** Build the two chat messages. The catalog is handed over as compact JSON so the model
 * chooses from real ids, and the finish options are enumerated with their indices so it
 * answers in the ordinals the document actually takes. */
export function buildMessages(prompt: string, catalog: CatalogEntry[]) {
  const items = catalog.map((e) => ({
    asset_id: e.asset_id,
    title: e.title,
    category: e.category,
    tags: e.tags,
  }));
  const finishes = {
    floor: FLOOR_LABELS.map((label, i) => `${i}=${label}`).join(", "),
    wall: WALL_LABELS.map((label, i) => `${i}=${label}`).join(", "),
    light: LIGHT_LABELS.map((label, i) => `${i}=${label}`).join(", "),
  };
  const system =
    "You are an interior designer furnishing a single room in a 3D layout tool. " +
    "Choose a coherent set of pieces from the provided catalog and pick floor, wall and " +
    "lighting finishes that suit the requested look. Only use asset_ids from the catalog. " +
    `Place at most ${MAX_FURNITURE} pieces total; a count above 1 means repeat that piece ` +
    "(e.g. two nightstands). Reply with ONLY a JSON object, no prose, of the form: " +
    '{"styleLabel": string, "furniture": [{"asset_id": string, "count": number}], ' +
    '"floorIndex": number, "wallIndex": number, "lightingIndex": number, ' +
    '"rationale": [string]}.';
  const user =
    `Look wanted: "${prompt}"\n\n` +
    `Catalog: ${JSON.stringify(items)}\n\n` +
    `Floor options: ${finishes.floor}\n` +
    `Wall options: ${finishes.wall}\n` +
    `Lighting options: ${finishes.light}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Pull the JSON object out of a model reply, tolerating a ```json fence or stray prose
 * around it. Throws if there is no object to parse. */
export function parseModelJson(content: string): ModelAnswer {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model reply");
  return JSON.parse(content.slice(start, end + 1)) as ModelAnswer;
}

/** Validate and shape a raw model answer into a proposal. Pure — no network — so it is the
 * unit-testable core of the LLM path. */
export function proposalFromModel(
  answer: ModelAnswer,
  prompt: string,
  catalog: CatalogEntry[],
  source: string,
): StyleProposal {
  const picks = Array.isArray(answer.furniture)
    ? (answer.furniture as unknown[]).flatMap((p) => {
        if (typeof p !== "object" || p === null) return [];
        const { asset_id, count } = p as { asset_id?: unknown; count?: unknown };
        if (typeof asset_id !== "string") return [];
        return [{ asset_id, count: typeof count === "number" ? count : 1 }];
      })
    : [];
  const rationale = Array.isArray(answer.rationale)
    ? (answer.rationale as unknown[]).filter((l): l is string => typeof l === "string")
    : [];
  const styleLabel = typeof answer.styleLabel === "string" ? answer.styleLabel : prompt;
  return assembleProposal({
    prompt,
    catalog,
    picks,
    finishes: {
      floorIndex: clampIndex(answer.floorIndex, FINISH_COUNTS.floor, 0),
      wallIndex: clampIndex(answer.wallIndex, FINISH_COUNTS.wall, 0),
      lightingIndex: clampIndex(answer.lightingIndex, FINISH_COUNTS.light, 0),
    },
    styleLabel,
    rationale: rationale.length ? rationale : ["Chosen by the AI designer."],
    source,
  });
}

/** Build an OpenRouter-backed resolver. `fetchImpl` is injectable so tests drive it without
 * a network. */
export function createLlmResolver(
  config: LlmConfig,
  fetchImpl: typeof fetch = fetch,
): StyleResolver {
  const model = config.model || DEFAULT_MODEL;
  return async (prompt, catalog) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchImpl(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            ...(config.referer ? { "HTTP-Referer": config.referer } : {}),
            ...(config.title ? { "X-Title": config.title } : {}),
          },
          body: JSON.stringify({
            model,
            messages: buildMessages(prompt, catalog),
            response_format: { type: "json_object" },
            temperature: 0.7,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("empty model reply");
      const proposal = proposalFromModel(parseModelJson(content), prompt, catalog, model);
      // An empty set means the model picked nothing usable — fall through to the heuristic
      // rather than showing a proposal with nothing to place.
      if (proposal.furniture.length === 0) throw new Error("no usable furniture in reply");
      return proposal;
    } catch (cause) {
      console.warn("AI style search fell back to the local resolver:", cause);
      const local = await localStyleResolver(prompt, catalog);
      return { ...local, source: `${local.source} (offline fallback)` };
    }
  };
}
