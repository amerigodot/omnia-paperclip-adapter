import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOmniaPermissions,
  isDomainAllowed,
  isMethodAllowed,
  executeOmniaOperation,
  OMNIA_TOOL_DEFINITION,
  OMNIA_TOOLS,
} from "./omnia.js";
import {
  OMNIA_LOGO_DARK_SVG,
  OMNIA_LOGO_LIGHT_SVG,
  OMNIA_LOGO_DARK_DATA_URI,
  OMNIA_LOGO_LIGHT_DATA_URI,
} from "./omnia-icons.js";

describe("OmnIA Tool Suite - Permissions & Parameters", () => {
  it("parses default permissions in permissive mode", () => {
    const permissions = parseOmniaPermissions({});
    assert.equal(permissions.mode, "permissive");
    assert.equal(permissions.allowPrivateNetworks, false);
    assert.deepEqual(permissions.allowedMethods, ["GET", "POST"]);
    assert.ok(permissions.allowedDomains.includes("api.ipify.org"));
    assert.ok(permissions.allowedDomains.includes("ipwho.is"));
  });

  it("parses restricted and read_only modes with custom domains and methods", () => {
    const config = {
      omnia_mode: "restricted",
      omnia_allowed_domains: "api.github.com, *.coingecko.com",
      omnia_allowed_methods: "GET",
      omnia_auth_token: "secret_token_123",
      omnia_timeout_sec: 30,
    };
    const permissions = parseOmniaPermissions(config);
    assert.equal(permissions.mode, "restricted");
    assert.deepEqual(permissions.allowedMethods, ["GET"]);
    assert.equal(permissions.authToken, "secret_token_123");
    assert.equal(permissions.timeoutMs, 30000);
    assert.ok(permissions.allowedDomains.includes("api.github.com"));
    assert.ok(permissions.allowedDomains.includes("*.coingecko.com"));
  });

  it("blocks private network hostnames and SSRF targets by default", () => {
    const permissions = parseOmniaPermissions({ omnia_allowed_domains: "*" });
    
    // SSRF attempts
    const localhost = isDomainAllowed("http://localhost:8080/admin", permissions);
    assert.equal(localhost.allowed, false);
    assert.match(localhost.reason!, /blocked by OmnIA SSRF safety policy/);

    const loopback = isDomainAllowed("http://127.0.0.1:3000/internal", permissions);
    assert.equal(loopback.allowed, false);

    const metadata = isDomainAllowed("http://169.254.169.254/latest/meta-data", permissions);
    assert.equal(metadata.allowed, false);

    const privateSubnet = isDomainAllowed("http://192.168.1.1/router", permissions);
    assert.equal(privateSubnet.allowed, false);

    const tenNet = isDomainAllowed("http://10.0.0.5/secrets", permissions);
    assert.equal(tenNet.allowed, false);
  });

  it("validates domain whitelist correctly with wildcards", () => {
    const permissions = parseOmniaPermissions({
      omnia_mode: "restricted",
      omnia_allowed_domains: "api.ipify.org, *.github.com",
    });

    const allowed1 = isDomainAllowed("https://api.ipify.org?format=json", permissions);
    assert.equal(allowed1.allowed, true);

    const allowedWildcard = isDomainAllowed("https://api.github.com/repos", permissions);
    assert.equal(allowedWildcard.allowed, true);

    const forbidden = isDomainAllowed("https://evil-site.com/exploit", permissions);
    assert.equal(forbidden.allowed, false);
    assert.match(forbidden.reason!, /not in the OmnIA allowed domains list/);
  });

  it("enforces read_only mode on HTTP mutations and GraphQL mutations", () => {
    const readOnlyPerms = parseOmniaPermissions({
      omnia_mode: "read_only",
    });

    // GET is allowed
    assert.equal(isMethodAllowed("GET", readOnlyPerms).allowed, true);

    // POST / DELETE / PUT are blocked
    const postCheck = isMethodAllowed("POST", readOnlyPerms);
    assert.equal(postCheck.allowed, false);
    assert.match(postCheck.reason!, /read_only/);

    const deleteCheck = isMethodAllowed("DELETE", readOnlyPerms);
    assert.equal(deleteCheck.allowed, false);

    // GraphQL mutation is blocked
    const gqlMutationCheck = isMethodAllowed("POST", readOnlyPerms, true);
    assert.equal(gqlMutationCheck.allowed, false);
    assert.match(gqlMutationCheck.reason!, /GraphQL mutations are blocked/);
  });

  it("enforces allowed_methods whitelist in restricted mode", () => {
    const perms = parseOmniaPermissions({
      omnia_mode: "restricted",
      omnia_allowed_methods: "GET",
    });

    assert.equal(isMethodAllowed("GET", perms).allowed, true);
    assert.equal(isMethodAllowed("POST", perms).allowed, false);
  });

  it("executes ip_location operation under OmnIA", async () => {
    const result = await executeOmniaOperation(
      { operation: "ip_location" },
      { omnia_mode: "permissive" },
    );

    assert.equal(result.tool, "OmnIA");
    assert.equal(result.operation, "ip_location");
    assert.equal(result.status, "success");
    assert.ok(result.data);
    assert.ok(typeof (result.data as any).ip === "string");
    assert.ok(result.guidance);
  });

  it("rejects unauthorized HTTP domain with structured policy report", async () => {
    const result = await executeOmniaOperation(
      {
        operation: "http_request",
        url: "https://unauthorized-domain-target.com/api",
        method: "GET",
      },
      {
        omnia_mode: "restricted",
        omnia_allowed_domains: "api.ipify.org, ipwho.is",
      },
    );

    assert.equal(result.tool, "OmnIA");
    assert.equal(result.status, "permission_denied");
    assert.match(result.error!, /not in the OmnIA allowed domains list/);
    assert.ok(result.policy);
    assert.equal(result.policy.mode, "restricted");
  });

  it("blocks HTTP mutation when read_only mode is configured", async () => {
    const result = await executeOmniaOperation(
      {
        operation: "http_request",
        url: "https://api.ipify.org",
        method: "POST",
        body: { test: true },
      },
      {
        omnia_mode: "read_only",
        omnia_allowed_domains: "api.ipify.org",
      },
    );

    assert.equal(result.tool, "OmnIA");
    assert.equal(result.status, "permission_denied");
    assert.match(result.error!, /read_only/);
  });

  it("blocks all operations when disabled mode is configured", async () => {
    const resultIp = await executeOmniaOperation(
      { operation: "ip_location" },
      { omnia_mode: "disabled" },
    );
    assert.equal(resultIp.tool, "OmnIA");
    assert.equal(resultIp.status, "permission_denied");
    assert.match(resultIp.error!, /disabled/i);

    const resultHttp = await executeOmniaOperation(
      { operation: "http_request", url: "https://api.ipify.org" },
      { omnia_mode: "disabled" },
    );
    assert.equal(resultHttp.tool, "OmnIA");
    assert.equal(resultHttp.status, "permission_denied");
    assert.match(resultHttp.error!, /disabled/i);
  });

  it("blocks ip_location in restricted mode if ipify/ipwho is not whitelisted", async () => {
    const result = await executeOmniaOperation(
      { operation: "ip_location" },
      {
        omnia_mode: "restricted",
        omnia_allowed_domains: "api.custom-domain.com, backend.internal.org",
      },
    );

    assert.equal(result.tool, "OmnIA");
    assert.equal(result.status, "permission_denied");
    assert.match(result.error!, /restricted/i);
    assert.match(result.error!, /api\.ipify\.org/);
  });

  it("normalizes case and aliases for permission mode parsing", () => {
    assert.equal(parseOmniaPermissions({ omnia_mode: "Read_Only" }).mode, "read_only");
    assert.equal(parseOmniaPermissions({ omnia_mode: "READ_ONLY" }).mode, "read_only");
    assert.equal(parseOmniaPermissions({ omnia_mode: "readonly" }).mode, "read_only");
    assert.equal(parseOmniaPermissions({ omnia_mode: "DISABLED" }).mode, "disabled");
    assert.equal(parseOmniaPermissions({ omnia_mode: "off" }).mode, "disabled");
    assert.equal(parseOmniaPermissions({ omniaMode: "restricted" }).mode, "restricted");
    assert.equal(parseOmniaPermissions({ security_mode: "restricted" }).mode, "restricted");
  });
});

describe("OmnIA Brand Assets & Logos", () => {
  it("provides valid SVG content for both dark and light variants", () => {
    assert.ok(OMNIA_LOGO_DARK_SVG.includes("<svg"));
    assert.ok(OMNIA_LOGO_DARK_SVG.includes("</svg>"));
    assert.ok(OMNIA_LOGO_LIGHT_SVG.includes("<svg"));
    assert.ok(OMNIA_LOGO_LIGHT_SVG.includes("</svg>"));

    // Check specific fill colors from the user's Inkscape logos
    assert.ok(OMNIA_LOGO_DARK_SVG.includes("#d97706")); // amber
    assert.ok(OMNIA_LOGO_DARK_SVG.includes("#3f3f46")); // dark zinc
    assert.ok(OMNIA_LOGO_LIGHT_SVG.includes("#d97706")); // amber
    assert.ok(OMNIA_LOGO_LIGHT_SVG.includes("#e5e7eb")); // light gray

    // Base64 data URIs
    assert.ok(OMNIA_LOGO_DARK_DATA_URI.startsWith("data:image/svg+xml;base64,"));
    assert.ok(OMNIA_LOGO_LIGHT_DATA_URI.startsWith("data:image/svg+xml;base64,"));
  });

  it("exposes properly structured tool definitions", () => {
    assert.equal(OMNIA_TOOL_DEFINITION.function.name, "omnia");
    assert.ok(OMNIA_TOOL_DEFINITION.function.parameters.properties.operation);
    assert.ok(OMNIA_TOOL_DEFINITION.function.parameters.properties.url);
    assert.ok(OMNIA_TOOL_DEFINITION.function.parameters.properties.method);
    assert.ok(OMNIA_TOOL_DEFINITION.function.parameters.properties.params);
    assert.ok(OMNIA_TOOL_DEFINITION.function.parameters.properties.headers);

    assert.equal(OMNIA_TOOLS.length, 5);
    const names = OMNIA_TOOLS.map((t) => t.function.name);
    assert.deepEqual(names, [
      "omnia",
      "omnia_ip_location",
      "omnia_http_request",
      "omnia_graphql",
      "omnia_inspect_docs",
    ]);
  });
});
