export { MCP_SERVER_NAME, parseCustomArgs } from './defs/shared.js';
export { customAgentDef } from './defs/custom.js';
export { AGENT_DEFS, findAgentDef } from './registry.js';
export { detectAll, detectOne, detectCustom, resolveBin, probeVersion, augmentedPath } from './detect.js';
export { mcpServerSpec, mcpConfigSnippet } from './mcp-config.js';
export { runExternalAgent } from './runner.js';
