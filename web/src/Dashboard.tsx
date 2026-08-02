/**
 * The signed-in home: a user's portfolio of saved rooms, and their settings.
 *
 * This is the read/organise surface. Rooms are *created and edited* in the 3D editor and
 * pushed here by an explicit "save to portfolio" (the manual-save model in PLAN.md), so
 * the dashboard's job is to list, group, rename, delete, and re-open — not to author room
 * geometry. It never touches a project's `document`; that blob is Rust's, opaque here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import {
  createFolder,
  deleteFolder,
  deleteProject,
  getMyProfile,
  listFolders,
  listProjects,
  updateMyProfile,
  updateProject,
  type Folder,
  type Profile,
  type Project,
} from "./portfolio";

type Tab = "portfolio" | "settings";
// A sentinel folder id for the "everything" view, distinct from a real folder's uuid.
const ALL = "__all__";

export function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("portfolio");

  const [projects, setProjects] = useState<Project[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [activeFolder, setActiveFolder] = useState<string>(ALL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const [ps, fs, pr] = await Promise.all([
        listProjects(),
        listFolders(),
        getMyProfile(user.id),
      ]);
      setProjects(ps);
      setFolders(fs);
      setProfile(pr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shown = useMemo(
    () =>
      activeFolder === ALL
        ? projects
        : projects.filter((p) => p.folder_id === activeFolder),
    [projects, activeFolder],
  );

  const greetName =
    profile?.display_name?.trim() ||
    user?.user_metadata?.full_name ||
    user?.email ||
    "there";

  return (
    <div className="dash">
      <header className="dash-top">
        <span className="dash-brand">spacelab</span>
        <nav className="dash-tabs">
          <button
            type="button"
            className={tab === "portfolio" ? "dash-tab active" : "dash-tab"}
            onClick={() => setTab("portfolio")}
          >
            Portfolio
          </button>
          <button
            type="button"
            className={tab === "settings" ? "dash-tab active" : "dash-tab"}
            onClick={() => setTab("settings")}
          >
            Settings
          </button>
        </nav>
        <div className="dash-who">
          {user?.user_metadata?.avatar_url && (
            <img className="dash-avatar" src={user.user_metadata.avatar_url} alt="" />
          )}
          <button type="button" className="auth-ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {error && <p className="auth-error dash-error">{error}</p>}

      {tab === "portfolio" ? (
        <PortfolioTab
          greetName={greetName}
          loading={loading}
          folders={folders}
          projects={projects}
          shown={shown}
          activeFolder={activeFolder}
          onSelectFolder={setActiveFolder}
          onNewRoom={() => navigate("/editor")}
          onOpen={(id) => navigate(`/editor?project=${id}`)}
          onChanged={refresh}
          setError={setError}
        />
      ) : (
        <SettingsTab
          user={user}
          profile={profile}
          onSaved={(p) => setProfile(p)}
          setError={setError}
        />
      )}
    </div>
  );
}

function PortfolioTab({
  greetName,
  loading,
  folders,
  projects,
  shown,
  activeFolder,
  onSelectFolder,
  onNewRoom,
  onOpen,
  onChanged,
  setError,
}: {
  greetName: string;
  loading: boolean;
  folders: Folder[];
  projects: Project[];
  shown: Project[];
  activeFolder: string;
  onSelectFolder: (id: string) => void;
  onNewRoom: () => void;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
  setError: (m: string) => void;
}) {
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const countIn = (folderId: string) =>
    folderId === ALL ? projects.length : projects.filter((p) => p.folder_id === folderId).length;

  return (
    <main className="dash-body">
      <div className="dash-head">
        <div>
          <h1 className="dash-h1">Your portfolio</h1>
          <p className="dash-hello">Welcome back, {greetName}.</p>
        </div>
        <button type="button" className="primary" onClick={onNewRoom}>
          + New room
        </button>
      </div>

      <div className="dash-folders">
        <FolderChip
          label="All"
          count={countIn(ALL)}
          active={activeFolder === ALL}
          onClick={() => onSelectFolder(ALL)}
        />
        {folders.map((f) => (
          <FolderChip
            key={f.id}
            label={f.name}
            count={countIn(f.id)}
            active={activeFolder === f.id}
            onClick={() => onSelectFolder(f.id)}
            onDelete={() =>
              guard(async () => {
                if (
                  window.confirm(
                    `Delete the folder “${f.name}”? Its rooms are kept and moved to All.`,
                  )
                )
                  await deleteFolder(f.id);
              })
            }
          />
        ))}
        <button
          type="button"
          className="dash-chip dash-chip-new"
          onClick={() =>
            guard(async () => {
              const name = window.prompt("New folder name")?.trim();
              if (name) await createFolder(name);
            })
          }
        >
          + Folder
        </button>
      </div>

      {loading ? (
        <p className="auth-muted">loading your rooms…</p>
      ) : shown.length === 0 ? (
        <EmptyState onNewRoom={onNewRoom} filtered={activeFolder !== ALL} />
      ) : (
        <ul className="dash-grid">
          {shown.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              folders={folders}
              onOpen={() => onOpen(p.id)}
              onRename={(name) => guard(() => updateProject(p.id, { name }))}
              onMove={(folder_id) => guard(() => updateProject(p.id, { folder_id }))}
              onDelete={() =>
                guard(async () => {
                  if (window.confirm(`Delete “${p.name}”? This can’t be undone.`))
                    await deleteProject(p.id);
                })
              }
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function FolderChip({
  label,
  count,
  active,
  onClick,
  onDelete,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <span className={active ? "dash-chip active" : "dash-chip"}>
      <button type="button" className="dash-chip-main" onClick={onClick}>
        {label} <span className="dash-chip-count">{count}</span>
      </button>
      {onDelete && (
        <button
          type="button"
          className="dash-chip-x"
          aria-label={`delete folder ${label}`}
          onClick={onDelete}
        >
          ✕
        </button>
      )}
    </span>
  );
}

function ProjectCard({
  project,
  folders,
  onOpen,
  onRename,
  onMove,
  onDelete,
}: {
  project: Project;
  folders: Folder[];
  onOpen: () => void;
  onRename: (name: string) => void;
  onMove: (folderId: string | null) => void;
  onDelete: () => void;
}) {
  return (
    <li className="card-room">
      <button type="button" className="card-room-thumb" onClick={onOpen} title="Open in editor">
        {project.thumbnail ? (
          <img src={project.thumbnail} alt="" />
        ) : (
          <span className="card-room-noimg">no preview</span>
        )}
      </button>
      <div className="card-room-meta">
        <strong className="card-room-name">{project.name}</strong>
        <span className="card-room-date">edited {formatDate(project.updated_at)}</span>
      </div>
      <div className="card-room-actions">
        <button type="button" className="reset" onClick={onOpen}>
          open
        </button>
        <button
          type="button"
          className="reset"
          onClick={() => {
            const name = window.prompt("Rename room", project.name)?.trim();
            if (name && name !== project.name) onRename(name);
          }}
        >
          rename
        </button>
        <select
          className="card-room-move"
          value={project.folder_id ?? ""}
          onChange={(e) => onMove(e.target.value || null)}
          title="Move to folder"
        >
          <option value="">No folder</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button type="button" className="reset danger" onClick={onDelete}>
          delete
        </button>
      </div>
    </li>
  );
}

function EmptyState({ onNewRoom, filtered }: { onNewRoom: () => void; filtered: boolean }) {
  return (
    <div className="dash-empty">
      {filtered ? (
        <p>No rooms in this folder yet.</p>
      ) : (
        <>
          <p className="dash-empty-title">No rooms yet.</p>
          <p className="auth-muted">
            Design a room in the editor, then use <em>Save to portfolio</em> to keep it here.
          </p>
          <button type="button" className="primary" onClick={onNewRoom}>
            + New room
          </button>
        </>
      )}
    </div>
  );
}

function SettingsTab({
  user,
  profile,
  onSaved,
  setError,
}: {
  user: ReturnType<typeof useAuth>["user"];
  profile: Profile | null;
  onSaved: (p: Profile) => void;
  setError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(profile?.display_name ?? "");
  }, [profile?.display_name]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    setSaved(false);
    try {
      const updated = await updateMyProfile(user.id, { display_name: name.trim() || null });
      onSaved(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="dash-body dash-settings">
      <h1 className="dash-h1">Settings</h1>

      <section className="settings-card">
        <h2 className="settings-h2">Profile</h2>
        <label className="settings-row">
          <span>Display name</span>
          <input
            type="text"
            value={name}
            placeholder="What should we call you?"
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="settings-row">
          <span>Email</span>
          <input type="text" value={user?.email ?? ""} readOnly className="settings-ro" />
        </label>
        <div className="settings-actions">
          <button type="button" className="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && <span className="settings-saved">Saved.</span>}
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-h2">Account</h2>
        <p className="auth-muted">
          Signed in with Google{user?.email ? ` as ${user.email}` : ""}. More preferences —
          measurement units, default finishes, theme — will live here.
        </p>
      </section>
    </main>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "recently";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
