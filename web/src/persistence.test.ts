/**
 * The failure branches are the point of this module, and they are exactly the ones a
 * real browser cannot be made to reach on demand: you cannot exhaust quota in headless
 * Chromium, and you cannot make `localStorage` throw the way Safari private mode does.
 * So they are forced here by replacing the accessor, and the app-level behaviour is
 * left to the Playwright suite.
 *
 * Every assertion about a failure checks that the caller was **told**, not merely that
 * the call survived — a UI that reports a safety net which was never written is worse
 * than one that offers no net at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPrevious,
  clearSaved,
  createAutosave,
  readPrevious,
  readSaved,
  stashPrevious,
  writeSaved,
} from "./persistence";

const KEY = "spacelab.room";
const PREVIOUS_KEY = "spacelab.room.previous";

/** Swap `window.localStorage` for the duration of a test. */
function useStorage(fake: unknown) {
  Object.defineProperty(window, "localStorage", {
    value: fake,
    configurable: true,
    writable: true,
  });
}

const realStorage = window.localStorage;

beforeEach(() => {
  useStorage(realStorage);
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  useStorage(realStorage);
});

describe("storage that refuses to cooperate", () => {
  it("reports a refused write rather than reporting success", () => {
    useStorage({
      getItem: () => null,
      setItem: () => {
        // What a browser throws once the origin's quota is gone.
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {},
    });
    expect(writeSaved('{"version":1}')).toBe(false);
  });

  it("survives storage being unreachable entirely", () => {
    // Safari private mode and enterprise policy both make the *getter* throw, so this
    // fails before any method is called — a `try` around the access, not the call.
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("access denied");
      },
      configurable: true,
    });
    expect(readSaved()).toBeNull();
    expect(writeSaved("{}")).toBe(false);
    expect(readPrevious()).toBeNull();
    expect(stashPrevious("{}")).toBe(false);
    expect(() => clearSaved()).not.toThrow();
    expect(() => clearPrevious()).not.toThrow();
  });
});

describe("the previous-room safety net", () => {
  it("round-trips the room it was given", () => {
    expect(stashPrevious('{"room":"before"}')).toBe(true);
    expect(readPrevious()).toBe('{"room":"before"}');
    expect(window.localStorage.getItem(PREVIOUS_KEY)).toBe('{"room":"before"}');
  });

  it("says so when the net could not be written", () => {
    // The branch nobody exercises: the import proceeds either way, so the *only*
    // difference between "protected" and "unprotected" is this return value.
    useStorage({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {},
    });
    expect(stashPrevious('{"room":"before"}')).toBe(false);
  });

  it("keeps the autosave and the previous room in separate slots", () => {
    writeSaved('{"room":"current"}');
    stashPrevious('{"room":"before"}');
    expect(readSaved()).toBe('{"room":"current"}');
    expect(readPrevious()).toBe('{"room":"before"}');

    clearSaved();
    expect(readSaved()).toBeNull();
    expect(readPrevious()).toBe('{"room":"before"}');
  });
});

describe("autosave timing", () => {
  beforeEach(() => vi.useFakeTimers());

  it("coalesces a burst of edits into one write", () => {
    const serialise = vi.fn(() => '{"v":1}');
    const auto = createAutosave(serialise);

    // A drag fires per pointer move; each one must not re-encode the document.
    for (let i = 0; i < 20; i++) auto.markDirty();
    expect(serialise).not.toHaveBeenCalled();

    vi.advanceTimersByTime(800);
    expect(serialise).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(KEY)).toBe('{"v":1}');
    auto.dispose();
  });

  it("flushes the pending edit when the tab is hidden", () => {
    const auto = createAutosave(() => '{"v":2}');
    auto.markDirty();

    // Inside the debounce window — the edit someone is most confident they finished.
    vi.advanceTimersByTime(100);
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(window.localStorage.getItem(KEY)).toBe('{"v":2}');
    auto.dispose();
  });

  it("flushes on pagehide, which is the one mobile Safari reliably fires", () => {
    const auto = createAutosave(() => '{"v":3}');
    auto.markDirty();
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event("pagehide"));
    expect(window.localStorage.getItem(KEY)).toBe('{"v":3}');
    auto.dispose();
  });

  it("reports a storage refusal instead of failing silently", () => {
    useStorage({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {},
    });
    const onError = vi.fn();
    const auto = createAutosave(() => '{"v":4}', onError);
    auto.markDirty();
    vi.advanceTimersByTime(800);
    expect(onError).toHaveBeenCalledWith("storage");
    auto.dispose();
  });

  it("stays dirty when the document cannot be serialised yet", () => {
    // Null means "not saveable yet" — the Rust binding is the source of that answer.
    // It is not an error, and the edit must not be dropped on the floor.
    const serialise = vi.fn<() => string | null>(() => null);
    const onError = vi.fn();
    const auto = createAutosave(serialise, onError);

    auto.markDirty();
    vi.advanceTimersByTime(800);
    expect(onError).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(KEY)).toBeNull();

    // Once it can serialise, the still-pending edit is written.
    serialise.mockReturnValue('{"v":5}');
    auto.flush();
    expect(window.localStorage.getItem(KEY)).toBe('{"v":5}');
    auto.dispose();
  });

  it("writes nothing when nothing changed", () => {
    const serialise = vi.fn(() => '{"v":6}');
    const auto = createAutosave(serialise);
    auto.flush();
    expect(serialise).not.toHaveBeenCalled();
    auto.dispose();
  });

  it("stops writing once disposed", () => {
    const auto = createAutosave(() => '{"v":7}');
    auto.markDirty();
    auto.dispose();
    vi.advanceTimersByTime(800);
    expect(window.localStorage.getItem(KEY)).toBeNull();

    // And the listeners are gone, so a later hide cannot resurrect it.
    window.dispatchEvent(new Event("pagehide"));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});
