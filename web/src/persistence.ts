/**
 * The browser half of M5: where a saved room lives and when it gets written.
 *
 * Rust owns the *format* — the versioned envelope, the id allocators, and whether a
 * given document is loadable (see `PLANS/M5_SAVE_FORMAT.md`). This module owns only
 * the storage and the timing, and deliberately never inspects the JSON it carries.
 * Parsing it here would be a second opinion about the format, which is exactly the
 * "second source of truth" the plan rules out.
 */

/** One autosave slot. The format's own version lives inside the envelope, not here. */
const STORAGE_KEY = "spacelab.room";

/**
 * A one-deep backup of the room as it was immediately before an import replaced it.
 *
 * Loading clears the undo history — it has to, because a load is the only operation
 * that moves an id allocator *backwards*, so a rewound scene beside a forward allocator
 * would hand out ids that already exist. That makes import the one destructive action
 * in the app with no way back, and it shares its storage slot with autosave: import the
 * wrong file and the next autosave tick writes it over the room you meant to keep.
 *
 * So the room is copied here first. Undo can't reach across a load, but this can.
 */
const PREVIOUS_KEY = "spacelab.room.previous";

/**
 * How long the document must sit still before an autosave. A drag fires per pointer
 * move, and each save serialises the whole document — writing on every one would
 * re-encode the room dozens of times a second for one gesture. 800 ms is past the end
 * of a drag but short enough that a browser crash costs at most the last edit.
 */
const AUTOSAVE_IDLE_MS = 800;

/**
 * `localStorage` throws rather than returning null in several ordinary situations —
 * Safari private browsing, storage disabled by policy, quota exhausted. None of them
 * should take the app down, so every access goes through here.
 */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The raw saved envelope, or null if there is nothing readable to restore. */
export function readSaved(): string | null {
  try {
    return storage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Persist an envelope. Returns false if storage refused it (quota, private mode). */
export function writeSaved(json: string): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(STORAGE_KEY, json);
    return true;
  } catch {
    // Most often QuotaExceededError. The room is still fine in memory; only the
    // autosave is lost, and the caller surfaces that rather than throwing.
    return false;
  }
}

/** Forget the autosave. Used when a save turns out to be unloadable. */
export function clearSaved(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do — the slot is already unreachable */
  }
}

/**
 * Copy the room aside before an import overwrites it. Call this *before* the load, so
 * that a load which succeeds but wasn't what the user wanted is still recoverable.
 */
export function stashPrevious(json: string): void {
  try {
    storage()?.setItem(PREVIOUS_KEY, json);
  } catch {
    // Out of quota. The import still proceeds — refusing it would be a worse outcome
    // than proceeding without the safety net, but the caller is told so it can say so.
  }
}

/** The room as it was before the last import, if one is recoverable. */
export function readPrevious(): string | null {
  try {
    return storage()?.getItem(PREVIOUS_KEY) ?? null;
  } catch {
    return null;
  }
}

export function clearPrevious(): void {
  try {
    storage()?.removeItem(PREVIOUS_KEY);
  } catch {
    /* already unreachable */
  }
}

export type Autosave = {
  /** The document changed; schedule a write once it settles. */
  markDirty: () => void;
  /** Write immediately if dirty — on tab hide, and before an explicit export. */
  flush: () => void;
  dispose: () => void;
};

/**
 * Debounced autosave. `serialise` returns the envelope, or null when the document
 * cannot be saved yet (the Rust binding is the source of that answer); `onError` is
 * called when storage refuses a write, so the UI can say so rather than fail silently.
 *
 * Also flushes when the tab goes away. A trailing debounce drops the *last* edit if the
 * tab closes inside the window — which is exactly when someone is most confident they
 * are finished, so it is the edit they would most notice losing. `visibilitychange` and
 * `pagehide` are the pair that fire reliably; `beforeunload` is the one everybody
 * reaches for first and it is unreliable on mobile Safari.
 */
export function createAutosave(
  serialise: () => string | null,
  onError?: (reason: "storage") => void,
): Autosave {
  let timer: number | undefined;
  let dirty = false;

  const write = () => {
    if (!dirty) return;
    const json = serialise();
    // Null means "not saveable yet", which is not an error worth reporting; the
    // document stays dirty so the next opportunity retries it.
    if (json === null) return;
    dirty = false;
    if (!writeSaved(json)) onError?.("storage");
  };

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    write();
  };

  const onHide = () => {
    if (document.visibilityState === "hidden") flush();
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", flush);

  return {
    markDirty: () => {
      dirty = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        write();
      }, AUTOSAVE_IDLE_MS);
    },
    flush,
    dispose: () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Offer an envelope as a `.json` download — the export half, and the bug-report artefact. */
export function downloadJson(json: string, filename = "room.json"): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking synchronously can cancel the download in some browsers; one turn of the
  // event loop is enough for the click to have been handled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Read a user-chosen file as text, for import. Rejects if the file is unreadable. */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.readAsText(file);
  });
}
