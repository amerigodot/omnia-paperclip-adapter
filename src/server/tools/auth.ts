import { createHmac } from "node:crypto";

export type AuthConfig =
  | {
      type: "bearer";
      tokenEnv?: string;
      token?: string;
    }
  | {
      type: "api_key";
      headerName?: string;
      keyEnv?: string;
      key?: string;
      in?: "header" | "query";
      paramName?: string;
    }
  | {
      type: "basic";
      userEnv?: string;
      passEnv?: string;
      username?: string;
      password?: string;
    }
  | {
      type: "hmac";
      secretEnv?: string;
      secret?: string;
      algorithm?: "sha256" | "sha512";
      headerName?: string;
      timestampHeader?: string;
      includeBody?: boolean;
    };

export interface ResolvedAuth {
  headers: Record<string, string>;
  queryParams: Record<string, string>;
}

function expandEnvValue(val?: string): string | undefined {
  if (!val) return val;
  const trimmed = val.trim();
  if (trimmed.startsWith("${") && trimmed.endsWith("}")) {
    const varName = trimmed.slice(2, -1).trim();
    return process.env[varName];
  }
  return val;
}

/**
 * Resolves authentication headers and query parameters from AuthConfig.
 * Secrets are resolved from process.env if env keys are specified, or direct values.
 */
export function resolveAuth(
  auth?: AuthConfig | null,
  requestContext?: { body?: unknown; method?: string; url?: string },
): ResolvedAuth {
  const result: ResolvedAuth = {
    headers: {},
    queryParams: {},
  };

  if (!auth) return result;

  switch (auth.type) {
    case "bearer": {
      const token =
        (auth.tokenEnv ? process.env[auth.tokenEnv] : undefined) ??
        expandEnvValue(auth.token) ??
        "";
      if (!token) {
        throw new Error(
          `[auth] Bearer token could not be resolved from env "${auth.tokenEnv ?? ""}" or token config.`,
        );
      }
      result.headers["Authorization"] = `Bearer ${token.trim()}`;
      break;
    }

    case "api_key": {
      const key =
        (auth.keyEnv ? process.env[auth.keyEnv] : undefined) ??
        expandEnvValue(auth.key) ??
        "";
      if (!key) {
        throw new Error(
          `[auth] API key could not be resolved from env "${auth.keyEnv ?? ""}" or key config.`,
        );
      }
      if (auth.in === "query") {
        const paramName = auth.paramName || auth.headerName || "api_key";
        result.queryParams[paramName] = key.trim();
      } else {
        const headerName = auth.headerName || "X-API-Key";
        result.headers[headerName] = key.trim();
      }
      break;
    }

    case "basic": {
      const username =
        (auth.userEnv ? process.env[auth.userEnv] : undefined) ??
        expandEnvValue(auth.username) ??
        "";
      const password =
        (auth.passEnv ? process.env[auth.passEnv] : undefined) ??
        expandEnvValue(auth.password) ??
        "";
      if (!username) {
        throw new Error(
          `[auth] Basic auth username could not be resolved from env "${auth.userEnv ?? ""}" or username config.`,
        );
      }
      const encoded = Buffer.from(`${username}:${password}`).toString("base64");
      result.headers["Authorization"] = `Basic ${encoded}`;
      break;
    }

    case "hmac": {
      const secret =
        (auth.secretEnv ? process.env[auth.secretEnv] : undefined) ??
        expandEnvValue(auth.secret) ??
        "";
      if (!secret) {
        throw new Error(
          `[auth] HMAC secret could not be resolved from env "${auth.secretEnv ?? ""}" or secret config.`,
        );
      }
      const algorithm = auth.algorithm || "sha256";
      const headerName = auth.headerName || "X-Signature";
      const tsHeader = auth.timestampHeader || "X-Timestamp";
      const timestamp = String(Date.now());

      result.headers[tsHeader] = timestamp;

      let payloadToSign = timestamp;
      if (auth.includeBody && requestContext?.body) {
        const bodyStr =
          typeof requestContext.body === "string"
            ? requestContext.body
            : JSON.stringify(requestContext.body);
        payloadToSign = `${timestamp}.${bodyStr}`;
      }

      const sig = createHmac(algorithm, secret)
        .update(payloadToSign)
        .digest("hex");
      result.headers[headerName] = `${algorithm}=${sig}`;
      break;
    }

    default:
      break;
  }

  return result;
}
