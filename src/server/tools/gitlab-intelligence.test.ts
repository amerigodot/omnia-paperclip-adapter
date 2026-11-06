import { describe, it, expect, vi } from "vitest";
import {
  normalizeGitLabProjectPath,
  mapTouchedSubsystems,
  generateThreeTierChangelog,
  executeGitLabIntelligence,
  GITLAB_INTELLIGENCE_TOOL_DEFINITION,
} from "./gitlab-intelligence.js";

describe("GitLab Intelligence Tool", () => {
  describe("normalizeGitLabProjectPath", () => {
    it("normalizes standard owner/project paths", () => {
      expect(normalizeGitLabProjectPath("netvolution/chibi/identity-proxy")).toBe(
        "netvolution/chibi/identity-proxy",
      );
      expect(normalizeGitLabProjectPath("/gitlab-org/gitlab/")).toBe("gitlab-org/gitlab");
      expect(normalizeGitLabProjectPath("org/repo.git")).toBe("org/repo");
      expect(normalizeGitLabProjectPath("netvolution/chibi/identity-proxy;")).toBe(
        "netvolution/chibi/identity-proxy",
      );
    });

    it("extracts path from full GitLab web URLs and variations", () => {
      expect(
        normalizeGitLabProjectPath("https://gitlab.com/netvolution/chibi/identity-proxy"),
      ).toBe("netvolution/chibi/identity-proxy");
      expect(
        normalizeGitLabProjectPath("https://gitlab.com/netvolution/chibi/identity-proxy;"),
      ).toBe("netvolution/chibi/identity-proxy");
      expect(
        normalizeGitLabProjectPath("https://gitlab.com/netvolution/chibi/identity-proxy.git"),
      ).toBe("netvolution/chibi/identity-proxy");
      expect(
        normalizeGitLabProjectPath("git@gitlab.com:netvolution/chibi/identity-proxy.git"),
      ).toBe("netvolution/chibi/identity-proxy");
      expect(
        normalizeGitLabProjectPath("gitlab.com/netvolution/chibi/identity-proxy"),
      ).toBe("netvolution/chibi/identity-proxy");
      expect(
        normalizeGitLabProjectPath("https://gitlab.com/netvolution/chibi/identity-proxy/-/tree/main"),
      ).toBe("netvolution/chibi/identity-proxy");
      expect(
        normalizeGitLabProjectPath("http://gitlab.internal.corp/team/subgroup/project/"),
      ).toBe("team/subgroup/project");
    });
  });

  describe("mapTouchedSubsystems", () => {
    it("identifies package, src, and top-level directories as subsystems", () => {
      const files = [
        "packages/adapters/omnia/src/index.ts",
        "packages/adapters/ollama/src/index.ts",
        "src/auth/jwt.ts",
        "server/routes/api.ts",
        "ui/src/App.tsx",
        "Dockerfile",
        "proxy/reverse.go",
      ];
      const subsystems = mapTouchedSubsystems(files);
      expect(subsystems).toContain("packages/adapters/omnia");
      expect(subsystems).toContain("packages/adapters/ollama");
      expect(subsystems).toContain("src/auth");
      expect(subsystems).toContain("server/routes");
      expect(subsystems).toContain("ui/src");
      expect(subsystems).toContain("proxy");
      expect(subsystems).toContain("root-config");
    });
  });

  describe("GITLAB_INTELLIGENCE_TOOL_DEFINITION", () => {
    it("defines valid function calling schema for LLMs", () => {
      expect(GITLAB_INTELLIGENCE_TOOL_DEFINITION.type).toBe("function");
      expect(GITLAB_INTELLIGENCE_TOOL_DEFINITION.function.name).toBe("gitlab_intelligence");
      expect(GITLAB_INTELLIGENCE_TOOL_DEFINITION.function.parameters.required).toContain("operation");
      const ops = GITLAB_INTELLIGENCE_TOOL_DEFINITION.function.parameters.properties.operation.enum;
      expect(ops).toContain("generate_three_tier_changelog");
      expect(ops).toContain("get_file_content");
      expect(ops).toContain("list_repository_tree");
      expect(ops).toContain("merge_requests_overview");
      expect(ops).toContain("pipeline_status");
      expect(ops).toContain("gitlab_summary");
    });
  });

  describe("executeGitLabIntelligence dispatcher", () => {
    it("handles generate_three_tier_changelog and formats report structure", async () => {
      const result = await executeGitLabIntelligence({
        operation: "generate_three_tier_changelog",
        repoPath: "/non/existent/path/for/mock",
        projectPath: "netvolution/chibi/identity-proxy",
      });

      expect(result.operation).toBe("generate_three_tier_changelog");
      expect(result.success).toBe(true);
      expect(result.markdown).toContain("GitLab Three-Tier Changelog");
      expect(result.markdown).toContain("1. Quello che è stato rilasciato ufficialmente");
      expect(result.markdown).toContain("2. Quello che si sta per rilasciare");
      expect(result.markdown).toContain("3. Quello su cui si sta lavorando");
    }, 15000);

    it("handles get_file_content and list_repository_tree operations", async () => {
      const treeRes = await executeGitLabIntelligence({
        operation: "list_repository_tree",
        projectPath: "netvolution/chibi/identity-proxy",
      });
      expect(treeRes.operation).toBe("list_repository_tree");
      expect(treeRes.success).toBe(true);
      expect(treeRes.markdown).toContain("Repository Tree");

      const fileRes = await executeGitLabIntelligence({
        operation: "get_file_content",
        projectPath: "netvolution/chibi/identity-proxy",
        filePath: "package.json",
      });
      expect(fileRes.operation).toBe("get_file_content");
      expect(fileRes.success).toBe(true);
      expect(fileRes.markdown).toContain("package.json");
    }, 15000);
  });
});
