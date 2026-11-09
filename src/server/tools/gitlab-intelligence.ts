import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  parseConventionalCommit,
  parseSemver,
  compareSemver,
  runGit,
  type ParsedCommit,
  type GitToolResult,
} from "./git-intelligence.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types & Operations
// ---------------------------------------------------------------------------

export type GitLabOperation =
  | "generate_three_tier_changelog"
  | "generate_changelog"
  | "tag_range_analysis"
  | "detect_beta_features"
  | "inspect_active_refactors"
  | "merge_requests_overview"
  | "pipeline_status"
  | "gitlab_summary"
  | "get_file_content"
  | "list_repository_tree";

export interface GitLabToolOptions {
  operation: GitLabOperation;
  projectPath?: string; // e.g. "netvolution/chibi/identity-proxy" or full URL
  projectId?: string | number;
  gitlabHost?: string; // default: "https://gitlab.com"
  gitlabToken?: string;
  repoPath?: string; // local filesystem path if cloned locally
  base?: string;
  head?: string;
  fromTag?: string;
  toTag?: string;
  betaBranch?: string;
  baseBranch?: string;
  branchPattern?: string;
  maxBranches?: number;
  filePath?: string;
  path?: string;
  ref?: string;
  recursive?: boolean;
  format?: "markdown" | "json";
}

export interface GitLabProjectMeta {
  id: number;
  name: string;
  pathWithNamespace: string;
  defaultBranch: string;
  visibility: string;
  webUrl: string;
  description: string;
  starCount: number;
  forksCount: number;
  lastActivityAt: string;
}

export interface GitLabBranchInfo {
  name: string;
  default: boolean;
  protected: boolean;
  webUrl?: string;
  commit: {
    id: string;
    shortId: string;
    title: string;
    authorName: string;
    committedDate: string;
  };
}

export interface GitLabTagInfo {
  name: string;
  message?: string;
  target: string;
  commit?: {
    id: string;
    shortId: string;
    title: string;
    committedDate: string;
  };
  release?: {
    tagName: string;
    description: string;
  };
}

export interface GitLabMergeRequestInfo {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  webUrl: string;
  draft: boolean;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GitLabPipelineInfo {
  id: number;
  status: string;
  ref: string;
  sha: string;
  webUrl: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// GitLab API Client
// ---------------------------------------------------------------------------

export function normalizeGitLabProjectPath(raw: string): string {
  let clean = raw.trim();

  // Strip trailing punctuation like semicolons, commas, dots, and quotes
  clean = clean.replace(/^[<"'(]+|[>"');,]+$/g, "").trim();

  // Handle SSH format: git@gitlab.com:group/subgroup/project.git
  const sshMatch = clean.match(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:(.+)$/);
  if (sshMatch) {
    clean = sshMatch[1];
  }

  // Handle web URL or domain-prefixed paths: https://gitlab.com/group/project
  if (clean.startsWith("http://") || clean.startsWith("https://")) {
    try {
      const parsed = new URL(clean);
      clean = parsed.pathname;
    } catch {
      clean = clean.replace(/^https?:\/\/[^/]+\/?/, "");
    }
  } else if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\//.test(clean)) {
    // e.g. gitlab.com/netvolution/chibi/identity-proxy
    clean = clean.replace(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\//, "");
  }

  // Strip GitLab subpath features (e.g. /-/tree/main, /-/blob/..., /-/commits/...)
  clean = clean.replace(/\/-(\/.*)?$/, "");

  // Strip .git extension and trailing slashes
  clean = clean.replace(/\.git\/?$/, "").replace(/\/+$/, "");

  // Strip leading slashes
  return clean.replace(/^\/+/, "");
}

export function projectPathToApiUrl(
  projectPathOrUrl: string,
  host = "https://gitlab.com",
): { projectPath: string; encodedPath: string; apiUrl: string } {
  const projectPath = normalizeGitLabProjectPath(projectPathOrUrl);
  const encodedPath = encodeURIComponent(projectPath);
  const baseHost = (host || "https://gitlab.com").replace(/\/+$/, "");
  const apiUrl = `${baseHost}/api/v4/projects/${encodedPath}`;
  return { projectPath, encodedPath, apiUrl };
}

export function resolveGitLabToken(token?: string): string | undefined {
  if (token && token.trim()) return token.trim();
  const envToken = process.env.GITLAB_TOKEN || process.env.GL_TOKEN || process.env.GITLAB_API_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();

  // Search upwards for .env in current and ancestor directories
  let curr = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      const candidate = path.join(curr, ".env");
      if (fsSync.existsSync(candidate)) {
        const content = fsSync.readFileSync(candidate, "utf-8");
        const match = content.match(/GITLAB_TOKEN\s*=\s*["']?([^"'\s\n\r]+)/);
        if (match) {
          process.env.GITLAB_TOKEN = match[1];
          return match[1];
        }
      }
    } catch {
      // ignore
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return undefined;
}

export async function fetchGitLabApi<T = any>(
  endpoint: string,
  options: {
    host?: string;
    token?: string;
    method?: string;
    body?: unknown;
    params?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> {
  const host = (options.host || process.env.GITLAB_HOST || "https://gitlab.com").replace(/\/+$/, "");
  const token = resolveGitLabToken(options.token);

  let urlStr = endpoint.startsWith("http://") || endpoint.startsWith("https://")
    ? endpoint
    : `${host}/api/v4${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;

  if (options.params) {
    const parsedUrl = new URL(urlStr);
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined) {
        parsedUrl.searchParams.set(k, String(v));
      }
    }
    urlStr = parsedUrl.toString();
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "Paperclip-GitLab-Intelligence/1.0",
  };

  if (token) {
    headers["PRIVATE-TOKEN"] = token;
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(urlStr, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    let errBody = "";
    try {
      errBody = await res.text();
    } catch {
      // ignore
    }

    if (res.status === 403 && errBody.includes("insufficient_granular_scope")) {
      throw new Error(
        `GitLab API 403 Forbidden: Granular scope error. The GitLab Personal Access Token requires additional permissions. GitLab reported: ${errBody}`,
      );
    }

    if (res.status === 404) {
      throw new Error(
        `GitLab API 404 Not Found: "${urlStr}". Verify the project path and check that the token has permission to view this project.`,
      );
    }

    throw new Error(
      `GitLab API error (${res.status} ${res.statusText}) on ${urlStr}: ${errBody || "No details provided"}`,
    );
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// GitLab Remote API Operations
// ---------------------------------------------------------------------------

export async function fetchProjectMetadata(
  projectPathOrId: string | number,
  token?: string,
  host?: string,
): Promise<GitLabProjectMeta> {
  const normPath = normalizeGitLabProjectPath(String(projectPathOrId));
  const encodedPath =
    typeof projectPathOrId === "number"
      ? projectPathOrId
      : encodeURIComponent(normPath);

  try {
    const p = await fetchGitLabApi(`/projects/${encodedPath}`, { token, host });
    return {
      id: p.id,
      name: p.name,
      pathWithNamespace: p.path_with_namespace,
      defaultBranch: p.default_branch || "main",
      visibility: p.visibility,
      webUrl: p.web_url,
      description: p.description || "",
      starCount: p.star_count || 0,
      forksCount: p.forks_count || 0,
      lastActivityAt: p.last_activity_at || "",
    };
  } catch {
    let defBranch = "main";
    try {
      const branches = await fetchGitLabApi<any[]>(`/projects/${encodedPath}/repository/branches`, { token, host });
      const def = branches?.find((b) => b.default);
      if (def?.name) defBranch = def.name;
    } catch {
      // ignore
    }

    return {
      id: 0,
      name: normPath.split("/").pop() || normPath,
      pathWithNamespace: normPath,
      defaultBranch: defBranch,
      visibility: "private",
      webUrl: `https://gitlab.com/${normPath}`,
      description: "GitLab repository (accessed via repository read permissions)",
      starCount: 0,
      forksCount: 0,
      lastActivityAt: new Date().toISOString(),
    };
  }
}

export async function fetchProjectBranches(
  projectPathOrId: string | number,
  token?: string,
  host?: string,
): Promise<GitLabBranchInfo[]> {
  const encoded =
    typeof projectPathOrId === "number"
      ? projectPathOrId
      : encodeURIComponent(normalizeGitLabProjectPath(String(projectPathOrId)));

  const branches = await fetchGitLabApi<any[]>(`/projects/${encoded}/repository/branches`, {
    token,
    host,
    params: { per_page: 100 },
  });

  return (branches || []).map((b) => ({
    name: b.name,
    default: Boolean(b.default),
    protected: Boolean(b.protected),
    webUrl: b.web_url,
    commit: {
      id: b.commit?.id || "",
      shortId: (b.commit?.short_id || b.commit?.id || "").slice(0, 8),
      title: b.commit?.title || "",
      authorName: b.commit?.author_name || "",
      committedDate: b.commit?.committed_date || "",
    },
  }));
}

export async function fetchProjectTags(
  projectPathOrId: string | number,
  token?: string,
  host?: string,
): Promise<GitLabTagInfo[]> {
  const encoded =
    typeof projectPathOrId === "number"
      ? projectPathOrId
      : encodeURIComponent(normalizeGitLabProjectPath(String(projectPathOrId)));

  const tags = await fetchGitLabApi<any[]>(`/projects/${encoded}/repository/tags`, {
    token,
    host,
    params: { per_page: 100 },
  });

  return (tags || []).map((t) => ({
    name: t.name,
    message: t.message,
    target: t.target,
    commit: t.commit
      ? {
          id: t.commit.id,
          shortId: (t.commit.short_id || t.commit.id).slice(0, 8),
          title: t.commit.title || "",
          committedDate: t.commit.committed_date || "",
        }
      : undefined,
    release: t.release
      ? {
          tagName: t.release.tag_name,
          description: t.release.description || "",
        }
      : undefined,
  }));
}

export async function fetchProjectCompare(
  projectPathOrId: string | number,
  from: string,
  to: string,
  token?: string,
  host?: string,
): Promise<{
  commits: ParsedCommit[];
  diffs: Array<{ oldPath: string; newPath: string; newFile: boolean; deletedFile: boolean; diff: string }>;
}> {
  const encoded =
    typeof projectPathOrId === "number"
      ? projectPathOrId
      : encodeURIComponent(normalizeGitLabProjectPath(String(projectPathOrId)));

  const data = await fetchGitLabApi(`/projects/${encoded}/repository/compare`, {
    token,
    host,
    params: { from, to },
  });

  const parsedCommits: ParsedCommit[] = (data.commits || []).map((c: any) =>
    parseConventionalCommit(
      c.title || c.message.split("\n")[0],
      c.message || "",
      c.id,
      c.author_name || "",
      c.author_email || "",
      c.committed_date || "",
    ),
  );

  const diffs = (data.diffs || []).map((d: any) => ({
    oldPath: d.old_path,
    newPath: d.new_path,
    newFile: Boolean(d.new_file),
    deletedFile: Boolean(d.deleted_file),
    diff: d.diff || "",
  }));

  return { commits: parsedCommits, diffs };
}

export async function fetchProjectMergeRequests(
  projectPathOrId: string | number,
  token?: string,
  host?: string,
  state = "opened",
): Promise<GitLabMergeRequestInfo[]> {
  const encoded =
    typeof projectPathOrId === "number"
      ? projectPathOrId
      : encodeURIComponent(normalizeGitLabProjectPath(String(projectPathOrId)));

  try {
    const mrs = await fetchGitLabApi<any[]>(`/projects/${encoded}/merge_requests`, {
      token,
      host,
      params: { state, per_page: 50 },
    });

    return (mrs || []).map((m) => ({
      id: m.id,
      iid: m.iid,
      title: m.title,
      description: m.description || "",
      state: m.state,
      sourceBranch: m.source_branch,
      targetBranch: m.target_branch,
      author: m.author?.username || m.author?.name || "Unknown",
      webUrl: m.web_url,
      draft: Boolean(m.draft || m.work_in_progress),
      labels: Array.isArray(m.labels) ? m.labels : [],
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    }));
  } catch (err: any) {
    if (String(err?.message || "").includes("granular_scope") || String(err?.message || "").includes("403")) {
      return [];
    }
    throw err;
  }
}

export async function fetchProjectPipelines(
  projectPathOrId: string | number,
  token?: string,
  host?: string,
  ref?: string,
): Promise<GitLabPipelineInfo[]> {
  const encoded =
    typeof projectPathOrId === "number"
      ? projectPathOrId
      : encodeURIComponent(normalizeGitLabProjectPath(String(projectPathOrId)));

  try {
    const pipelines = await fetchGitLabApi<any[]>(`/projects/${encoded}/pipelines`, {
      token,
      host,
      params: { per_page: 10, ref },
    });

    return (pipelines || []).map((p) => ({
      id: p.id,
      status: p.status,
      ref: p.ref,
      sha: p.sha,
      webUrl: p.web_url,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }));
  } catch (err: any) {
    if (String(err?.message || "").includes("granular_scope") || String(err?.message || "").includes("403")) {
      return [];
    }
    throw err;
  }
}

export async function fetchRawFile(
  projectPathOrId: string | number,
  filePath: string,
  ref = "main",
  token?: string,
  host = "https://gitlab.com",
): Promise<string> {
  const encodedProj =
    typeof projectPathOrId === "number"
      ? projectPathOrId
      : encodeURIComponent(normalizeGitLabProjectPath(String(projectPathOrId)));
  const cleanFilePath = filePath.trim().replace(/^\/+/, "");
  const encodedPath = encodeURIComponent(cleanFilePath);

  const urlStr = `${host}/api/v4/projects/${encodedProj}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`;
  const headers: Record<string, string> = {
    "User-Agent": "Paperclip-GitLab-Intelligence/1.0",
  };
  const resolvedToken = resolveGitLabToken(token);
  if (resolvedToken) {
    headers["PRIVATE-TOKEN"] = resolvedToken;
    headers["Authorization"] = `Bearer ${resolvedToken}`;
  }
  const res = await fetch(urlStr, { headers });
  if (!res.ok) {
    let errBody = "";
    try {
      errBody = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`GitLab raw file error (${res.status} ${res.statusText}) for file "${cleanFilePath}" on ref "${ref}": ${errBody}`);
  }
  return await res.text();
}

export interface GitLabTreeItem {
  id: string;
  name: string;
  type: "tree" | "blob" | "submodule";
  path: string;
  mode: string;
}

export async function fetchProjectTree(
  projectPathOrId: string | number,
  path?: string,
  ref = "main",
  recursive = true,
  token?: string,
  host = "https://gitlab.com",
): Promise<GitLabTreeItem[]> {
  const encodedProj =
    typeof projectPathOrId === "number"
      ? projectPathOrId
      : encodeURIComponent(normalizeGitLabProjectPath(String(projectPathOrId)));

  const params: Record<string, string | number | boolean> = {
    ref,
    per_page: 100,
  };
  if (path && path.trim()) {
    params.path = path.trim().replace(/^\/+/, "");
  }
  if (recursive) {
    params.recursive = true;
  }

  const items = await fetchGitLabApi<any[]>(`/projects/${encodedProj}/repository/tree`, {
    token,
    host,
    params,
  });

  return (items || []).map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    path: item.path,
    mode: item.mode,
  }));
}

// ---------------------------------------------------------------------------
// Subsystem & Conflict Helpers
// ---------------------------------------------------------------------------

export function mapTouchedSubsystems(fileList: string[]): string[] {
  const subsystems = new Set<string>();
  for (const f of fileList) {
    if (!f) continue;
    if (f.startsWith("packages/")) {
      const parts = f.split("/");
      subsystems.add(parts.slice(0, 3).join("/"));
    } else if (f.startsWith("src/") || f.startsWith("server/") || f.startsWith("ui/")) {
      const parts = f.split("/");
      subsystems.add(parts.slice(0, 2).join("/"));
    } else if (f.startsWith("proxy/") || f.startsWith("auth/") || f.startsWith("identity/")) {
      const parts = f.split("/");
      subsystems.add(parts[0]);
    } else if (f.includes("/")) {
      subsystems.add(f.split("/")[0]);
    } else {
      subsystems.add("root-config");
    }
  }
  return Array.from(subsystems);
}

// ---------------------------------------------------------------------------
// 1. Full Three-Tier Changelog Report Generator
// ---------------------------------------------------------------------------

export async function generateThreeTierChangelog(
  options: GitLabToolOptions,
): Promise<GitToolResult> {
  const startTime = Date.now();
  const { projectPath, projectId, gitlabHost, gitlabToken, repoPath } = options;
  const projectRef = projectId || projectPath || repoPath || "current-repo";

  let baseBranch = options.baseBranch || "main";
  let betaBranch = options.betaBranch || "beta";

  let officiallyReleasedSection = "";
  let upcomingBetaSection = "";
  let workInProgressSection = "";

  const tier1Tags: GitLabTagInfo[] = [];
  let tier2UpcomingFeats: ParsedCommit[] = [];
  let tier2BreakingChanges: ParsedCommit[] = [];
  let tier2ModifiedFiles: string[] = [];

  const tier3ActiveBranches: Array<{
    name: string;
    ahead: number;
    behind: number;
    lastCommit: string;
    subsystems: string[];
    isRefactor: boolean;
    modifiedFiles: string[];
  }> = [];

  // Check if we should execute locally: only if repoPath has a .git directory and NO remote projectPath/projectId was specified
  let isLocalGit = false;
  let targetCwd = repoPath || "";
  if (repoPath && !projectPath && !projectId) {
    try {
      await fs.access(path.join(repoPath, ".git"));
      isLocalGit = true;
    } catch {
      // not a local git repo
    }
  }

  if (isLocalGit) {
    // -------------------------------------------------------------------------
    // LOCAL GIT EXECUTION
    // -------------------------------------------------------------------------
    // 1. Tags on main
    try {
      const { stdout: tagsOut } = await runGit(
        ["tag", "--merged", baseBranch, "--sort=-creatordate"],
        targetCwd,
      );
      const tagList = tagsOut.split("\n").map((t) => t.trim()).filter(Boolean);
      for (const t of tagList.slice(0, 10)) {
        tier1Tags.push({ name: t, target: "" });
      }
    } catch {
      // fallback
    }

    // 2. Beta branch vs main
    try {
      const formatString = "%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1e";
      const { stdout: logOut } = await runGit(
        ["log", `--pretty=format:${formatString}`, "--date=iso", `${baseBranch}..${betaBranch}`],
        targetCwd,
      );
      if (logOut) {
        for (const rec of logOut.split("\x1e")) {
          if (!rec.trim()) continue;
          const [sha, author, email, date, subject, body] = rec.split("\x1f");
          const commit = parseConventionalCommit(subject || "", body || "", sha, author, email, date);
          if (commit.isBreaking) tier2BreakingChanges.push(commit);
          else if (commit.type === "feat") tier2UpcomingFeats.push(commit);
        }
      }

      const { stdout: diffOut } = await runGit(
        ["diff", "--name-only", `${baseBranch}..${betaBranch}`],
        targetCwd,
      );
      tier2ModifiedFiles = diffOut.split("\n").map((f) => f.trim()).filter(Boolean);
    } catch {
      // ignore
    }

    // 3. Active refactor and feature branches
    try {
      const { stdout: branchOut } = await runGit(
        ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/", "refs/remotes/origin/"],
        targetCwd,
      );
      const branchNames = Array.from(
        new Set(
          branchOut
            .split("\n")
            .map((b) => b.trim().replace(/^origin\//, ""))
            .filter((b) => b && !b.includes("HEAD") && b !== baseBranch),
        ),
      );

      for (const branch of branchNames.slice(0, 12)) {
        try {
          const { stdout: countOut } = await runGit(
            ["rev-list", "--left-right", "--count", `${baseBranch}...${branch}`],
            targetCwd,
          );
          const [behindStr, aheadStr] = countOut.trim().split(/\s+/);
          const ahead = parseInt(aheadStr || "0", 10);
          const behind = parseInt(behindStr || "0", 10);

          const { stdout: commitLine } = await runGit(
            ["log", "-n", "1", "--pretty=format:%H%x1f%an%x1f%s", branch],
            targetCwd,
          );
          const [cSha, cAuthor, cSub] = commitLine.split("\x1f");

          const { stdout: diffFiles } = await runGit(
            ["diff", "--name-only", `${baseBranch}...${branch}`],
            targetCwd,
          );
          const files = diffFiles.split("\n").map((f) => f.trim()).filter(Boolean);

          tier3ActiveBranches.push({
            name: branch,
            ahead,
            behind,
            lastCommit: `\`${(cSha || "").slice(0, 8)}\` - *${cSub || ""}* (@${cAuthor || "Unknown"})`,
            subsystems: mapTouchedSubsystems(files),
            isRefactor: branch.includes("refactor") || (cSub || "").toLowerCase().includes("refactor"),
            modifiedFiles: files,
          });
        } catch {
          // ignore branch fail
        }
      }
    } catch {
      // ignore
    }
  } else {
    // -------------------------------------------------------------------------
    // REMOTE GITLAB REST API EXECUTION
    // -------------------------------------------------------------------------
    const targetProject = projectId || projectPath;
    if (!targetProject) {
      throw new Error(
        "Neither a local 'repoPath' nor a GitLab 'projectPath'/'projectId' was provided for GitLab intelligence.",
      );
    }

    // 1. Fetch tags & releases (Tier 1)
    try {
      const tags = await fetchProjectTags(targetProject, gitlabToken, gitlabHost);
      tier1Tags.push(...tags);
    } catch (err: any) {
      officiallyReleasedSection = `> [!WARNING]\n> Could not fetch tags via GitLab API: ${err.message}\n`;
    }

    // 2. Compare beta vs main (Tier 2)
    try {
      const compareResult = await fetchProjectCompare(targetProject, baseBranch, betaBranch, gitlabToken, gitlabHost);
      for (const c of compareResult.commits) {
        if (c.isBreaking) tier2BreakingChanges.push(c);
        else if (c.type === "feat") tier2UpcomingFeats.push(c);
      }
      tier2ModifiedFiles = compareResult.diffs.map((d) => d.newPath || d.oldPath);
    } catch (err: any) {
      upcomingBetaSection = `> [!NOTE]\n> Compare between \`${baseBranch}\` and \`${betaBranch}\` returned: ${err.message}\n`;
    }

    // 3. Inspect active branches (Tier 3)
    try {
      const branches = await fetchProjectBranches(targetProject, gitlabToken, gitlabHost);
      for (const b of branches) {
        if (b.name === baseBranch) continue;
        let modifiedFiles: string[] = [];
        let aheadCount = 0;
        try {
          const comp = await fetchProjectCompare(targetProject, baseBranch, b.name, gitlabToken, gitlabHost);
          modifiedFiles = comp.diffs.map((d) => d.newPath || d.oldPath);
          aheadCount = comp.commits.length;
        } catch {
          // ignore compare failure
        }

        tier3ActiveBranches.push({
          name: b.name,
          ahead: aheadCount,
          behind: 0,
          lastCommit: `\`${b.commit.shortId}\` - *${b.commit.title}* (@${b.commit.authorName})`,
          subsystems: mapTouchedSubsystems(modifiedFiles),
          isRefactor: b.name.includes("refactor") || b.commit.title.toLowerCase().includes("refactor"),
          modifiedFiles,
        });
      }
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------------------
  // Build Unified 3-Tier Markdown Document
  // ---------------------------------------------------------------------------
  const md: string[] = [];
  md.push(`# 📋 GitLab Three-Tier Changelog & Branch Topology`);
  md.push("");
  md.push(`**Target Project:** \`${projectRef}\` | **Baseline:** \`${baseBranch}\` | **Beta:** \`${betaBranch}\``);
  md.push("");

  // SECTION 1: Officially Released
  md.push(`---`);
  md.push(`## 🏷️ 1. Quello che è stato rilasciato ufficialmente (Tags su \`${baseBranch}\`)`);
  md.push("");
  if (officiallyReleasedSection) {
    md.push(officiallyReleasedSection);
  } else if (tier1Tags.length === 0) {
    md.push(`> [!NOTE]`);
    md.push(`> Nessun tag di release ufficiale rilevato nel branch \`${baseBranch}\`.`);
  } else {
    md.push(`| Tag Release | Commit Target | Data / Note |`);
    md.push(`| :--- | :--- | :--- |`);
    for (const t of tier1Tags.slice(0, 10)) {
      const dateStr = t.commit?.committedDate ? `*(${t.commit.committedDate.split("T")[0]})*` : "";
      const msgStr = t.release?.description ? ` - ${t.release.description.slice(0, 40)}` : t.message ? ` - ${t.message.slice(0, 40)}` : "";
      md.push(`| **\`${t.name}\`** | \`${t.commit?.shortId || t.target.slice(0, 8) || "-"}\` | ${dateStr}${msgStr} |`);
    }
  }
  md.push("");

  // SECTION 2: About to be released (Beta branch)
  md.push(`---`);
  md.push(`## 🚀 2. Quello che si sta per rilasciare (Branch \`${betaBranch}\`)`);
  md.push("");
  if (upcomingBetaSection) {
    md.push(upcomingBetaSection);
  } else if (tier2UpcomingFeats.length === 0 && tier2BreakingChanges.length === 0 && tier2ModifiedFiles.length === 0) {
    md.push(`> [!NOTE]`);
    md.push(`> Il branch \`${betaBranch}\` è allineato con \`${baseBranch}\` o non presenta differenze non ancora rilasciate.`);
  } else {
    if (tier2BreakingChanges.length > 0) {
      md.push(`> [!WARNING]`);
      md.push(`> **${tier2BreakingChanges.length} Breaking Change(s) imminenti in questo rilascio:**`);
      for (const b of tier2BreakingChanges) {
        md.push(`> - **${b.subject}** (\`${b.shortSha}\` by @${b.author})`);
      }
      md.push("");
    }

    md.push(`### ✨ Funzionalità Imminenti (${tier2UpcomingFeats.length})`);
    if (tier2UpcomingFeats.length > 0) {
      for (const f of tier2UpcomingFeats) {
        const scope = f.scope ? `**[${f.scope}]** ` : "";
        md.push(`- ${scope}${f.subject} (\`${f.shortSha}\` by @${f.author})`);
      }
    } else {
      md.push(`- *Nessun commit \`feat:\` esplicito rilevato; consultare i moduli modificati sotto.*`);
    }
    md.push("");

    if (tier2ModifiedFiles.length > 0) {
      const subsystems = mapTouchedSubsystems(tier2ModifiedFiles);
      md.push(`### 📦 Sottosistemi & File Coinvolti (${tier2ModifiedFiles.length} file modificati)`);
      md.push(`**Moduli impattati:** ${subsystems.map((s) => `\`${s}\``).join(", ")}`);
      md.push("");
      for (const file of tier2ModifiedFiles.slice(0, 10)) {
        md.push(`- \`${file}\``);
      }
      if (tier2ModifiedFiles.length > 10) {
        md.push(`- *...e altri ${tier2ModifiedFiles.length - 10} file*`);
      }
    }
  }
  md.push("");

  // SECTION 3: Work in Progress (Beta + refactor/*, feat/*)
  md.push(`---`);
  md.push(`## 🌿 3. Quello su cui si sta lavorando (\`${betaBranch}\` + Branch \`refactor/*\` & \`feat/*\`)`);
  md.push("");
  if (tier3ActiveBranches.length === 0) {
    md.push(`*Nessun branch di lavoro attivo o di refactor rilevato.*`);
  } else {
    md.push(`| Branch | Ultimo Commit | Sottosistemi Impattati | Tipologia |`);
    md.push(`| :--- | :--- | :--- | :--- |`);
    for (const b of tier3ActiveBranches) {
      const typeBadge = b.name === betaBranch ? "🚀 Beta" : b.isRefactor ? "🛠️ Refactor" : "✨ Feature/Topic";
      const subs = b.subsystems.length > 0 ? b.subsystems.map((s) => `\`${s}\``).join(" ") : "`-`";
      md.push(`| **\`${b.name}\`** | ${b.lastCommit} | ${subs} | ${typeBadge} |`);
    }
    md.push("");

    // Conflict Risk Overlap
    const conflictOverlaps: Record<string, string[]> = {};
    for (let i = 0; i < tier3ActiveBranches.length; i++) {
      for (let j = i + 1; j < tier3ActiveBranches.length; j++) {
        const b1 = tier3ActiveBranches[i];
        const b2 = tier3ActiveBranches[j];
        const overlap = b1.modifiedFiles.filter((f) => b2.modifiedFiles.includes(f));
        if (overlap.length > 0) {
          const key = `\`${b1.name}\` ↔ \`${b2.name}\``;
          conflictOverlaps[key] = overlap;
        }
      }
    }

    if (Object.keys(conflictOverlaps).length > 0) {
      md.push(`> [!WARNING]`);
      md.push(`> **Rischio Conflitto di Merge Rilevato:** Più branch attivi modificano gli stessi file:`);
      for (const [pair, files] of Object.entries(conflictOverlaps)) {
        md.push(`> - **${pair}**: ${files.slice(0, 3).map((f) => `\`${f}\``).join(", ")}${files.length > 3 ? ` *(+${files.length - 3} altri)*` : ""}`);
      }
      md.push("");
    }
  }

  return {
    operation: "generate_three_tier_changelog",
    success: true,
    repo: String(projectRef),
    summary: `GitLab 3-Tier Changelog generated for ${projectRef}: ${tier1Tags.length} tags, ${tier2UpcomingFeats.length} upcoming features, ${tier3ActiveBranches.length} active branches.`,
    markdown: md.join("\n"),
    data: {
      projectRef,
      baseBranch,
      betaBranch,
      officiallyReleasedTags: tier1Tags,
      upcomingFeatures: tier2UpcomingFeats,
      upcomingBreakingChanges: tier2BreakingChanges,
      activeBranches: tier3ActiveBranches,
    },
    executionMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Unified GitLab Intelligence Dispatcher
// ---------------------------------------------------------------------------

export async function executeGitLabIntelligence(
  args: Record<string, unknown>,
  context?: Record<string, unknown>,
): Promise<GitToolResult> {
  const op = String(args.operation || "generate_three_tier_changelog").trim().toLowerCase() as GitLabOperation;

  const projectPath =
    (typeof args.projectPath === "string" && args.projectPath.trim()) ||
    (typeof args.project === "string" && args.project.trim()) ||
    (typeof args.repoUrl === "string" && args.repoUrl.trim()) ||
    (typeof args.url === "string" && args.url.trim()) ||
    undefined;

  const projectId =
    typeof args.projectId === "number"
      ? args.projectId
      : typeof args.projectId === "string" && args.projectId.trim()
      ? args.projectId.trim()
      : undefined;

  const gitlabHost =
    (typeof args.gitlabHost === "string" && args.gitlabHost.trim()) ||
    (typeof args.host === "string" && args.host.trim()) ||
    undefined;

  // Resolve GitLab token from args, context, context.env, or process.env
  let gitlabToken: string | undefined =
    (typeof args.gitlabToken === "string" && args.gitlabToken.trim()) ||
    (typeof args.token === "string" && args.token.trim()) ||
    (typeof context?.GITLAB_TOKEN === "string" && context.GITLAB_TOKEN.trim()) ||
    undefined;

  if (!gitlabToken && context?.env && typeof context.env === "object") {
    const envObj = context.env as Record<string, unknown>;
    const tokenVal = envObj.GITLAB_TOKEN || envObj.gitlab_token || envObj.GL_TOKEN;
    if (typeof tokenVal === "string") {
      gitlabToken = tokenVal.trim();
    } else if (tokenVal && typeof tokenVal === "object" && "value" in tokenVal) {
      gitlabToken = String((tokenVal as any).value).trim();
    }
  }

  if (!gitlabToken) {
    gitlabToken = process.env.GITLAB_TOKEN || process.env.GL_TOKEN || process.env.GITLAB_API_TOKEN || undefined;
  }

  // Only consider repoPath if explicitly passed in args, or if no remote projectPath/projectId is provided
  const repoPath: string | undefined =
    (typeof args.repoPath === "string" && args.repoPath.trim()) ||
    (typeof args.repo === "string" && args.repo.trim()) ||
    (!projectPath && !projectId
      ? (typeof context?.workspacePath === "string" && context.workspacePath.trim()) ||
        (typeof context?.cwd === "string" && context.cwd.trim()) ||
        undefined
      : undefined);

  const toolOptions: GitLabToolOptions = {
    operation: op,
    projectPath,
    projectId,
    gitlabHost,
    gitlabToken,
    repoPath,
    base: typeof args.base === "string" ? args.base.trim() : undefined,
    head: typeof args.head === "string" ? args.head.trim() : undefined,
    fromTag: typeof args.fromTag === "string" ? args.fromTag.trim() : undefined,
    toTag: typeof args.toTag === "string" ? args.toTag.trim() : undefined,
    betaBranch: typeof args.betaBranch === "string" ? args.betaBranch.trim() : undefined,
    baseBranch: typeof args.baseBranch === "string" ? args.baseBranch.trim() : undefined,
    branchPattern: typeof args.branchPattern === "string" ? args.branchPattern.trim() : undefined,
    maxBranches: typeof args.maxBranches === "number" ? args.maxBranches : undefined,
    filePath: typeof args.filePath === "string" ? args.filePath.trim() : typeof args.file === "string" ? (args.file as string).trim() : undefined,
    path: typeof args.path === "string" ? args.path.trim() : typeof args.subpath === "string" ? (args.subpath as string).trim() : undefined,
    ref: typeof args.ref === "string" ? args.ref.trim() : undefined,
    recursive: args.recursive !== undefined ? Boolean(args.recursive) : undefined,
    format: args.format as any,
  };

  switch (op) {
    case "generate_three_tier_changelog":
      return generateThreeTierChangelog(toolOptions);

    case "get_file_content":
    case "read_file" as any:
    case "get_file" as any:
    case "cat_file" as any: {
      const targetProj = projectId || projectPath;
      if (!targetProj) throw new Error("GitLab projectPath or projectId is required for get_file_content.");
      const file = toolOptions.filePath || (args.path as string) || (args.file as string) || "";
      if (!file) throw new Error("Argument 'filePath' is required for get_file_content.");
      const ref = toolOptions.ref || toolOptions.baseBranch || "main";
      const content = await fetchRawFile(targetProj, file, ref, gitlabToken, gitlabHost);
      const ext = path.extname(file).replace(/^\./, "") || "text";
      const md = [
        `### 📄 File: \`${file}\` (ref: \`${ref}\`)`,
        "",
        `\`\`\`${ext}`,
        content,
        `\`\`\``,
      ].join("\n");
      return {
        operation: "get_file_content",
        success: true,
        repo: String(targetProj),
        summary: `Fetched file ${file} (${content.length} chars) from ref ${ref}.`,
        markdown: md,
        data: {
          project: targetProj,
          filePath: file,
          ref,
          sizeBytes: Buffer.byteLength(content, "utf-8"),
        },
        executionMs: 0,
      };
    }

    case "list_repository_tree":
    case "list_files" as any:
    case "repository_tree" as any:
    case "ls_files" as any:
    case "tree" as any: {
      const targetProj = projectId || projectPath;
      if (!targetProj) throw new Error("GitLab projectPath or projectId is required for list_repository_tree.");
      const ref = toolOptions.ref || toolOptions.baseBranch || "main";
      const treePath = toolOptions.path || (args.subpath as string) || undefined;
      const recursive = toolOptions.recursive !== false;
      const items = await fetchProjectTree(targetProj, treePath, ref, recursive, gitlabToken, gitlabHost);
      const lines = [
        `# 📂 Repository Tree: \`${targetProj}\` (ref: \`${ref}\`${treePath ? `, path: \`${treePath}\`` : ""})`,
        "",
        `| Tipo | Percorso |`,
        `| :--- | :--- |`,
      ];
      for (const item of items) {
        const icon = item.type === "tree" ? "📁" : "📄";
        lines.push(`| ${icon} ${item.type} | \`${item.path}\` |`);
      }
      return {
        operation: "list_repository_tree",
        success: true,
        repo: String(targetProj),
        summary: `Listed ${items.length} files/directories from ${targetProj} (ref: ${ref}).`,
        markdown: lines.join("\n"),
        data: items,
        executionMs: 0,
      };
    }

    case "merge_requests_overview": {
      const targetProj = projectId || projectPath;
      if (!targetProj) throw new Error("GitLab projectPath or projectId is required for merge_requests_overview.");
      const mrs = await fetchProjectMergeRequests(targetProj, gitlabToken, gitlabHost);
      const lines = [`# 🔀 GitLab Open Merge Requests (${mrs.length})`, ""];
      if (mrs.length === 0) {
        lines.push(`*Nessuna merge request aperta rilevata sul repository.*`);
      } else {
        for (const m of mrs) {
          const draftBadge = m.draft ? "*(Draft/WIP)* " : "";
          lines.push(`- **!${m.iid}** ${draftBadge}[${m.title}](${m.webUrl})`);
          lines.push(`  - Branch: \`${m.sourceBranch}\` → \`${m.targetBranch}\` | Autore: @${m.author}`);
        }
      }
      return {
        operation: "merge_requests_overview",
        success: true,
        repo: String(targetProj),
        summary: `Found ${mrs.length} open merge requests.`,
        markdown: lines.join("\n"),
        data: mrs,
        executionMs: 0,
      };
    }

    case "pipeline_status": {
      const targetProj = projectId || projectPath;
      if (!targetProj) throw new Error("GitLab projectPath or projectId is required for pipeline_status.");
      const pipelines = await fetchProjectPipelines(targetProj, gitlabToken, gitlabHost, toolOptions.baseBranch);
      const lines = [`# ⚙️ GitLab Pipeline Health (${pipelines.length} most recent)`, ""];
      if (pipelines.length === 0) {
        lines.push(`*Nessuna pipeline CI/CD rilevata o scope pipeline non presente sul token.*`);
      } else {
        for (const p of pipelines) {
          const badge = p.status === "success" ? "✅ Success" : p.status === "failed" ? "❌ Failed" : `🔄 ${p.status}`;
          lines.push(`- **Pipeline #${p.id}**: ${badge} on \`${p.ref}\` (\`${p.sha.slice(0, 8)}\`)`);
        }
      }
      return {
        operation: "pipeline_status",
        success: true,
        repo: String(targetProj),
        summary: `Fetched ${pipelines.length} pipelines.`,
        markdown: lines.join("\n"),
        data: pipelines,
        executionMs: 0,
      };
    }

    case "gitlab_summary": {
      const targetProj = projectId || projectPath;
      if (!targetProj) throw new Error("GitLab projectPath or projectId is required for gitlab_summary.");
      const meta = await fetchProjectMetadata(targetProj, gitlabToken, gitlabHost);
      const md = [
        `# 🦊 GitLab Repository Summary: \`${meta.pathWithNamespace}\``,
        `- **Default Branch:** \`${meta.defaultBranch}\``,
        `- **Visibility:** \`${meta.visibility}\``,
        `- **Stars:** ${meta.starCount} | **Forks:** ${meta.forksCount}`,
        `- **Last Activity:** ${meta.lastActivityAt}`,
        `- **Web URL:** [${meta.webUrl}](${meta.webUrl})`,
      ].join("\n");
      return {
        operation: "gitlab_summary",
        success: true,
        repo: meta.pathWithNamespace,
        summary: `GitLab repo ${meta.pathWithNamespace}: default branch ${meta.defaultBranch}.`,
        markdown: md,
        data: meta,
        executionMs: 0,
      };
    }

    default:
      return generateThreeTierChangelog(toolOptions);
  }
}

// ---------------------------------------------------------------------------
// LLM Tool Definition
// ---------------------------------------------------------------------------

export const GITLAB_INTELLIGENCE_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "gitlab_intelligence",
    description:
      "Advanced GitLab intelligence tool to inspect repositories via remote GitLab REST API v4 and local Git. Categorizes officially released tags on main, detects upcoming beta features, inspects active refactorings (feat/*, refactor/*), analyzes merge conflict risks, reviews open merge requests & CI pipelines, fetches raw file content, and lists directory trees.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "generate_three_tier_changelog",
            "get_file_content",
            "list_repository_tree",
            "merge_requests_overview",
            "pipeline_status",
            "gitlab_summary",
          ],
          description:
            "GitLab operation to perform:\n" +
            "- 'generate_three_tier_changelog': Generates the full 3-tier report: 1) Officially released tags on main, 2) Upcoming features in beta branch, 3) Active work in progress (beta + refactor/*, feat/*) with conflict overlap detection.\n" +
            "- 'get_file_content': Reads verbatim raw content of a specific file in the repository (requires 'filePath', optional 'ref').\n" +
            "- 'list_repository_tree': Lists files and directories in the repository (optional 'path', optional 'ref', optional 'recursive').\n" +
            "- 'merge_requests_overview': Lists and analyzes open merge requests, drafts, reviewers, and target branches.\n" +
            "- 'pipeline_status': Checks CI/CD pipeline health and commit statuses.\n" +
            "- 'gitlab_summary': Overview of GitLab project metadata, stars, visibility, and activity.",
        },
        projectPath: {
          type: "string",
          description: "GitLab project path (e.g. 'netvolution/chibi/identity-proxy') or full web URL.",
        },
        projectId: {
          type: "string",
          description: "GitLab numeric project ID (optional if projectPath is provided).",
        },
        filePath: {
          type: "string",
          description: "Repository file path to inspect (e.g. 'package.json', 'app.vue', 'src/hooks.ts'). Used with 'get_file_content'.",
        },
        path: {
          type: "string",
          description: "Subdirectory path to list files from (e.g. 'components', 'locales'). Used with 'list_repository_tree'.",
        },
        ref: {
          type: "string",
          description: "Branch, tag, or commit SHA to inspect files or tree from (default: 'main').",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list repository tree files recursively (default: true).",
        },
        baseBranch: {
          type: "string",
          description: "Stable baseline branch with official releases (default: 'main').",
        },
        betaBranch: {
          type: "string",
          description: "Target branch for upcoming release candidate features (default: 'beta').",
        },
        gitlabToken: {
          type: "string",
          description: "GitLab Personal Access Token (defaults to GITLAB_TOKEN in environment).",
        },
        gitlabHost: {
          type: "string",
          description: "GitLab server host URL (default: 'https://gitlab.com').",
        },
        repoPath: {
          type: "string",
          description: "Local clone directory path if the repository is cloned locally.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Output format (default: 'markdown').",
        },
      },
      required: ["operation"],
    },
  },
};
