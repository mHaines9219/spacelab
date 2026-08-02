/**
 * A staleness tripwire for the generated WASM binding.
 *
 * `web/src/wasm/` is gitignored and generated from the Rust crates, so a `git pull`
 * brings TypeScript that calls new methods while leaving the old compiled binding in
 * place. Vite hot-reloads the TypeScript and does not rebuild the WASM, so a dev server
 * left running across a pull produces exactly that mismatch. `npm run dev` rebuilds it;
 * a bare `vite`, `npm run preview`, or an already-running server does not.
 *
 * Without this the mismatch surfaces as a `TypeError` from deep inside the render path
 * — reported, reasonably, as "the page loads but nothing renders" — which reads as a
 * code bug and is not one.
 */

/**
 * Document methods this build of the web layer calls.
 *
 * Keep it to methods whose *absence* means the binding predates code that needs them.
 * This is a tripwire, not an inventory of the whole surface: every name added here is
 * another thing to keep in sync, and a list that drifts out of date fails for the wrong
 * reason.
 */
export const REQUIRED_DOCUMENT_METHODS = [
  "lighting",
  "set_lighting",
  "wall_material",
  "set_wall_material",
  "floor_material",
  "crowded_ids",
  // M5 persistence. Added in the same push that ships them, so this list can never
  // describe a future binding — a guard that fires on a healthy tree teaches people to
  // ignore the message it exists to deliver.
  "save_json",
  "load_json",
  "revision",
  "furnishing_asset_id",
] as const;

/** Which required methods the given prototype is missing, in declaration order. */
export function missingDocumentMethods(
  proto: object,
  required: readonly string[] = REQUIRED_DOCUMENT_METHODS,
): string[] {
  const bag = proto as Record<string, unknown>;
  return required.filter((name) => typeof bag[name] !== "function");
}

/** Throw one instruction instead of failing later on whichever call comes first. */
export function assertBindingIsCurrent(
  proto: object,
  required: readonly string[] = REQUIRED_DOCUMENT_METHODS,
): void {
  const missing = missingDocumentMethods(proto, required);
  if (missing.length === 0) return;
  throw new Error(
    "WASM bindings are stale — rebuild with `npm run wasm` (and restart the dev " +
      `server if one is running). Missing: ${missing.join(", ")}.`,
  );
}
