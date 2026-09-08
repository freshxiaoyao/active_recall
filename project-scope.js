import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";



















function runGit(cwd        , args          , timeoutMs        )                  {
  return new Promise((resolveResult, reject) => {
    execFile("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: Math.max(1, timeoutMs),
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolveResult(stdout.trim());
    });
  });
}

function stripGitSuffix(value        )         {
  return value.replace(/[\\/]+$/, "").replace(/\.git$/i, "").replace(/[\\/]+$/, "");
}

/** Normalize common HTTPS, SSH URL, and scp-like Git remotes to one host/path identity. */
export function normalizeRepoRemote(remote        )                     {
  const value = remote.trim();
  if (!value) return undefined;
  let host = "";
  let repoPath = "";
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(value);
  const scpLike = !isWindowsPath && !value.includes("://")
    ? /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value)
    : null;
  if (scpLike) {
    host = scpLike[1];
    repoPath = scpLike[2];
  } else {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "file:") return undefined;
      host = parsed.hostname;
      const port = parsed.port;
      if (port && !((parsed.protocol === "https:" && port === "443") || (parsed.protocol === "ssh:" && port === "22"))) {
        host += `:${port}`;
      }
      repoPath = decodeURIComponent(parsed.pathname);
    } catch {
      return undefined;
    }
  }
  const normalizedHost = host.trim().toLocaleLowerCase();
  const normalizedPath = stripGitSuffix(repoPath.trim().replace(/\\/g, "/").replace(/^\/+/, ""))
    .replace(/\/{2,}/g, "/")
    .toLocaleLowerCase();
  return normalizedHost && normalizedPath ? `${normalizedHost}/${normalizedPath}` : undefined;
}

export function normalizeProjectRoot(root        )         {
  const normalized = resolve(root).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

export function projectNamespace(projectId        )         {
  const readable = projectId.toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, "__")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72) || "project";
  const digest = createHash("sha256").update(projectId, "utf8").digest("hex").slice(0, 12);
  return `${readable}--${digest}`;
}

function fallbackIdentityRoot(repoRoot        , commonGitDir                    )         {
  if (!commonGitDir) return repoRoot;
  const absoluteCommon = isAbsolute(commonGitDir) ? resolve(commonGitDir) : resolve(repoRoot, commonGitDir);
  if (basename(absoluteCommon).toLocaleLowerCase() === ".git") return dirname(absoluteCommon);
  const normalized = absoluteCommon.replace(/\\/g, "/");
  const marker = normalized.toLocaleLowerCase().lastIndexOf("/.git/worktrees/");
  return marker >= 0 ? normalized.slice(0, marker) : repoRoot;
}

/** Resolve once per recall/write. Any Git failure is deliberately a global fail-open. */
export async function resolveProjectIdentity(
  candidateDir                    ,
  timeoutMs = 250,
  git            = runGit,
)                           {
  if (!candidateDir) return { scope: "global", reason: "missing_working_directory" };
  let repoRoot        ;
  try {
    repoRoot = await git(candidateDir, ["rev-parse", "--show-toplevel"], timeoutMs);
  } catch {
    return { scope: "global", reason: "not_git_repository" };
  }
  if (!repoRoot) return { scope: "global", reason: "not_git_repository" };

  let remote                    ;
  try {
    remote = await git(repoRoot, ["config", "--get", "remote.origin.url"], timeoutMs) || undefined;
  } catch {
    remote = undefined;
  }
  const normalizedRemote = remote ? normalizeRepoRemote(remote) : undefined;
  if (normalizedRemote) {
    return {
      scope: "project",
      projectId: normalizedRemote,
      projectRoot: resolve(repoRoot),
      // Persist the canonical credential-free remote, never a raw URL that may embed tokens.
      repoRemote: normalizedRemote,
      namespace: projectNamespace(normalizedRemote),
      identitySource: "remote",
    };
  }

  let commonGitDir                    ;
  try {
    commonGitDir = await git(repoRoot, ["rev-parse", "--git-common-dir"], timeoutMs) || undefined;
  } catch {
    commonGitDir = undefined;
  }
  const projectId = normalizeProjectRoot(fallbackIdentityRoot(repoRoot, commonGitDir));
  return {
    scope: "project",
    projectId,
    projectRoot: resolve(repoRoot),
    namespace: projectNamespace(projectId),
    identitySource: "root",
  };
}

function normalizedPath(value        )         {
  const path = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return process.platform === "win32" ? path.toLocaleLowerCase() : path;
}

function pathBelowVectorDir(path        , vectorDir        )                     {
  const candidate = normalizedPath(path);
  const marker = normalizedPath(vectorDir).replace(/^\/+|\/+$/g, "");
  if (!marker) return undefined;
  if (candidate === marker) return "";
  if (candidate.startsWith(`${marker}/`)) return candidate.slice(marker.length + 1);
  const position = candidate.lastIndexOf(`/${marker}/`);
  return position >= 0 ? candidate.slice(position + marker.length + 2) : undefined;
}

export function classifyMemoryProject(
  path        ,
  vectorDir        ,
  current                  ,
)                                                    {
  const relative = pathBelowVectorDir(path, vectorDir);
  const match = relative ? /^projects\/([^/]+)(?:\/|$)/i.exec(relative) : null;
  if (!match) return { scope: "global" };
  const namespace = match[1];
  return current?.scope === "project" && current.namespace?.toLocaleLowerCase() === namespace.toLocaleLowerCase()
    ? { scope: "same-project", namespace }
    : { scope: "other-project", namespace };
}

export function applyProjectScope(
  result              ,
  current                             ,
  config                    ,
  vectorDir        ,
)               {
  if (!config.enabled) return result;
  const hits = result.hits.flatMap((hit)              => {
    const classified = classifyMemoryProject(hit.path, vectorDir, current);
    if (classified.scope === "global" && !config.includeGlobal) return [];
    if (classified.scope === "other-project" && config.otherProjectPolicy === "exclude") return [];
    const projectWeight = classified.scope === "same-project"
      ? config.sameProjectBoost
      : classified.scope === "other-project"
        ? config.otherProjectWeight
        : 1;
    return [{ ...hit, projectScope: classified.scope, projectWeight }];
  });
  return { ...result, hits };
}


//# sourceURL=C:\Users\lenovo\.openclaw\workspace\plugins\active_recall\project-scope.ts