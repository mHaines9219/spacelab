/**
 * The cloud data layer: a user's profile, their folders, and the projects in them.
 *
 * A "project" is a saved room. Its `document` field is the **opaque** save envelope that
 * Rust's `save_json()` produced — this module never parses or inspects it, exactly as
 * `persistence.ts` never inspects the localStorage copy. That keeps Rule #1 intact: the
 * document's shape is owned by Rust, and the cloud is just another place the same bytes
 * are stored. Row-level security (see the migration) is what scopes every read and write
 * to the signed-in owner; these queries never filter by owner themselves.
 */
import { supabase } from "./supabase";

/** A stored room. `document` is Rust's save envelope, treated as an opaque blob here. */
export type Project = {
  id: string;
  owner: string;
  folder_id: string | null;
  name: string;
  /** Opaque room envelope (parsed JSON of `saveJson()`). Never inspected in JS. */
  document: unknown;
  thumbnail: string | null;
  created_at: string;
  updated_at: string;
};

/** A named grouping of projects — the "folder of projects" in a user's portfolio. */
export type Folder = {
  id: string;
  owner: string;
  name: string;
  created_at: string;
};

/** 1:1 with an auth user. `settings` is a free-form bag the dashboard reads and writes. */
export type Profile = {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function client() {
  if (!supabase) throw new Error("The cloud portfolio is not configured.");
  return supabase;
}

// --- Projects ---------------------------------------------------------------

/** Every project the signed-in user owns, most recently touched first. */
export async function listProjects(): Promise<Project[]> {
  const { data, error } = await client()
    .from("projects")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data as Project[];
}

/** One project by id (RLS still scopes it to the owner). */
export async function getProject(id: string): Promise<Project> {
  const { data, error } = await client().from("projects").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Project;
}

/**
 * Create a project. `owner` is filled by the column default (`auth.uid()`), so callers
 * never pass it — and RLS would reject a row claiming a different owner anyway.
 */
export async function createProject(input: {
  name: string;
  document?: unknown;
  folderId?: string | null;
  thumbnail?: string | null;
}): Promise<Project> {
  const { data, error } = await client()
    .from("projects")
    .insert({
      name: input.name,
      document: input.document ?? null,
      folder_id: input.folderId ?? null,
      thumbnail: input.thumbnail ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as Project;
}

/** Patch a project — rename, restash its document, move it between folders. */
export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "document" | "thumbnail" | "folder_id">>,
): Promise<Project> {
  const { data, error } = await client()
    .from("projects")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as Project;
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await client().from("projects").delete().eq("id", id);
  if (error) throw error;
}

// --- Folders ----------------------------------------------------------------

export async function listFolders(): Promise<Folder[]> {
  const { data, error } = await client()
    .from("folders")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as Folder[];
}

export async function createFolder(name: string): Promise<Folder> {
  const { data, error } = await client()
    .from("folders")
    .insert({ name })
    .select("*")
    .single();
  if (error) throw error;
  return data as Folder;
}

export async function deleteFolder(id: string): Promise<void> {
  const { error } = await client().from("folders").delete().eq("id", id);
  if (error) throw error;
}

// --- Profile ----------------------------------------------------------------

/**
 * The signed-in user's profile row. A trigger creates it on sign-up, so this normally
 * returns a row; `maybeSingle` tolerates the brief window before the trigger has run.
 */
export async function getMyProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await client()
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as Profile) ?? null;
}

/** Update the display name, avatar, or the free-form settings bag. */
export async function updateMyProfile(
  userId: string,
  patch: Partial<Pick<Profile, "display_name" | "avatar_url" | "settings">>,
): Promise<Profile> {
  const { data, error } = await client()
    .from("profiles")
    .update(patch)
    .eq("id", userId)
    .select("*")
    .single();
  if (error) throw error;
  return data as Profile;
}
