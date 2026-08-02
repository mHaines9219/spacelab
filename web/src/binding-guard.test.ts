import { describe, expect, it } from "vitest";
import {
  REQUIRED_DOCUMENT_METHODS,
  assertBindingIsCurrent,
  missingDocumentMethods,
} from "./binding-guard";

/** A prototype carrying every required method, as a fresh binding would. */
function currentBinding(): object {
  return Object.fromEntries(REQUIRED_DOCUMENT_METHODS.map((n) => [n, () => {}]));
}

describe("stale binding detection", () => {
  it("passes a binding that has everything", () => {
    expect(missingDocumentMethods(currentBinding())).toEqual([]);
    expect(() => assertBindingIsCurrent(currentBinding())).not.toThrow();
  });

  it("names the missing method rather than failing later on the first call", () => {
    // The exact shape of the reported bug: a binding built before #16 landed
    // `lighting`, so the app died on `doc.lighting is not a function`.
    const stale = currentBinding() as Record<string, unknown>;
    delete stale.lighting;
    delete stale.set_lighting;

    expect(missingDocumentMethods(stale)).toEqual(["lighting", "set_lighting"]);
    expect(() => assertBindingIsCurrent(stale)).toThrow(/lighting, set_lighting/);
  });

  it("tells the reader what to actually do about it", () => {
    // The whole value of the guard is the instruction; a message that merely says
    // "stale" leaves the reader exactly where the TypeError did.
    expect(() => assertBindingIsCurrent({})).toThrow(/npm run wasm/);
    expect(() => assertBindingIsCurrent({})).toThrow(/restart the dev server/);
  });

  it("treats a non-function property as missing", () => {
    // wasm-bindgen puts getters on the prototype too; a name that exists but isn't
    // callable is still a binding that cannot serve the call site.
    const odd = { ...currentBinding(), lighting: 3 };
    expect(missingDocumentMethods(odd)).toEqual(["lighting"]);
  });

  it("ignores inherited junk and only reports what was asked for", () => {
    const stale = currentBinding() as Record<string, unknown>;
    delete stale.crowded_ids;
    expect(missingDocumentMethods(stale, ["crowded_ids"])).toEqual(["crowded_ids"]);
    expect(missingDocumentMethods(stale, ["floor_material"])).toEqual([]);
  });
});
