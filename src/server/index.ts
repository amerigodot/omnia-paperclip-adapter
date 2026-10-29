import type { ServerAdapterModule } from "../types.js";
import { type, agentConfigurationDoc, models } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listOllamaModels, refreshOllamaModels } from "./models.js";
import { getConfigSchema } from "./config-schema.js";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listOllamaModels, refreshOllamaModels } from "./models.js";
export { getConfigSchema } from "./config-schema.js";

// Built-in Tools & Types
export {
  getIpLocation,
  getPublicIp,
  IP_LOCATION_TOOL_DEFINITION,
  type IpLocationData,
} from "./tools/ip-location.js";

export {
  resolveAuth,
  type AuthConfig,
  type ResolvedAuth,
} from "./tools/auth.js";

export {
  loadOpenApiSpec,
  parseOpenApiDocument,
  formatOpenApiDocs,
  executeRestEndpoint,
  type OpenApiOperation,
  type OpenApiParameter,
  type ParsedOpenApiSpec,
  type ExecuteEndpointOptions,
  type EndpointExecutionResult,
} from "./tools/openapi.js";

export {
  executeGraphQL,
  introspectGraphQLSchema,
  formatGraphQLDocs,
  GRAPHQL_INTROSPECTION_QUERY,
  type GraphQLExecutionOptions,
  type GraphQLExecutionResult,
  type ParsedGraphQLSchema,
} from "./tools/graphql.js";

export {
  CALL_API_ENDPOINT_TOOL_DEFINITION,
  QUERY_GRAPHQL_TOOL_DEFINITION,
  INSPECT_API_DOCS_TOOL_DEFINITION,
  GENERIC_API_TOOLS,
  handleCallApiEndpoint,
  handleQueryGraphQL,
  handleInspectApiDocs,
} from "./tools/custom-endpoint.js";

export {
  OMNIA_TOOL_DEFINITION,
  OMNIA_TOOLS,
  OMNIA_IP_TOOL_DEFINITION,
  OMNIA_HTTP_TOOL_DEFINITION,
  OMNIA_GRAPHQL_TOOL_DEFINITION,
  OMNIA_INSPECT_TOOL_DEFINITION,
  executeOmniaOperation,
  parseOmniaPermissions,
  isDomainAllowed,
  isMethodAllowed,
  type OmniaOperation,
  type OmniaPermissionMode,
  type OmniaPermissions,
  type OmniaCallArguments,
  type OmniaExecutionResult,
} from "./tools/omnia.js";

export {
  OMNIA_LOGO_DARK_SVG,
  OMNIA_LOGO_LIGHT_SVG,
  OMNIA_LOGO_DARK_DATA_URI,
  OMNIA_LOGO_LIGHT_DATA_URI,
} from "./tools/omnia-icons.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    listModels: () => listOllamaModels(),
    refreshModels: () => refreshOllamaModels(),
    getConfigSchema,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    agentConfigurationDoc,
    models,
  };
}
