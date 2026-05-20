// Working-directory pill rendered at the bottom of the project chat
// composer (image 3 of the design brief). Shows the current
// `resolvedDir` and offers a dropdown to:
//   - Reveal the directory in the OS file manager (existing
//     useTerminalLaunch bridge).
//   - Replace the directory, re-pointing the project at a folder the
//     user picks (POST /api/projects/:id/working-dir).
//   - Pick from recently-used directories (persisted in localStorage).
//
// In packaged desktop builds the daemon's `desktopAuthGateActive` flag
// is sticky, so `POST /api/projects/:id/working-dir` refuses tokenless
// requests. We route through the host bridge's atomic
// `pickAndReplaceWorkingDir(projectId)` IPC, which performs the picker,
// HMAC mint, and POST in a single main-process transaction — same
// trust boundary as `pickAndImport` (PR #974). The renderer never sees
// the raw path or the token. When no host bridge is present (web /
// dev), we fall back to the older `openFolderDialog` + bare
// `replaceProjectWorkingDir` path, which only works when the gate is
// dormant.

import { useEffect, useRef, useState } from 'react';
import {
  isOpenDesignHostAvailable,
  pickAndReplaceHostProjectWorkingDir,
} from '@open-design/host';
import {
  openFolderDialog,
  replaceProjectWorkingDir,
} from '../providers/registry';
import { useTerminalLaunch } from '../hooks/useTerminalLaunch';
import { Icon } from './Icon';

const RECENT_DIRS_KEY = 'open-design:recent-working-dirs';
const RECENT_DIRS_LIMIT = 6;

interface Props {
  projectId: string;
  // Optional: when the host already has the project's canonical
  // resolved directory (e.g. it just fetched ProjectDetailResponse),
  // pass it through to avoid a duplicate round-trip. When omitted, the
  // pill issues its own `GET /api/projects/:id` to resolve the path.
  resolvedDir?: string | null;
  // Fires after a successful replace so the host can refresh project
  // state (e.g. file list, entry tab).
  onReplaced?: (newDir: string) => void;
}

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_DIRS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_DIRS_LIMIT);
  } catch {
    return [];
  }
}

function pushRecent(dir: string): void {
  try {
    const prev = readRecent();
    const next = [dir, ...prev.filter((p) => p !== dir)].slice(0, RECENT_DIRS_LIMIT);
    window.localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function WorkingDirPill({ projectId, resolvedDir: propResolvedDir, onReplaced }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>(() => readRecent());
  const [fetchedDir, setFetchedDir] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const launcher = useTerminalLaunch();

  // Fetch the resolvedDir when the host did not provide one. Only fires
  // when projectId changes — once we have the value, the pill keeps
  // it until `onReplaced` (or a new projectId) supersedes it.
  useEffect(() => {
    if (propResolvedDir !== undefined) return;
    let cancelled = false;
    void fetch(`/api/projects/${encodeURIComponent(projectId)}`)
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (typeof data.resolvedDir === 'string') setFetchedDir(data.resolvedDir);
      })
      .catch(() => {
        // ignore — pill simply renders without a path
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, propResolvedDir]);

  const resolvedDir = propResolvedDir ?? fetchedDir;

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Refresh recents when the menu opens so a parallel composer instance
  // adding a path is reflected on next open without a window reload.
  useEffect(() => {
    if (open) setRecents(readRecent());
  }, [open]);

  async function applyDir(dir: string) {
    setError(null);
    setBusy(true);
    setOpen(false);
    try {
      const result = await replaceProjectWorkingDir(projectId, dir);
      pushRecent(result.baseDir);
      onReplaced?.(result.baseDir);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handlePickDir() {
    // Packaged desktop: route through the host bridge so the picker,
    // HMAC mint, and POST happen atomically in the main process. The
    // gate-active daemon refuses the renderer-driven path.
    if (isOpenDesignHostAvailable()) {
      setError(null);
      setBusy(true);
      setOpen(false);
      try {
        const result = await pickAndReplaceHostProjectWorkingDir(projectId);
        if (result.ok) {
          pushRecent(result.baseDir);
          onReplaced?.(result.baseDir);
          return;
        }
        if (!('canceled' in result) || !result.canceled) {
          const reason = 'reason' in result && typeof result.reason === 'string' && result.reason.length > 0
            ? result.reason
            : '替换工作目录失败';
          setError(reason);
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    // Web / dev fallback: gate dormant, OK to use the renderer-driven path.
    const picked = await openFolderDialog();
    if (!picked) {
      setError('Folder picker unavailable in this build. Run the desktop app to pick a folder.');
      return;
    }
    await applyDir(picked);
  }

  const shortPath = resolvedDir
    ? resolvedDir.split('/').filter(Boolean).slice(-1)[0] ?? resolvedDir
    : null;
  // The trust gate refuses HMAC tokens for any baseDir the picker did
  // not produce in the current click — recents come from localStorage,
  // which a compromised renderer can rewrite. Hide the list in packaged
  // desktop where the gate is active.
  const showRecents = !isOpenDesignHostAvailable();

  return (
    <div
      ref={wrapRef}
      className={`working-dir-pill${open ? ' open' : ''}`}
      data-testid="working-dir-pill"
    >
      <button
        type="button"
        className="working-dir-pill-trigger"
        data-testid="working-dir-pill-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={resolvedDir ?? '工作目录'}
      >
        <Icon name="folder" size={12} />
        <span className="working-dir-pill-label">
          {busy ? '处理中…' : shortPath ?? '选择工作目录'}
        </span>
        <Icon name="chevron-down" size={10} />
      </button>
      {open ? (
        <div className="working-dir-pill-menu" role="menu" data-testid="working-dir-pill-menu">
          {resolvedDir ? (
            <>
              <div className="working-dir-pill-menu-path" title={resolvedDir}>
                {resolvedDir}
              </div>
              <button
                type="button"
                role="menuitem"
                className="working-dir-pill-menu-item"
                onClick={() => {
                  setOpen(false);
                  void launcher.open(projectId);
                }}
              >
                <Icon name="folder" size={12} />
                <span>在 Finder 中显示</span>
              </button>
              <div className="working-dir-pill-menu-divider" />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="working-dir-pill-menu-item"
            onClick={() => void handlePickDir()}
            data-testid="working-dir-pill-replace"
          >
            <Icon name="folder" size={12} />
            <span>清空并替换目录…</span>
          </button>
          {showRecents && recents.filter((r) => r !== resolvedDir).length > 0 ? (
            <>
              <div className="working-dir-pill-menu-divider" />
              <div className="working-dir-pill-menu-section">最近使用的目录</div>
              {recents
                .filter((r) => r !== resolvedDir)
                .map((dir) => (
                  <button
                    key={dir}
                    type="button"
                    role="menuitem"
                    className="working-dir-pill-menu-item small"
                    title={dir}
                    onClick={() => void applyDir(dir)}
                  >
                    <Icon name="folder" size={12} />
                    <span className="working-dir-pill-menu-recent">
                      {dir.split('/').filter(Boolean).slice(-2).join('/')}
                    </span>
                  </button>
                ))}
            </>
          ) : null}
          {error ? (
            <>
              <div className="working-dir-pill-menu-divider" />
              <div className="working-dir-pill-menu-error">{error}</div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
