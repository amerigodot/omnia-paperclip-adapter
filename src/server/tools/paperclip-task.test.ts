import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeArtifactKey,
  deriveTitleFromMarkdown,
  isStructuredMarkdownReport,
  extractReportMarkdown,
  handleSaveArtifact,
  handleSetTaskTitle,
  markIssueDone,
  SAVE_ARTIFACT_TOOL_DEFINITION,
  SET_TASK_TITLE_TOOL_DEFINITION,
} from "./paperclip-task.js";

describe("paperclip-task tools", () => {
  describe("definitions", () => {
    it("exports valid tool definitions for Ollama", () => {
      assert.equal(SAVE_ARTIFACT_TOOL_DEFINITION.type, "function");
      assert.equal(SAVE_ARTIFACT_TOOL_DEFINITION.function.name, "save_artifact");
      assert.ok(SAVE_ARTIFACT_TOOL_DEFINITION.function.parameters.required.includes("title"));
      assert.ok(SAVE_ARTIFACT_TOOL_DEFINITION.function.parameters.required.includes("content"));

      assert.equal(SET_TASK_TITLE_TOOL_DEFINITION.type, "function");
      assert.equal(SET_TASK_TITLE_TOOL_DEFINITION.function.name, "set_task_title");
    });
  });

  describe("normalizeArtifactKey", () => {
    it("normalizes keys according to Paperclip document key rules", () => {
      assert.equal(normalizeArtifactKey("Security-Report"), "security-report");
      assert.equal(normalizeArtifactKey("audit_v1.0"), "audit_v1-0");
      assert.equal(normalizeArtifactKey("---leading-dashes"), "leading-dashes");
      assert.equal(normalizeArtifactKey(""), "report");
    });

    it("derives a clean key from title when key is omitted", () => {
      assert.equal(normalizeArtifactKey(undefined, "Security Advisory Report — Coolify"), "security-advisory-report-coolify");
      assert.equal(normalizeArtifactKey("", "My New Audit 2026"), "my-new-audit-2026");
    });

    it("falls back to 'report' if key and title are empty or invalid", () => {
      assert.equal(normalizeArtifactKey(undefined, undefined), "report");
      assert.equal(normalizeArtifactKey("!!!", "???"), "report");
    });
  });

  describe("deriveTitleFromMarkdown", () => {
    it("extracts top-level H1 headers", () => {
      assert.equal(deriveTitleFromMarkdown("# 🔐 Security Advisory Report\nSome text"), "🔐 Security Advisory Report");
      assert.equal(deriveTitleFromMarkdown("Intro text\n# Audit Findings\nDetails"), "Audit Findings");
      assert.equal(deriveTitleFromMarkdown("No headers here"), null);
    });
  });

  describe("isStructuredMarkdownReport", () => {
    it("detects structured reports with headers and keywords", () => {
      const report = `# Security Advisory Report\n\n## Executive Summary\nCoolify has several CVE advisories.\n\n| Severity | CVE |\n|---|---|\n| High | CVE-2026-42204 |\n\n## Recommendations\nUpdate immediately.`;
      assert.equal(isStructuredMarkdownReport(report), true);
    });

    it("rejects short or non-report conversational text", () => {
      assert.equal(isStructuredMarkdownReport("Ciao, come stai?"), false);
      assert.equal(isStructuredMarkdownReport("Ecco la risposta breve alla tua domanda."), false);
    });
  });

  describe("extractReportMarkdown", () => {
    it("strips conversational preamble before first H1", () => {
      const text = `Ho analizzato la repo coollabsio/coolify. Ecco il report completo:\n\n# 🔐 Security Advisory Report\n\nContenuto del report.`;
      const extracted = extractReportMarkdown(text);
      assert.ok(extracted.startsWith("# 🔐 Security Advisory Report"));
    });

    it("returns original text if already starting with H1", () => {
      const text = `# Security Report\n\nContent`;
      assert.equal(extractReportMarkdown(text), text);
    });
  });

  describe("handleSaveArtifact", () => {
    it("returns error if content is empty", async () => {
      const res = await handleSaveArtifact({}, {});
      assert.equal(res.success, false);
      assert.ok(res.error?.includes("Content/body must not be empty"));
    });

    it("successfully creates a new document via Paperclip API", async () => {
      const originalFetch = globalThis.fetch;
      let callCount = 0;
      let capturedPutBody: any = null;
      let capturedAuthHeader: string | undefined = undefined;

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        callCount++;
        const urlStr = String(url);
        if (init?.method === "GET") {
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        }
        if (init?.method === "PUT") {
          capturedPutBody = JSON.parse(String(init.body));
          capturedAuthHeader = (init.headers as Record<string, string>)?.Authorization;
          return new Response(JSON.stringify({
            id: "doc-123",
            latestRevisionNumber: 1,
            key: "security-report",
            title: "Security Report",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("{}", { status: 200 });
      }) as any;

      try {
        const res = await handleSaveArtifact({
          title: "Security Report",
          content: "# Security Report\nAll clear",
          key: "security-report",
        }, {
          issueId: "issue-123",
          apiUrl: "http://127.0.0.1:3100",
          authToken: "mock-token",
        });

        assert.equal(res.success, true);
        assert.equal(res.documentId, "doc-123");
        assert.equal(res.revision, 1);
        assert.equal(res.key, "security-report");

        assert.equal(callCount, 2);
        assert.equal(capturedPutBody.baseRevisionId, undefined);
        assert.equal(capturedAuthHeader, "Bearer mock-token");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("includes baseRevisionId when updating an existing document", async () => {
      const originalFetch = globalThis.fetch;
      let capturedPutBody: any = null;

      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "GET") {
          return new Response(JSON.stringify({
            id: "doc-123",
            latestRevisionId: "rev-abc-456",
            latestRevisionNumber: 1,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (init?.method === "PUT") {
          capturedPutBody = JSON.parse(String(init.body));
          return new Response(JSON.stringify({
            id: "doc-123",
            latestRevisionNumber: 2,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("{}", { status: 200 });
      }) as any;

      try {
        const res = await handleSaveArtifact({
          title: "Security Report",
          content: "# Security Report\nUpdated content",
          key: "security-report",
        }, {
          issueId: "issue-123",
          apiUrl: "http://127.0.0.1:3100",
        });

        assert.equal(res.success, true);
        assert.equal(res.revision, 2);
        assert.equal(capturedPutBody.baseRevisionId, "rev-abc-456");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("markIssueDone", () => {
    it("patches status to done", async () => {
      const originalFetch = globalThis.fetch;
      let capturedMethod: string | undefined;
      let capturedBody: any;

      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedMethod = init?.method;
        capturedBody = JSON.parse(String(init?.body));
        return new Response("{}", { status: 200 });
      }) as any;

      try {
        const res = await markIssueDone({
          issueId: "issue-xyz",
          apiUrl: "http://127.0.0.1:3100",
        });

        assert.equal(res, true);
        assert.equal(capturedMethod, "PATCH");
        assert.equal(capturedBody.status, "done");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
