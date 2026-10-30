import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactToolResponse } from "./utils.js";

describe("compactToolResponse", () => {
  it("preserves small primitives and simple objects", () => {
    const input = { status: "success", count: 42, active: true };
    const compacted = compactToolResponse(input);
    assert.deepEqual(compacted, input);
  });

  it("recursively removes *_url and noisy metadata from objects", () => {
    const input = {
      name: "coolify",
      description: "Self-hosting platform",
      html_url: "https://github.com/coollabsio/coolify",
      forks_url: "https://api.github.com/repos/coollabsio/coolify/forks",
      node_id: "MDc6...",
      avatar_url: "https://avatars.githubusercontent.com/u/1",
    };
    const compacted = compactToolResponse(input) as Record<string, unknown>;
    assert.equal(compacted.name, "coolify");
    assert.equal(compacted.description, "Self-hosting platform");
    assert.equal(compacted.html_url, "https://github.com/coollabsio/coolify");
    assert.equal(compacted.forks_url, undefined);
    assert.equal(compacted.node_id, undefined);
    assert.equal(compacted.avatar_url, undefined);
  });

  it("compacts large nested arrays to prevent context window explosion", () => {
    const largeArray = Array.from({ length: 50 }, (_, i) => ({
      sha: `sha-${i}`,
      commit: { message: `commit ${i}`, author: { name: "Dev" } },
      comments_url: `https://api.github.com/comments/${i}`,
    }));

    const toolResult = {
      tool: "github_repo_inspector",
      status: "success",
      data: largeArray,
    };

    const compacted = compactToolResponse(toolResult, 5000) as Record<string, unknown>;
    const serialized = JSON.stringify(compacted);
    assert.ok(serialized.length <= 5000, `Expected length <= 5000, got ${serialized.length}`);
    assert.ok(Array.isArray(compacted.data));
  });
});
