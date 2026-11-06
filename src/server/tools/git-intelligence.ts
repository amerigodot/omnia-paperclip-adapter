import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GitOperation =
  | "generate_changelog"
  | "tag_range_analysis"
  | "detect_beta_features"
  | "inspect_active_refactors"
  | "git_summary";

export interface ParsedCommit {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  rawSubject: string;
  subject: string;
  body: string;
  type: string;
  scope?: string;
  isBreaking: boolean;
  breakingDescription?: string;
  issues: string[];
}

export interface ChangelogOptions {
  base?: string;
  head?: string;
  repoPath?: string;
  ownerRepo?: string;
  githubToken?: string;
  groupBy?: "type" | "scope" | "author";
  includeStats?: boolean;
  format?: "markdown" | "json";
}

export interface TagRangeOptions {
  fromTag?: string;
  toTag?: string;
  repoPath?: string;
  ownerRepo?: string;
  githubToken?: string;
  format?: "markdown" | "json";
}

export interface DetectBetaOptions {
  betaBranch?: string;
  baseBranch?: string;
  repoPath?: string;
  ownerRepo?: string;
  githubToken?: string;
  format?: "markdown" | "json";
}

export interface ActiveRefactorsOptions {
  branchPattern?: string;
  baseBranch?: string;
  maxBranches?: number;
  repoPath?: string;
  ownerRepo?: string;
  githubToken?: string;
  format?: "markdown" | "json";
}

export interface GitSummaryOptions {
  repoPath?: string;
  ownerRepo?: string;
  githubToken?: string;
}

export interface GitToolResult {
  operation: GitOperation | string;
  success: boolean;
  repo: string;
  summary: string;
  markdown?: string;
  data?: unknown;
  error?: string;
  executionMs: number;
}

// ---------------------------------------------------------------------------
// Shell & API Helpers
// ---------------------------------------------------------------------------

export async function findGitRoot(startDir = process.cwd()): Promise<string> {
  let curr = path.resolve(startDir);
  while (curr !== path.dirname(curr)) {
    try {
      const gitPath = path.join(curr, ".git");
      const stat = await fs.stat(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        return curr;
      }
    } catch {
      // continue
    }
    curr = path.dirname(curr);
  }
  return startDir;
}

export async function runGit(
  args: string[],
  cwd?: string,
  timeoutMs = 15000,
): Promise<{ stdout: string; stderr: string }> {
  let targetCwd = cwd || process.cwd();
  try {
    await fs.access(targetCwd);
  } catch {
    targetCwd = await findGitRoot(process.cwd());
  }

  const pathEnv = [
    process.env.PATH,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter(Boolean).join(":");

  const execOptions = {
    cwd: targetCwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: pathEnv,
      GIT_TERMINAL_PROMPT: "0",
    },
  };

  try {
    const gitBinary = process.env.GIT_BINARY || "git";
    const { stdout, stderr } = await execFileAsync(gitBinary, args, execOptions);
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      try {
        const { stdout, stderr } = await execFileAsync("/usr/bin/git", args, execOptions);
        return { stdout: stdout.trim(), stderr: stderr.trim() };
      } catch (innerErr: any) {
        const msg = innerErr.stderr || innerErr.message || String(innerErr);
        throw new Error(`git ${args[0]} failed: ${msg}`);
      }
    }
    const message = err.stderr || err.message || String(err);
    throw new Error(`git ${args[0]} failed: ${message}`);
  }
}

export async function fetchGitHubApi(
  endpoint: string,
  token?: string,
): Promise<any> {
  const authToken = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Paperclip-Git-Intelligence/1.0",
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const url = endpoint.startsWith("https://")
    ? endpoint
    : `https://api.github.com${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error (${res.status} ${res.statusText}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Commit Parsing (Conventional Commits + SemVer)
// ---------------------------------------------------------------------------

const CONVENTIONAL_REGEX =
  /^([a-zA-Z0-9_-]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

export function parseConventionalCommit(
  rawSubject: string,
  body = "",
  sha = "",
  author = "",
  email = "",
  date = "",
): ParsedCommit {
  const trimmedSubject = rawSubject.trim();
  const trimmedBody = body.trim();
  const match = trimmedSubject.match(CONVENTIONAL_REGEX);

  let type = "other";
  let scope: string | undefined;
  let isBreaking = false;
  let subject = trimmedSubject;
  let breakingDescription: string | undefined;

  if (match) {
    type = match[1].toLowerCase();
    scope = match[2]?.trim();
    if (match[3] === "!") {
      isBreaking = true;
    }
    subject = match[4].trim();
  }

  // Check body for BREAKING CHANGE:
  const breakingMatch = trimmedBody.match(/BREAKING[- ]CHANGE:\s*([^\n]+)/i);
  if (breakingMatch) {
    isBreaking = true;
    breakingDescription = breakingMatch[1].trim();
  } else if (isBreaking && !breakingDescription) {
    breakingDescription = subject;
  }

  // Extract issue/PR references like #123, GH-456
  const issueMatches = `${trimmedSubject}\n${trimmedBody}`.match(/(?:#|GH-)(\d+)/gi) || [];
  const issues = Array.from(new Set(issueMatches.map((i) => i.replace(/^GH-/i, "#"))));

  return {
    sha,
    shortSha: sha.slice(0, 8),
    author,
    email,
    date,
    rawSubject: trimmedSubject,
    subject,
    body: trimmedBody,
    type,
    scope,
    isBreaking,
    breakingDescription,
    issues,
  };
}

export function parseSemver(tag: string): { major: number; minor: number; patch: number; prerelease: string } | null {
  const clean = tag.replace(/^v/, "").trim();
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || "",
  };
}

export function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) return a.localeCompare(b);

  if (parsedA.major !== parsedB.major) return parsedA.major - parsedB.major;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor - parsedB.minor;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch - parsedB.patch;

  if (parsedA.prerelease && !parsedB.prerelease) return -1;
  if (!parsedA.prerelease && parsedB.prerelease) return 1;
  return parsedA.prerelease.localeCompare(parsedB.prerelease);
}

// ---------------------------------------------------------------------------
// 1. Generate Changelog
// ---------------------------------------------------------------------------

export async function generateChangelog(options: ChangelogOptions): Promise<GitToolResult> {
  const startTime = Date.now();
  const { repoPath, ownerRepo, githubToken, groupBy = "type", format = "markdown" } = options;

  let commits: ParsedCommit[] = [];
  let statSummary = "";
  let baseResolved = options.base || "";
  let headResolved = options.head || "HEAD";
  let targetRepoName = repoPath || ownerRepo || "current-workspace";

  if (ownerRepo && (!repoPath || repoPath === ".")) {
    // Remote GitHub flow
    const compareData = await fetchGitHubApi(
      `/repos/${ownerRepo}/compare/${baseResolved || "main"}...${headResolved}`,
      githubToken,
    );
    commits = (compareData.commits || []).map((c: any) =>
      parseConventionalCommit(
        c.commit.message.split("\n")[0],
        c.commit.message.split("\n").slice(1).join("\n"),
        c.sha,
        c.commit.author?.name || c.author?.login || "Unknown",
        c.commit.author?.email || "",
        c.commit.author?.date || "",
      ),
    );
    statSummary = `${compareData.total_commits || commits.length} commits, ${compareData.files?.length || 0} files changed`;
    baseResolved = compareData.base_commit?.sha?.slice(0, 8) || baseResolved;
    headResolved = compareData.merge_base_commit?.sha?.slice(0, 8) || headResolved;
  } else {
    // Local Git flow
    const targetCwd = repoPath || process.cwd();

    // If base not provided, detect previous tag or parent commit
    if (!baseResolved) {
      try {
        const { stdout: latestTag } = await runGit(["describe", "--tags", "--abbrev=0"], targetCwd);
        baseResolved = latestTag;
      } catch {
        baseResolved = "HEAD~10";
      }
    }

    const formatString = "%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1e";
    const { stdout: logOut } = await runGit(
      ["log", `--pretty=format:${formatString}`, "--date=iso", `${baseResolved}..${headResolved}`],
      targetCwd,
    );

    if (logOut) {
      const records = logOut.split("\x1e");
      for (const rec of records) {
        if (!rec.trim()) continue;
        const [rawSha, rawAuthor, rawEmail, rawDate, rawSubject, rawBody] = rec.split("\x1f");
        const sha = (rawSha || "").trim();
        const author = (rawAuthor || "").trim();
        const email = (rawEmail || "").trim();
        const date = (rawDate || "").trim();
        const subject = (rawSubject || "").trim();
        const body = (rawBody || "").trim();
        commits.push(parseConventionalCommit(subject, body, sha, author, email, date));
      }
    }

    try {
      const { stdout: diffStat } = await runGit(["diff", "--shortstat", `${baseResolved}..${headResolved}`], targetCwd);
      statSummary = diffStat;
    } catch {
      // ignore
    }
  }

  // Categorize commits
  const categories: Record<string, { title: string; emoji: string; commits: ParsedCommit[] }> = {
    breaking: { title: "Breaking Changes", emoji: "⚠️", commits: [] },
    feat: { title: "Features & Enhancements", emoji: "🚀", commits: [] },
    fix: { title: "Bug Fixes", emoji: "🐛", commits: [] },
    security: { title: "Security & Vulnerabilities", emoji: "🔒", commits: [] },
    perf: { title: "Performance Optimizations", emoji: "⚡", commits: [] },
    refactor: { title: "Refactoring & Architecture", emoji: "🔄", commits: [] },
    docs: { title: "Documentation", emoji: "📝", commits: [] },
    chore: { title: "Maintenance & Tooling", emoji: "🛠️", commits: [] },
    other: { title: "Other Changes", emoji: "📦", commits: [] },
  };

  for (const c of commits) {
    if (c.isBreaking) {
      categories.breaking.commits.push(c);
    }
    if (c.type === "feat") categories.feat.commits.push(c);
    else if (c.type === "fix") categories.fix.commits.push(c);
    else if (c.type === "security" || c.subject.toLowerCase().includes("security") || c.subject.toLowerCase().includes("cve")) {
      categories.security.commits.push(c);
    } else if (c.type === "perf") categories.perf.commits.push(c);
    else if (c.type === "refactor") categories.refactor.commits.push(c);
    else if (c.type === "docs") categories.docs.commits.push(c);
    else if (["chore", "build", "ci", "test"].includes(c.type)) categories.chore.commits.push(c);
    else categories.other.commits.push(c);
  }

  // Build Markdown
  const mdLines: string[] = [];
  mdLines.push(`# Changelog: \`${baseResolved}\` → \`${headResolved}\``);
  mdLines.push("");
  mdLines.push(`**Repository:** \`${targetRepoName}\` | **Total Commits:** ${commits.length}${statSummary ? ` | **Stats:** ${statSummary}` : ""}`);
  mdLines.push(`*Generated on ${new Date().toISOString().split("T")[0]}*`);
  mdLines.push("");

  for (const [key, cat] of Object.entries(categories)) {
    if (cat.commits.length === 0) continue;
    mdLines.push(`### ${cat.emoji} ${cat.title} (${cat.commits.length})`);
    mdLines.push("");
    for (const c of cat.commits) {
      const scopePart = c.scope ? `**(${c.scope})** ` : "";
      const issuePart = c.issues.length > 0 ? ` (${c.issues.join(", ")})` : "";
      const authorPart = c.author ? ` *by @${c.author}*` : "";
      mdLines.push(`- ${scopePart}${c.subject}${issuePart} \`${c.shortSha}\`${authorPart}`);
      if (key === "breaking" && c.breakingDescription && c.breakingDescription !== c.subject) {
        mdLines.push(`  > **Impact:** ${c.breakingDescription}`);
      }
    }
    mdLines.push("");
  }

  const markdown = mdLines.join("\n");

  return {
    operation: "generate_changelog",
    success: true,
    repo: targetRepoName,
    summary: `Changelog between ${baseResolved} and ${headResolved}: ${commits.length} commits categorized.`,
    markdown,
    data: {
      base: baseResolved,
      head: headResolved,
      totalCommits: commits.length,
      statSummary,
      commits,
      categories: Object.fromEntries(
        Object.entries(categories).map(([k, v]) => [k, { count: v.commits.length, commits: v.commits }]),
      ),
    },
    executionMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// 2. Tag Range Analysis
// ---------------------------------------------------------------------------

export async function tagRangeAnalysis(options: TagRangeOptions): Promise<GitToolResult> {
  const startTime = Date.now();
  const { repoPath, ownerRepo, githubToken } = options;
  const targetCwd = repoPath || process.cwd();
  const targetRepo = repoPath || ownerRepo || "current-workspace";

  let tags: Array<{ name: string; date: string; sha: string }> = [];

  if (ownerRepo && (!repoPath || repoPath === ".")) {
    const ghTags = await fetchGitHubApi(`/repos/${ownerRepo}/tags?per_page=50`, githubToken);
    tags = (ghTags || []).map((t: any) => ({
      name: t.name,
      date: "",
      sha: t.commit?.sha || "",
    }));
  } else {
    try {
      const { stdout } = await runGit(
        ["tag", "-l", "--sort=-creatordate", "--format=%(refname:short)%x1f%(creatordate:iso)%x1f%(objectname:short)"],
        targetCwd,
      );
      if (stdout) {
        tags = stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [name, date, sha] = line.split("\x1f");
            return { name: name?.trim() || "", date: date?.trim() || "", sha: sha?.trim() || "" };
          });
      }
    } catch {
      // Fallback simple tag list
      const { stdout } = await runGit(["tag", "-l"], targetCwd);
      tags = stdout
        .split("\n")
        .filter(Boolean)
        .map((name) => ({ name: name.trim(), date: "", sha: "" }));
    }
  }

  // Sort tags by semver descending
  tags.sort((a, b) => compareSemver(b.name, a.name));

  let toTag = options.toTag;
  let fromTag = options.fromTag;

  if (!toTag) {
    toTag = tags[0]?.name || "HEAD";
  }

  if (!fromTag) {
    const toIndex = tags.findIndex((t) => t.name === toTag);
    if (toIndex >= 0 && toIndex + 1 < tags.length) {
      fromTag = tags[toIndex + 1].name;
    } else if (tags.length > 1) {
      fromTag = tags[1].name;
    } else {
      fromTag = `${toTag}~10`;
    }
  }

  // Run changelog between the resolved tags
  const changelog = await generateChangelog({
    base: fromTag,
    head: toTag,
    repoPath,
    ownerRepo,
    githubToken,
  });

  const mdLines: string[] = [];
  mdLines.push(`# Tag Range Analysis: \`${fromTag}\` → \`${toTag}\``);
  mdLines.push("");
  mdLines.push(`**Repository:** \`${targetRepo}\` | **Available Tags:** ${tags.length}`);
  mdLines.push("");
  mdLines.push(`### 🏷️ Recent Release Tags`);
  for (const t of tags.slice(0, 5)) {
    mdLines.push(`- **${t.name}** ${t.date ? `(${t.date.split(" ")[0]})` : ""} \`${t.sha.slice(0, 8)}\``);
  }
  mdLines.push("");
  mdLines.push("---");
  mdLines.push("");
  mdLines.push(changelog.markdown || "");

  return {
    operation: "tag_range_analysis",
    success: true,
    repo: targetRepo,
    summary: `Analyzed range from ${fromTag} to ${toTag} (${tags.length} total tags found).`,
    markdown: mdLines.join("\n"),
    data: {
      fromTag,
      toTag,
      tagsCount: tags.length,
      recentTags: tags.slice(0, 10),
      changelog: changelog.data,
    },
    executionMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// 3. Detect Beta & Upcoming Features
// ---------------------------------------------------------------------------

export async function detectBetaFeatures(options: DetectBetaOptions): Promise<GitToolResult> {
  const startTime = Date.now();
  const { repoPath, ownerRepo, githubToken } = options;
  const targetCwd = repoPath || process.cwd();
  const targetRepo = repoPath || ownerRepo || "current-workspace";

  let baseBranch = options.baseBranch;
  let betaBranch = options.betaBranch;

  if (ownerRepo && (!repoPath || repoPath === ".")) {
    if (!baseBranch) baseBranch = "main";
    if (!betaBranch) {
      const branches = await fetchGitHubApi(`/repos/${ownerRepo}/branches?per_page=100`, githubToken);
      const candidate = (branches || []).find((b: any) =>
        ["beta", "next", "develop", "dev", "canary", "preview"].includes(b.name.toLowerCase()),
      );
      betaBranch = candidate?.name || "beta";
    }
  } else {
    // Local Git detection
    const { stdout: branchList } = await runGit(["branch", "-a"], targetCwd);
    const branches = branchList
      .split("\n")
      .map((b) => b.replace(/^[* ]+/, "").trim())
      .filter(Boolean);

    if (!baseBranch) {
      if (branches.some((b) => b === "main" || b === "remotes/origin/main")) baseBranch = "main";
      else if (branches.some((b) => b === "master" || b === "remotes/origin/master")) baseBranch = "master";
      else baseBranch = "HEAD";
    }

    if (!betaBranch) {
      // Find candidate beta branch
      const candidates = ["beta", "next", "develop", "canary", "preview", "custom/omnia-integration"];
      for (const cand of candidates) {
        if (branches.some((b) => b === cand || b === `remotes/origin/${cand}`)) {
          betaBranch = cand;
          break;
        }
      }
      // If not found, look for any branch with 'beta' or 'feat' in name
      if (!betaBranch) {
        const fuzzy = branches.find((b) => !b.includes("HEAD") && (b.includes("beta") || b.includes("feat")));
        betaBranch = fuzzy ? fuzzy.replace(/^remotes\/origin\//, "") : "beta";
      }
    }
  }

  // Get commits in beta that are not in base
  const changelog = await generateChangelog({
    base: baseBranch,
    head: betaBranch,
    repoPath,
    ownerRepo,
    githubToken,
  });

  // Also inspect newly added files in beta branch
  let addedFiles: string[] = [];
  let modifiedFiles: string[] = [];
  if (!ownerRepo || (repoPath && repoPath !== ".")) {
    try {
      const { stdout: nameStatus } = await runGit(
        ["diff", "--name-status", `${baseBranch}..${betaBranch}`],
        targetCwd,
      );
      if (nameStatus) {
        for (const line of nameStatus.split("\n")) {
          const parts = line.split("\t");
          const status = parts[0]?.trim();
          const file = parts[1]?.trim();
          if (!file) continue;
          if (status === "A") addedFiles.push(file);
          else modifiedFiles.push(file);
        }
      }
    } catch {
      // ignore diff failure
    }
  }

  const data = changelog.data as any;
  const featCommits: ParsedCommit[] = data?.categories?.feat?.commits || [];
  const breakingCommits: ParsedCommit[] = data?.categories?.breaking?.commits || [];

  const mdLines: string[] = [];
  mdLines.push(`# 🚀 Beta Features & Upcoming Release Preview`);
  mdLines.push("");
  mdLines.push(`**Target Beta Branch:** \`${betaBranch}\` | **Stable Baseline:** \`${baseBranch}\` | **Repository:** \`${targetRepo}\``);
  mdLines.push("");

  if (featCommits.length === 0 && breakingCommits.length === 0 && addedFiles.length === 0) {
    mdLines.push(`> [!NOTE]`);
    mdLines.push(`> No unreleased features or differences were detected between \`${betaBranch}\` and \`${baseBranch}\`. The branch may already be merged or up to date.`);
  } else {
    if (breakingCommits.length > 0) {
      mdLines.push(`> [!WARNING]`);
      mdLines.push(`> **${breakingCommits.length} Breaking Change(s) Coming in this Release:**`);
      for (const b of breakingCommits) {
        mdLines.push(`> - **${b.subject}** (${b.breakingDescription || "See commit"} \`${b.shortSha}\`)`);
      }
      mdLines.push("");
    }

    mdLines.push(`### 🌟 Upcoming Features (${featCommits.length})`);
    if (featCommits.length > 0) {
      for (const f of featCommits) {
        const scope = f.scope ? `**[${f.scope}]** ` : "";
        mdLines.push(`- ${scope}${f.subject} \`${f.shortSha}\` *by @${f.author}*`);
      }
    } else {
      mdLines.push(`- *No explicit \`feat:\` commits found. Review the changelog below for full commit activity.*`);
    }
    mdLines.push("");

    if (addedFiles.length > 0) {
      mdLines.push(`### 📂 Newly Created Modules & Files (${addedFiles.length})`);
      for (const file of addedFiles.slice(0, 20)) {
        mdLines.push(`- \`${file}\``);
      }
      if (addedFiles.length > 20) {
        mdLines.push(`- *...and ${addedFiles.length - 20} more files*`);
      }
      mdLines.push("");
    }

    mdLines.push("---");
    mdLines.push("");
    mdLines.push(changelog.markdown || "");
  }

  return {
    operation: "detect_beta_features",
    success: true,
    repo: targetRepo,
    summary: `Beta analysis of ${betaBranch} vs ${baseBranch}: ${featCommits.length} upcoming features, ${breakingCommits.length} breaking changes, ${addedFiles.length} new files.`,
    markdown: mdLines.join("\n"),
    data: {
      betaBranch,
      baseBranch,
      upcomingFeaturesCount: featCommits.length,
      upcomingFeatures: featCommits,
      breakingChangesCount: breakingCommits.length,
      breakingChanges: breakingCommits,
      newFilesCount: addedFiles.length,
      newFiles: addedFiles,
      modifiedFilesCount: modifiedFiles.length,
    },
    executionMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// 4. Inspect Active Refactors
// ---------------------------------------------------------------------------

export interface BranchRefactorInfo {
  name: string;
  ahead: number;
  behind: number;
  lastCommitSha: string;
  lastCommitSubject: string;
  lastCommitAuthor: string;
  lastCommitDate: string;
  modifiedFiles: string[];
  impactedModules: string[];
  isRefactorBranch: boolean;
  overlappingFilesWithOthers: string[];
}

export async function inspectActiveRefactors(options: ActiveRefactorsOptions): Promise<GitToolResult> {
  const startTime = Date.now();
  const { repoPath, ownerRepo, githubToken, maxBranches = 8, branchPattern } = options;
  const targetCwd = repoPath || process.cwd();
  const targetRepo = repoPath || ownerRepo || "current-workspace";
  let baseBranch = options.baseBranch;

  if (!baseBranch) {
    try {
      await runGit(["rev-parse", "--verify", "main"], targetCwd);
      baseBranch = "main";
    } catch {
      try {
        await runGit(["rev-parse", "--verify", "master"], targetCwd);
        baseBranch = "master";
      } catch {
        baseBranch = "HEAD";
      }
    }
  }

  let branchNames: string[] = [];

  if (ownerRepo && (!repoPath || repoPath === ".")) {
    const ghBranches = await fetchGitHubApi(`/repos/${ownerRepo}/branches?per_page=100`, githubToken);
    branchNames = (ghBranches || []).map((b: any) => b.name);
  } else {
    // Local git
    const { stdout: branchesOut } = await runGit(
      ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/", "refs/remotes/origin/"],
      targetCwd,
    );
    branchNames = Array.from(
      new Set(
        branchesOut
          .split("\n")
          .map((b) => b.trim().replace(/^origin\//, ""))
          .filter((b) => b && !b.includes("HEAD") && b !== baseBranch),
      ),
    );
  }

  // Apply pattern filter if supplied
  if (branchPattern) {
    const regex = new RegExp(branchPattern.replace(/\*/g, ".*"), "i");
    branchNames = branchNames.filter((b) => regex.test(b));
  } else {
    // Prioritize branches that sound like refactors, features, or active work
    branchNames.sort((a, b) => {
      const aScore = a.includes("refactor") ? 3 : a.includes("feat") ? 2 : a.includes("custom") ? 2 : 1;
      const bScore = b.includes("refactor") ? 3 : b.includes("feat") ? 2 : b.includes("custom") ? 2 : 1;
      return bScore - aScore;
    });
  }

  const selectedBranches = branchNames.slice(0, maxBranches);
  const refactors: BranchRefactorInfo[] = [];

  for (const branch of selectedBranches) {
    try {
      let targetRef = branch;
      try {
        await runGit(["rev-parse", "--verify", branch], targetCwd);
      } catch {
        targetRef = `origin/${branch}`;
      }

      let baseRef = baseBranch;
      try {
        await runGit(["rev-parse", "--verify", baseBranch], targetCwd);
      } catch {
        baseRef = `origin/${baseBranch}`;
      }

      // 1. Ahead / behind count
      let ahead = 0;
      let behind = 0;
      try {
        const { stdout: counts } = await runGit(
          ["rev-list", "--left-right", "--count", `${baseRef}...${targetRef}`],
          targetCwd,
        );
        const [behindStr, aheadStr] = counts.split(/\s+/);
        behind = parseInt(behindStr, 10) || 0;
        ahead = parseInt(aheadStr, 10) || 0;
      } catch {
        // Fallback
      }

      // 2. Last commit info
      const { stdout: lastCommit } = await runGit(
        ["log", "-n", "1", "--pretty=format:%H%x1f%an%x1f%ad%x1f%s", "--date=relative", targetRef],
        targetCwd,
      );
      const [sha, author, date, subject] = (lastCommit || "").split("\x1f");

      // 3. Modified files
      let modifiedFiles: string[] = [];
      try {
        const { stdout: filesOut } = await runGit(
          ["diff", "--name-only", `${baseRef}...${targetRef}`],
          targetCwd,
        );
        modifiedFiles = filesOut.split("\n").map((f) => f.trim()).filter(Boolean);
      } catch {
        // ignore
      }

      // 4. Impacted modules
      const modules = new Set<string>();
      for (const f of modifiedFiles) {
        if (f.startsWith("packages/adapters/")) modules.add("adapters");
        else if (f.startsWith("server/")) modules.add("server");
        else if (f.startsWith("ui/")) modules.add("ui");
        else if (f.startsWith("packages/shared/")) modules.add("shared");
        else if (f.startsWith("packages/db/") || f.includes("schema") || f.includes("migration")) modules.add("database");
        else if (f.startsWith("cli/")) modules.add("cli");
        else {
          const topDir = f.split("/")[0];
          if (topDir) modules.add(topDir);
        }
      }

      const isRefactorBranch =
        branch.includes("refactor") ||
        subject?.toLowerCase().includes("refactor") ||
        modifiedFiles.some((f) => f.includes("refactor"));

      refactors.push({
        name: branch,
        ahead,
        behind,
        lastCommitSha: sha?.slice(0, 8) || "",
        lastCommitSubject: subject || "",
        lastCommitAuthor: author || "Unknown",
        lastCommitDate: date || "",
        modifiedFiles,
        impactedModules: Array.from(modules),
        isRefactorBranch,
        overlappingFilesWithOthers: [],
      });
    } catch {
      // ignore branch failures
    }
  }

  // 5. Detect overlapping modified files across branches (conflict risk)
  for (let i = 0; i < refactors.length; i++) {
    for (let j = i + 1; j < refactors.length; j++) {
      const b1 = refactors[i];
      const b2 = refactors[j];
      const overlap = b1.modifiedFiles.filter((f) => b2.modifiedFiles.includes(f));
      if (overlap.length > 0) {
        b1.overlappingFilesWithOthers.push(...overlap);
        b2.overlappingFilesWithOthers.push(...overlap);
      }
    }
    refactors[i].overlappingFilesWithOthers = Array.from(new Set(refactors[i].overlappingFilesWithOthers));
  }

  // Format Markdown report
  const mdLines: string[] = [];
  mdLines.push(`# 🔄 Active Refactorings & Branch Inspection`);
  mdLines.push("");
  mdLines.push(`**Baseline:** \`${baseBranch}\` | **Repository:** \`${targetRepo}\` | **Branches Inspected:** ${refactors.length}`);
  mdLines.push("");

  if (refactors.length === 0) {
    mdLines.push(`*No active refactoring or feature branches detected.*`);
  } else {
    mdLines.push(`| Branch | Ahead / Behind | Last Commit | Impacted Modules | Status |`);
    mdLines.push(`| :--- | :--- | :--- | :--- | :--- |`);
    for (const r of refactors) {
      const badge = r.isRefactorBranch ? "🛠️ Refactor" : "✨ Feature/Work";
      const modulesStr = r.impactedModules.length > 0 ? r.impactedModules.map((m) => `\`${m}\``).join(" ") : "`-`";
      const commitStr = `"${r.lastCommitSubject.slice(0, 32)}" *(${r.lastCommitDate})*`;
      mdLines.push(`| **\`${r.name}\`** | +${r.ahead} / -${r.behind} | ${commitStr} | ${modulesStr} | ${badge} |`);
    }
    mdLines.push("");

    // Details for each branch
    for (const r of refactors) {
      mdLines.push(`### 🌿 Branch: \`${r.name}\``);
      mdLines.push(`- **Sync State:** \`+${r.ahead}\` commits ahead, \`-${r.behind}\` commits behind \`${baseBranch}\``);
      mdLines.push(`- **Latest Commit:** \`${r.lastCommitSha}\` - *${r.lastCommitSubject}* by @${r.lastCommitAuthor} (${r.lastCommitDate})`);
      mdLines.push(`- **Impacted Subsystems:** ${r.impactedModules.map((m) => `\`${m}\``).join(", ") || "None"}`);
      mdLines.push(`- **Files Modified (${r.modifiedFiles.length}):**`);
      for (const f of r.modifiedFiles.slice(0, 10)) {
        mdLines.push(`  - \`${f}\``);
      }
      if (r.modifiedFiles.length > 10) {
        mdLines.push(`  - *...and ${r.modifiedFiles.length - 10} more files*`);
      }

      if (r.overlappingFilesWithOthers.length > 0) {
        mdLines.push(`> [!WARNING]`);
        mdLines.push(`> **Potential Merge Conflicts Detected:** Modifies files also changed in other active branches:`);
        for (const ov of r.overlappingFilesWithOthers.slice(0, 5)) {
          mdLines.push(`> - \`${ov}\``);
        }
      }
      mdLines.push("");
    }
  }

  return {
    operation: "inspect_active_refactors",
    success: true,
    repo: targetRepo,
    summary: `Inspected ${refactors.length} active branches relative to ${baseBranch}.`,
    markdown: mdLines.join("\n"),
    data: {
      baseBranch,
      branchesCount: refactors.length,
      refactors,
    },
    executionMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// 5. Git Summary (Repository Status & Health)
// ---------------------------------------------------------------------------

export async function gitSummary(options: GitSummaryOptions): Promise<GitToolResult> {
  const startTime = Date.now();
  const { repoPath, ownerRepo, githubToken } = options;
  const targetCwd = repoPath || process.cwd();
  const targetRepo = repoPath || ownerRepo || "current-workspace";

  if (ownerRepo && (!repoPath || repoPath === ".")) {
    const repoInfo = await fetchGitHubApi(`/repos/${ownerRepo}`, githubToken);
    return {
      operation: "git_summary",
      success: true,
      repo: ownerRepo,
      summary: `GitHub repo ${ownerRepo}: default branch ${repoInfo.default_branch}, stars: ${repoInfo.stargazers_count}.`,
      markdown: `# Repository Summary: \`${ownerRepo}\`\n- **Default Branch:** \`${repoInfo.default_branch}\`\n- **Open Issues:** ${repoInfo.open_issues_count}\n- **Stars:** ${repoInfo.stargazers_count}`,
      data: repoInfo,
      executionMs: Date.now() - startTime,
    };
  }

  // Local git status
  const { stdout: branch } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], targetCwd);
  const { stdout: commitSha } = await runGit(["rev-parse", "HEAD"], targetCwd);
  const { stdout: status } = await runGit(["status", "--porcelain"], targetCwd);
  const { stdout: lastLog } = await runGit(["log", "-n", "3", "--oneline"], targetCwd);

  const clean = !status.trim();
  const modifiedCount = status.split("\n").filter(Boolean).length;

  const md = [
    `# 📊 Git Repository Summary: \`${targetRepo}\``,
    "",
    `- **Current Branch:** \`${branch}\``,
    `- **HEAD Commit:** \`${commitSha.slice(0, 8)}\``,
    `- **Working Directory:** ${clean ? "✅ Clean" : `⚠️ ${modifiedCount} modified/untracked file(s)`}`,
    "",
    `### Recent Commits:`,
    "```",
    lastLog,
    "```",
  ].join("\n");

  return {
    operation: "git_summary",
    success: true,
    repo: targetRepo,
    summary: `Branch: ${branch} (${commitSha.slice(0, 8)}) | Status: ${clean ? "clean" : `${modifiedCount} modified files`}`,
    markdown: md,
    data: {
      branch,
      commitSha,
      clean,
      modifiedCount,
      recentCommits: lastLog.split("\n").filter(Boolean),
    },
    executionMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Unified Dispatcher & Tool Definition
// ---------------------------------------------------------------------------

export async function executeGitIntelligence(
  args: Record<string, unknown>,
  context?: Record<string, unknown>,
): Promise<GitToolResult> {
  const op = String(args.operation || "generate_changelog").trim().toLowerCase() as GitOperation;

  // Resolve repository directory fallback
  const repoPath =
    (typeof args.repoPath === "string" && args.repoPath.trim()) ||
    (typeof args.repo === "string" && args.repo.trim()) ||
    (typeof context?.workspacePath === "string" && context.workspacePath.trim()) ||
    (typeof context?.cwd === "string" && context.cwd.trim()) ||
    process.cwd();

  const ownerRepo = typeof args.ownerRepo === "string" ? args.ownerRepo.trim() : undefined;
  const githubToken = typeof args.githubToken === "string" ? args.githubToken.trim() : undefined;

  switch (op) {
    case "generate_changelog":
      return generateChangelog({
        base: typeof args.base === "string" ? args.base.trim() : undefined,
        head: typeof args.head === "string" ? args.head.trim() : undefined,
        repoPath,
        ownerRepo,
        githubToken,
        groupBy: args.groupBy as any,
        includeStats: args.includeStats !== false,
        format: args.format as any,
      });

    case "tag_range_analysis":
      return tagRangeAnalysis({
        fromTag: typeof args.fromTag === "string" ? args.fromTag.trim() : undefined,
        toTag: typeof args.toTag === "string" ? args.toTag.trim() : undefined,
        repoPath,
        ownerRepo,
        githubToken,
        format: args.format as any,
      });

    case "detect_beta_features":
      return detectBetaFeatures({
        betaBranch: typeof args.betaBranch === "string" ? args.betaBranch.trim() : undefined,
        baseBranch: typeof args.baseBranch === "string" ? args.baseBranch.trim() : undefined,
        repoPath,
        ownerRepo,
        githubToken,
        format: args.format as any,
      });

    case "inspect_active_refactors":
      return inspectActiveRefactors({
        branchPattern: typeof args.branchPattern === "string" ? args.branchPattern.trim() : undefined,
        baseBranch: typeof args.baseBranch === "string" ? args.baseBranch.trim() : undefined,
        maxBranches: typeof args.maxBranches === "number" ? args.maxBranches : undefined,
        repoPath,
        ownerRepo,
        githubToken,
        format: args.format as any,
      });

    case "git_summary":
      return gitSummary({
        repoPath,
        ownerRepo,
        githubToken,
      });

    default:
      throw new Error(`Unsupported git intelligence operation: "${op}". Valid operations: generate_changelog, tag_range_analysis, detect_beta_features, inspect_active_refactors, git_summary.`);
  }
}

export const GIT_INTELLIGENCE_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "git_intelligence",
    description:
      "Advanced Git intelligence tool to generate structured changelogs across branches, analyze tag commit ranges, detect upcoming beta features, inspect active branch refactorings, and evaluate repository health.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "generate_changelog",
            "tag_range_analysis",
            "detect_beta_features",
            "inspect_active_refactors",
            "git_summary",
          ],
          description:
            "Git operation to perform:\n" +
            "- 'generate_changelog': Compare two branches/tags/commits and generate a categorized Conventional Commits changelog.\n" +
            "- 'tag_range_analysis': Analyze commit ranges between release tags (breaking changes, new features, semver progression).\n" +
            "- 'detect_beta_features': Compare a beta/development branch against main to identify upcoming features and new modules.\n" +
            "- 'inspect_active_refactors': Discover and inspect active refactoring branches, ahead/behind counts, touched subsystems, and merge conflict risks.\n" +
            "- 'git_summary': Overview of current branch, status, recent tags, and repository topology.",
        },
        base: {
          type: "string",
          description: "Base branch, tag, or commit SHA for changelog (e.g. 'main', 'v1.0.0', 'origin/main').",
        },
        head: {
          type: "string",
          description: "Target branch, tag, or commit SHA for changelog (default: 'HEAD').",
        },
        fromTag: {
          type: "string",
          description: "Starting tag for tag_range_analysis (e.g. 'v0.2.0'). Defaults to previous tag.",
        },
        toTag: {
          type: "string",
          description: "Ending tag for tag_range_analysis (e.g. 'v0.3.0' or 'latest').",
        },
        betaBranch: {
          type: "string",
          description: "Branch containing upcoming beta features (default: auto-detected or 'beta'/'develop').",
        },
        baseBranch: {
          type: "string",
          description: "Stable baseline branch (default: 'main').",
        },
        branchPattern: {
          type: "string",
          description: "Filter pattern for active refactor branches (e.g. 'refactor/*', 'feat/*').",
        },
        maxBranches: {
          type: "number",
          description: "Maximum active branches to inspect (default: 8).",
        },
        repoPath: {
          type: "string",
          description: "Local repository filesystem path (defaults to current workspace cwd).",
        },
        ownerRepo: {
          type: "string",
          description: "GitHub 'owner/repo' slug (e.g. 'paperclipai/paperclip') for remote inspection via GitHub API.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Output format ('markdown' or 'json', default: 'markdown').",
        },
      },
      required: ["operation"],
    },
  },
};
