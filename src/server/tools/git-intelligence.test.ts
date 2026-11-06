import { describe, it, expect, beforeAll } from "vitest";
import {
  parseConventionalCommit,
  parseSemver,
  compareSemver,
  generateChangelog,
  tagRangeAnalysis,
  detectBetaFeatures,
  inspectActiveRefactors,
  gitSummary,
  executeGitIntelligence,
  findGitRoot,
  GIT_INTELLIGENCE_TOOL_DEFINITION,
} from "./git-intelligence.js";
import path from "node:path";

describe("Git Intelligence Tool", () => {
  let paperclipRepo: string;

  beforeAll(async () => {
    paperclipRepo = await findGitRoot(process.cwd());
  });
  describe("parseConventionalCommit", () => {
    it("parses standard feat commit with scope", () => {
      const commit = parseConventionalCommit("feat(ui): add new dark mode toggle", "", "1234567890", "Alice", "alice@example.com", "2026-11-04");
      expect(commit.type).toBe("feat");
      expect(commit.scope).toBe("ui");
      expect(commit.subject).toBe("add new dark mode toggle");
      expect(commit.isBreaking).toBe(false);
      expect(commit.shortSha).toBe("12345678");
    });

    it("parses breaking change marked with !", () => {
      const commit = parseConventionalCommit("feat(api)!: remove legacy v1 endpoints", "", "abc1234567", "Bob");
      expect(commit.type).toBe("feat");
      expect(commit.scope).toBe("api");
      expect(commit.isBreaking).toBe(true);
      expect(commit.breakingDescription).toBe("remove legacy v1 endpoints");
    });

    it("parses breaking change described in body", () => {
      const body = "This is a detailed commit body.\n\nBREAKING CHANGE: database migrations are no longer backward compatible.";
      const commit = parseConventionalCommit("refactor(db): migrate to drizzle", body, "def1234567", "Charlie");
      expect(commit.type).toBe("refactor");
      expect(commit.isBreaking).toBe(true);
      expect(commit.breakingDescription).toBe("database migrations are no longer backward compatible.");
    });

    it("extracts issues and PR numbers", () => {
      const commit = parseConventionalCommit("fix(auth): resolve session token leak (#42) and GH-99", "Refs #101", "sha1234");
      expect(commit.issues).toContain("#42");
      expect(commit.issues).toContain("#99");
      expect(commit.issues).toContain("#101");
    });
  });

  describe("SemVer comparison", () => {
    it("parses valid semver tags", () => {
      const parsed = parseSemver("v1.2.3-beta.1");
      expect(parsed).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: "beta.1",
      });
    });

    it("sorts semver tags accurately", () => {
      const tags = ["v0.2.0", "v1.0.0", "v0.10.0", "v1.0.0-beta.1", "v0.3.1"];
      tags.sort(compareSemver);
      expect(tags).toEqual(["v0.2.0", "v0.3.1", "v0.10.0", "v1.0.0-beta.1", "v1.0.0"]);
    });
  });

  describe("Local Git Operations (Live Repository)", () => {
    it("produces git summary of current repository", async () => {
      const result = await gitSummary({ repoPath: paperclipRepo });
      expect(result.success).toBe(true);
      expect(result.operation).toBe("git_summary");
      expect(result.markdown).toContain("Git Repository Summary");
      expect((result.data as any).branch).toBeDefined();
    });

    it("generates changelog for recent commits", async () => {
      const result = await generateChangelog({
        base: "HEAD~3",
        head: "HEAD",
        repoPath: paperclipRepo,
      });
      expect(result.success).toBe(true);
      expect(result.operation).toBe("generate_changelog");
      expect(result.markdown).toContain("Changelog");
      expect((result.data as any).commits.length).toBeGreaterThanOrEqual(1);
    });

    it("inspects active branches and refactors", async () => {
      const result = await inspectActiveRefactors({
        baseBranch: "HEAD",
        maxBranches: 5,
        repoPath: paperclipRepo,
      });
      expect(result.success).toBe(true);
      expect(result.operation).toBe("inspect_active_refactors");
      expect(result.markdown).toContain("Active Refactorings");
    });

    it("executes unified dispatcher with valid operation", async () => {
      const result = await executeGitIntelligence(
        { operation: "git_summary", repoPath: paperclipRepo },
        { workspacePath: paperclipRepo },
      );
      expect(result.success).toBe(true);
      expect(result.operation).toBe("git_summary");
    });

    it("fails cleanly on unsupported operation", async () => {
      await expect(
        executeGitIntelligence({ operation: "invalid_operation" }),
      ).rejects.toThrow("Unsupported git intelligence operation");
    });
  });

  describe("Tool Definition", () => {
    it("has valid Ollama function calling schema", () => {
      expect(GIT_INTELLIGENCE_TOOL_DEFINITION.type).toBe("function");
      expect(GIT_INTELLIGENCE_TOOL_DEFINITION.function.name).toBe("git_intelligence");
      expect(GIT_INTELLIGENCE_TOOL_DEFINITION.function.parameters.required).toContain("operation");
    });
  });
});
