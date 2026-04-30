"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, MessageSquare, Plus } from "lucide-react";

type ProjectEntry = {
  id: string;
  name: string;
  path: string;
  addedAt: string;
  exists: boolean;
  hasGit: boolean;
  branch: string | null;
};

type SessionSummary = {
  id: string;
  filename: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  modelId: string | null;
  provider: string | null;
  firstUserMessage: string | null;
  turnCount: number;
};

const SESSIONS_PER_PROJECT = 10;

function formatRelative(isoString: string): string {
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * Collapsible PROJECTS section in the top-level left sidebar. Each project is
 * a folder; expanding it fetches and lists the recent sessions inside.
 *
 * Hidden when the sidebar is collapsed to its icon rail (caller decides via
 * `expanded`).
 */
export function ProjectsNavSection({ expanded }: { expanded: boolean }) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/agent/projects", { cache: "no-store" });
        const payload = (await response.json()) as { projects?: ProjectEntry[] };
        if (!cancelled) setProjects(payload.projects ?? []);
      } catch {
        if (!cancelled) setProjects([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded]);

  if (!expanded) return null;

  const toggle = (id: string) =>
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col">
      <div className="mt-2 flex h-7 items-center px-3 text-[10px] font-medium uppercase tracking-wide text-(--dim)">
        Projects
      </div>
      {projects.length === 0 ? (
        <div className="px-3 py-1.5 text-[11px] text-(--dim)">No projects yet.</div>
      ) : (
        projects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            open={openIds.has(project.id)}
            onToggle={() => toggle(project.id)}
          />
        ))
      )}
    </div>
  );
}

function ProjectRow({
  project,
  open,
  onToggle,
}: {
  project: ProjectEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = open ? FolderOpen : Folder;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        title={project.path}
        className="h-9 flex items-center gap-2 px-3 text-(--dim) hover:text-(--fg) hover:bg-(--surface) transition-colors"
      >
        <Chevron className="w-3 h-3 shrink-0" />
        <Icon className="w-4 h-4 shrink-0" />
        <span className="truncate text-sm font-medium text-(--fg)">{project.name}</span>
      </button>
      {open ? <ProjectSessions project={project} /> : null}
    </div>
  );
}

function ProjectSessions({ project }: { project: ProjectEntry }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/agent/sessions?cwd=${encodeURIComponent(project.path)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as { sessions?: SessionSummary[] };
      setSessions(payload.sessions ?? []);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [project.path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = (sessions ?? []).slice(0, SESSIONS_PER_PROJECT);
  const extra = (sessions?.length ?? 0) - visible.length;

  return (
    <div className="flex flex-col">
      <Link
        href={`/agent?project=${encodeURIComponent(project.id)}&new=1`}
        className="h-8 flex items-center gap-2 pl-9 pr-3 text-(--dim) hover:text-(--fg) hover:bg-(--surface) transition-colors"
        title="Start a new chat in this project"
      >
        <Plus className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate text-xs">New thread</span>
      </Link>
      {loading && !sessions ? (
        <div className="pl-9 pr-3 py-1 text-[11px] text-(--dim)">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="pl-9 pr-3 py-1 text-[11px] text-(--dim)">No sessions yet.</div>
      ) : (
        visible.map((session) => (
          <Link
            key={session.id}
            href={`/agent?project=${encodeURIComponent(project.id)}&session=${encodeURIComponent(session.id)}`}
            title={session.firstUserMessage || "Untitled session"}
            className="h-8 flex items-center gap-2 pl-9 pr-3 text-(--dim) hover:text-(--fg) hover:bg-(--surface) transition-colors"
          >
            <MessageSquare className="w-3.5 h-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-xs">
              {session.firstUserMessage || "Untitled session"}
            </span>
            <span className="shrink-0 text-[10px] text-(--dim)">
              {formatRelative(session.updatedAt)}
            </span>
          </Link>
        ))
      )}
      {extra > 0 ? (
        <Link
          href={`/agent?project=${encodeURIComponent(project.id)}`}
          className="h-7 flex items-center pl-9 pr-3 text-[11px] text-(--dim) hover:text-(--fg) hover:bg-(--surface) transition-colors"
        >
          + {extra} more
        </Link>
      ) : null}
    </div>
  );
}
