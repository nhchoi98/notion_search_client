import express from 'express';
import cors from 'cors';
import { createOpenAIClient } from './lib/openaiClient.js';
import { writeSSE, streamText, parseRoutePlan } from './lib/streaming.js';
import { createOrchestrationRuntime } from './lib/orchestration.js';
import { normalizeMCPResponse, resolveConversation, proxyResponse } from './lib/mcpShared.js';
import {
  summarizeStructuredForDisplay,
  formatContentArrayAsMarkdown,
} from './lib/mcpResponseFormatting.js';
import { hasSummaryIntent, findSummaryTool } from './lib/policies/summaryPolicy.js';
import {
  hasGitHubPRIntent,
  evaluateGitHubPRReadiness,
  buildGitHubPRWorkflowSteps,
} from './lib/policies/githubPrPolicy.js';
import {
  buildRouteDecisionPrompt,
  buildToolSelectionPrompt,
  CHAT_ONLY_PROMPT,
} from './prompts/mcpPrompts.js';

const app = express();
const PORT = Number(process.env.PORT || 4000);
const LOCAL_MCP_ENDPOINT = process.env.LOCAL_MCP_ENDPOINT || 'http://localhost:3001/mcp';
const FRONT_ORIGIN = process.env.FRONT_ORIGIN || 'http://localhost:5173';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const LOCAL_MCP_TOKEN = process.env.LOCAL_MCP_TOKEN || '';
const LOCAL_MCP_DEFAULT_PATHS = (process.env.LOCAL_MCP_DEFAULT_PATHS || 'notes/')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const { callOpenAI } = createOpenAIClient({
  apiKey: OPENAI_API_KEY,
  model: OPENAI_MODEL,
});

app.use(
  cors({
    origin: FRONT_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json());

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'local-mcp-bridge' });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/mcp')) {
    console.log('[http] request', req.method, req.path, {
      query: req.query,
      bodyMode: req.body && typeof req.body === 'object' ? Object.keys(req.body) : typeof req.body,
    });
  }
  next();
});

const safeParseResponse = async (response) => {
  const text = await response.text();
  try {
    return { status: response.status, parsed: text ? JSON.parse(text) : null, raw: text };
  } catch {
    return { status: response.status, parsed: null, raw: text };
  }
};

const resolveLocalMCPManifestUrl = (targetUrl) => {
  try {
    const url = new URL(targetUrl);
    const path = (url.pathname || '').replace(/\/$/, '');
    if (!path || path === '/') {
      url.pathname = '/mcp/manifest';
      return url.toString();
    }

    if (path === '/api/mcp/chat') {
      url.pathname = '/mcp/manifest';
      return url.toString();
    }

    if (path.endsWith('/mcp')) {
      url.pathname = `${path}/manifest`;
      return url.toString();
    }

    if (path.endsWith('/mcp/')) {
      url.pathname = `${path}manifest`;
      return url.toString();
    }

    url.pathname = `${path}/manifest`;
    return url.toString();
  } catch {
    return targetUrl;
  }
};

const fetchManifest = async (targetUrl, headers = {}) => {
  const manifestUrl = resolveLocalMCPManifestUrl(targetUrl);
  let response;
  try {
    response = await fetch(manifestUrl, {
      method: 'GET',
      headers,
    });
  } catch {
    return {
      data: null,
      status: 0,
      source: manifestUrl,
      error: 'fetch_failed',
    };
  }

  const parsed = await safeParseResponse(response);
  if (!parsed || !response.ok || !parsed.parsed) {
    return {
      data: null,
      status: parsed.status,
      source: manifestUrl,
      error: parsed.parsed?.detail || parsed.raw || null,
    };
  }

  return {
    data: parsed.parsed,
    status: parsed.status,
    source: manifestUrl,
    error: null,
  };
};

const mergeToolSpecs = (baseTools = [], enrichedTools = []) => {
  const enrichedMap = new Map();
  for (const tool of enrichedTools) {
    if (tool && typeof tool.name === 'string') {
      enrichedMap.set(tool.name, tool);
    }
  }

  const merged = baseTools.map((tool) => {
    if (!tool || typeof tool.name !== 'string') {
      return tool;
    }

    const enriched = enrichedMap.get(tool.name);
    if (!enriched) {
      return tool;
    }

    return {
      ...tool,
      ...enriched,
      inputSchema: {
        ...tool.inputSchema,
        ...enriched.inputSchema,
      },
    };
  });

  const existingNames = new Set(merged.map((tool) => tool?.name));
  for (const enriched of enrichedTools) {
    if (enriched && typeof enriched.name === 'string' && !existingNames.has(enriched.name)) {
      merged.push(enriched);
    }
  }

  return merged;
};

const normalizeDiscoveryExpectedPaths = (input) => {
  if (!Array.isArray(input)) {
    return [];
  }

  const collected = [];
  for (const item of input) {
    if (typeof item === 'string') {
      const parsed = normalizePathInput(item);
      if (parsed.length > 0) {
        collected.push(...parsed);
      }
    } else if (Array.isArray(item)) {
      collected.push(...normalizeDiscoveryExpectedPaths(item));
    }
  }

  return [...new Set(collected.filter(Boolean))];
};

const findToolByName = (tools = [], name = '') => {
  if (!name || !Array.isArray(tools)) {
    return null;
  }

  const target = String(name).trim();
  if (!target) {
    return null;
  }

  return tools.find((tool) => tool?.name === target) || null;
};

const pickDiscoveryTool = (tools = [], requested = '') => {
  if (requested) {
    const direct = findToolByName(tools, requested);
    if (direct) {
      return direct;
    }
  }

  const hints = ['discover', 'search', 'scan', 'list', 'find', 'index'];
  return (
    tools.find((tool) => {
      const name = String(tool?.name || '').toLowerCase();
      return name && hints.some((hint) => name.includes(hint));
    }) || null
  );
};

const pickFallbackDiscoveryTool = (tools = [], selectedToolName = '') => {
  const selected = String(selectedToolName || '').toLowerCase();
  const hintPriority = ['search', 'scan', 'find', 'discover', 'list', 'index'];
  for (const hint of hintPriority) {
    const found = tools.find((tool) => {
      const name = String(tool?.name || '').toLowerCase();
      const schema = tool?.inputSchema || {};
      const hasPaths = (schema.required || []).includes('paths');
      if (name === selected || hasPaths) {
        return false;
      }
      return name.includes(hint);
    });
    if (found) {
      return found;
    }
  }

  const anyNoPathRequired = tools.find((tool) => {
    const schema = tool?.inputSchema || {};
    return !Array.isArray(schema.required) || !schema.required.includes('paths');
  });
  if (anyNoPathRequired) {
    return anyNoPathRequired;
  }

  return tools.find((tool) => tool?.name !== selectedToolName) || null;
};

const discoverPathsWithTool = async ({
  discoveryTool,
  routedQuery,
  discoveryPlan,
  callTool,
  requestType = 'discovery',
  requiredPathsFallback = [],
}) => {
  const planArgs =
    discoveryPlan?.toolArguments &&
    typeof discoveryPlan.toolArguments === 'object' &&
    !Array.isArray(discoveryPlan.toolArguments)
      ? discoveryPlan.toolArguments
      : { query: routedQuery };
  const args = sanitizeToolArguments(discoveryTool, routedQuery, planArgs, routedQuery);
  const result = await callTool(discoveryTool.name, args, requestType);

  const paths = parseDiscoveryResultPaths(result);
  const merged = [...new Set([...(requiredPathsFallback || []), ...paths])];
  return {
    args,
    result,
    paths: merged.filter(Boolean),
  };
};

const collectPathsFromDiscoveryValue = (value, acc) => {
  if (!value) {
    return;
  }

  if (typeof value === 'string') {
    const values = normalizePathInput(value);
    if (values.length > 0) {
      acc.push(...values);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathsFromDiscoveryValue(item, acc);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase().includes('path')) {
        collectPathsFromDiscoveryValue(child, acc);
        continue;
      }

      if (key.toLowerCase() === 'files' || key.toLowerCase() === 'items') {
        collectPathsFromDiscoveryValue(child, acc);
      }
    }
  }
};

const parseDiscoveryResultPaths = (callResult) => {
  const parsed = [];

  const structured = callResult?.parsed?.result?.structuredContent;
  if (structured) {
    if (Array.isArray(structured.paths)) {
      collectPathsFromDiscoveryValue(structured.paths, parsed);
    }

    if (Array.isArray(structured.files)) {
      collectPathsFromDiscoveryValue(structured.files, parsed);
    }

    if (Array.isArray(structured.results)) {
      collectPathsFromDiscoveryValue(structured.results, parsed);
    }

    if (parsed.length === 0) {
      collectPathsFromDiscoveryValue(structured, parsed);
    }
  }

  const contentArray = Array.isArray(callResult?.parsed?.result?.content)
    ? callResult.parsed.result.content
    : [];
  for (const item of contentArray) {
    if (item?.text && typeof item.text === 'string') {
      collectPathsFromDiscoveryValue(item.text, parsed);
    }

    if (item?.text && typeof item.text === 'object' && item.text !== null) {
      collectPathsFromDiscoveryValue(item.text, parsed);
    }
  }

  if (parsed.length === 0 && typeof callResult?.parsed?.result?.answer === 'string') {
    collectPathsFromDiscoveryValue(callResult.parsed.result.answer, parsed);
  }

  const deduped = [...new Set(parsed.filter(Boolean))];
  return deduped;
};

const normalizeToolCandidates = (value, acc) => {
  if (!value) {
    return;
  }

  if (typeof value === 'string') {
    const paths = normalizePathInput(value);
    if (paths.length > 0) {
      acc.push(...paths);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeToolCandidates(item, acc);
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  const obj = value || {};
  if (typeof obj.path === 'string' && obj.path.trim()) {
    acc.push(obj.path);
  }

  if (typeof obj.file === 'string' && obj.file.trim()) {
    acc.push(obj.file);
  }

  if (typeof obj.file_path === 'string' && obj.file_path.trim()) {
    acc.push(obj.file_path);
  }

  if (typeof obj.filepath === 'string' && obj.filepath.trim()) {
    acc.push(obj.filepath);
  }

  if (typeof obj.source === 'string' && obj.source.trim()) {
    acc.push(obj.source);
  }

  for (const [, child] of Object.entries(obj)) {
    if (child && (typeof child === 'object' || Array.isArray(child) || typeof child === 'string')) {
      normalizeToolCandidates(child, acc);
    }
  }
};

const collectPathsFromToolResult = (callResult) => {
  const acc = [];
  const structured = callResult?.parsed?.result?.structuredContent;
  if (structured) {
    if (Array.isArray(structured.hits)) {
      normalizeToolCandidates(structured.hits, acc);
    }
    if (Array.isArray(structured.paths)) {
      normalizeToolCandidates(structured.paths, acc);
    }
    if (Array.isArray(structured.files)) {
      normalizeToolCandidates(structured.files, acc);
    }
    if (Array.isArray(structured.docs)) {
      normalizeToolCandidates(structured.docs, acc);
    }
    if (Array.isArray(structured.documents)) {
      normalizeToolCandidates(structured.documents, acc);
    }
    if (Array.isArray(structured.results)) {
      normalizeToolCandidates(structured.results, acc);
    }
  }

  const contentArray = Array.isArray(callResult?.parsed?.result?.content)
    ? callResult.parsed.result.content
    : [];
  for (const item of contentArray) {
    if (!item) {
      continue;
    }

    if (typeof item.path === 'string') {
      acc.push(item.path);
    }

    if (item.text && typeof item.text === 'string') {
      normalizeToolCandidates(item.text, acc);
    }

    if (item.path && typeof item.path === 'object') {
      normalizeToolCandidates(item.path, acc);
    }
  }

  if (typeof callResult?.parsed?.result?.answer === 'string') {
    normalizeToolCandidates(callResult.parsed.result.answer, acc);
  }

  return [...new Set(acc.filter(Boolean))];
};

const chooseBestTool = (tools = [], prompt = '') => {
  const text = prompt.toLowerCase();
  const ruleSets = [
    {
      keys: ['요약', 'summary', '정리', '요약해', '요약좀'],
      names: ['summary', 'summar', 'summarize', 'rebuild', 'rebuild_summary'],
    },
    {
      keys: ['검색', '찾', 'search', 'query', 'lookup', '찾아'],
      names: ['search', 'query', 'find', 'lookup'],
    },
  ];

  for (const rule of ruleSets) {
    if (rule.keys.some((key) => text.includes(key))) {
      const foundByName =
        tools.find((tool) => rule.names.some((name) => tool?.name?.toLowerCase().includes(name))) ||
        tools[0];
      if (foundByName) {
        return foundByName;
      }
    }
  }

  return tools[0] || null;
};

const isSearchLikeTool = (toolName = '') => {
  const name = String(toolName || '').toLowerCase();
  return ['search', 'query', 'find', 'lookup'].some((keyword) => name.includes(keyword));
};

const normalizePathInput = (input = '') => {
  if (Array.isArray(input)) {
    const normalized = input.map((item) => {
      return typeof item === 'string' ? item.trim() : String(item).trim();
    });
    return [...new Set(normalized.filter(Boolean))];
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return [];
    }

    const hasPathHint =
      /[\\/]/.test(trimmed) ||
      /\.[a-zA-Z0-9]+$/.test(trimmed) ||
      /\b[\w.-]+\//.test(trimmed) ||
      /\b[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+/.test(trimmed);

    const extracted =
      trimmed.match(
        /([./][^\s]+\.[a-zA-Z0-9]+|[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+|[a-zA-Z0-9._-]+\.md|\b\w+\/)/g,
      ) || [];
    const splitByTokens = trimmed
      .split(/[;,\\n]/)
      .map((token) => token.trim())
      .filter(Boolean);
    const values =
      extracted.length > 0 ? extracted : splitByTokens.length > 0 ? splitByTokens : [input];
    const normalized = values.filter((value) => typeof value === 'string' && value.trim());

    if (extracted.length === 0 && normalized.length === 1) {
      const first = normalized[0] || '';
      if (typeof first === 'string' && (first.includes(' ') || !hasPathHint)) {
        return [];
      }
    }

    return [...new Set(normalized.filter(Boolean))];
  }

  return [];
};

const normalizeArrayArgument = (input) => {
  if (Array.isArray(input)) {
    return [...new Set(input.map((item) => String(item).trim()).filter(Boolean))];
  }

  if (typeof input === 'string') {
    return normalizePathInput(input);
  }

  return [];
};

const getDefaultPaths = () => [...LOCAL_MCP_DEFAULT_PATHS];
const getRetryPathCandidates = () => {
  const candidates = [...getDefaultPaths(), 'notes/'];
  return [...new Set(candidates.map((item) => String(item || '').trim()).filter(Boolean))];
};

const inferDefaultArguments = (tool) => {
  if (!tool || typeof tool !== 'object') {
    return {};
  }

  const properties = (tool.inputSchema || {}).properties || {};
  const defaults = {};

  if (Object.prototype.hasOwnProperty.call(properties, 'output_path')) {
    defaults.output_path = 'output.md';
  }

  return defaults;
};

const buildToolArguments = (tool, prompt = '') => {
  if (!tool || typeof tool !== 'object') {
    return { query: prompt };
  }

  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const keys = Object.keys(props);
  const toolName = (tool.name || '').toLowerCase();
  const seed = typeof prompt === 'string' ? prompt.trim() : '';

  const defaults = inferDefaultArguments(tool);
  const addDefaults = (args) => {
    return {
      ...defaults,
      ...args,
      ...((keys.includes('output_path') || required.includes('output_path')) &&
      !Object.prototype.hasOwnProperty.call(args, 'output_path')
        ? { output_path: defaults.output_path }
        : {}),
    };
  };

  if (
    toolName.includes('rebuild_summary') ||
    (required.includes('paths') && required.includes('output_path'))
  ) {
    return addDefaults({
      paths: normalizePathInput(seed),
    });
  }

  if (required.includes('paths') && keys.includes('paths')) {
    return addDefaults({
      paths: normalizePathInput(seed),
    });
  }

  if (keys.includes('paths')) {
    return addDefaults({
      paths: normalizePathInput(seed),
    });
  }

  if (required.includes('output_path') && !Object.prototype.hasOwnProperty.call(props, 'query')) {
    const args = {};
    const outputKey = keys.find((key) => key.toLowerCase().includes('output'));
    if (outputKey) {
      args[outputKey] = 'output.md';
    }
    const firstRequired = required.find((key) => key !== outputKey);
    if (firstRequired) {
      args[firstRequired] = seed;
    }
    return args;
  }

  const candidate = ['query', 'input', 'text', 'prompt', 'q', 'question', 'content'].find((key) =>
    keys.includes(key),
  );

  if (candidate) {
    return { [candidate]: seed };
  }

  if (required.length > 0) {
    return { [required[0]]: seed };
  }

  if (keys.length > 0) {
    return { [keys[0]]: seed };
  }

  return { query: seed };
};

const sanitizeToolArguments = (tool, prompt = '', toolArguments = {}, routedQuery = '') => {
  const inputArgs =
    toolArguments && typeof toolArguments === 'object' && !Array.isArray(toolArguments)
      ? { ...toolArguments }
      : {};
  if (!tool || typeof tool !== 'object') {
    return inputArgs;
  }

  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const keys = Object.keys(props);
  const seed = routedQuery && typeof routedQuery === 'string' ? routedQuery : prompt;

  if (keys.includes('paths') || required.includes('paths')) {
    const providedPaths = normalizeArrayArgument(
      inputArgs.paths || inputArgs.path || inputArgs.path_list,
    );
    const fallbackPaths = normalizePathInput(seed);
    const paths =
      providedPaths.length > 0
        ? providedPaths
        : fallbackPaths.length > 0
          ? fallbackPaths
          : getDefaultPaths();
    inputArgs.paths = paths.length > 0 ? paths : [];
  }

  if (required.includes('output_path') || keys.includes('output_path')) {
    if (typeof inputArgs.output_path !== 'string' || !inputArgs.output_path.trim()) {
      inputArgs.output_path = 'output.md';
    }
  }

  for (const [propName, propSchema] of Object.entries(props)) {
    if (inputArgs[propName] === undefined || inputArgs[propName] === null) {
      continue;
    }

    const rawType = propSchema?.type;
    const types = Array.isArray(rawType) ? new Set(rawType) : new Set([rawType]);

    if (types.has('array')) {
      inputArgs[propName] = normalizeArrayArgument(inputArgs[propName]);
      continue;
    }

    if (
      types.has('string') &&
      !Array.isArray(inputArgs[propName]) &&
      typeof inputArgs[propName] !== 'string'
    ) {
      inputArgs[propName] = String(inputArgs[propName]);
    }
  }

  for (const requiredKey of required) {
    if (Object.prototype.hasOwnProperty.call(inputArgs, requiredKey)) {
      continue;
    }

    if (requiredKey === 'output_path') {
      inputArgs.output_path = 'output.md';
      continue;
    }

    if (requiredKey === 'paths') {
      if (!Array.isArray(inputArgs.paths) || inputArgs.paths.length === 0) {
        const parsedPaths = normalizePathInput(seed);
        inputArgs.paths = parsedPaths.length > 0 ? parsedPaths : getDefaultPaths();
      }
      continue;
    }

    if (keys.includes(requiredKey) || typeof requiredKey === 'string') {
      inputArgs[requiredKey] = seed;
    }
  }

  const candidateKeys = ['query', 'input', 'text', 'prompt', 'q', 'question', 'content'];
  for (const key of candidateKeys) {
    if (keys.includes(key) && !Object.prototype.hasOwnProperty.call(inputArgs, key)) {
      inputArgs[key] = seed;
      break;
    }
  }

  return inputArgs;
};

const extractToolSummary = (tools = []) => {
  return tools.map((tool) => {
    const schema = tool?.inputSchema || {};
    return {
      name: tool?.name || '',
      description: tool?.description || '',
      required: Array.isArray(schema.required) ? schema.required : [],
      properties: schema.properties || {},
    };
  });
};

const planMCPToolCall = async (prompt, tools = []) => {
  const toolSummaries = extractToolSummary(tools);
  if (!Array.isArray(toolSummaries) || toolSummaries.length === 0) {
    return null;
  }

  const toolPrompt = buildToolSelectionPrompt(toolSummaries);

  const response = await callOpenAI({
    responseFormat: 'json',
    messages: [
      { role: 'system', content: toolPrompt },
      { role: 'user', content: `사용자 요청: ${prompt}` },
    ],
  });

  const parsed = (() => {
    try {
      const value = JSON.parse(response);
      if (value && typeof value === 'object') {
        return value;
      }
    } catch {
      // noop
    }
    return null;
  })();

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const targetToolName = typeof parsed.tool === 'string' ? parsed.tool : '';
  const hasTool = targetToolName
    ? toolSummaries.some((tool) => tool.name === targetToolName)
    : false;
  const toolArguments =
    parsed.tool_arguments &&
    typeof parsed.tool_arguments === 'object' &&
    !Array.isArray(parsed.tool_arguments)
      ? parsed.tool_arguments
      : {};
  const discoveryInput =
    parsed.discovery && typeof parsed.discovery === 'object' ? parsed.discovery : null;
  const requestedDiscoveryTool =
    typeof discoveryInput?.tool === 'string' ? discoveryInput.tool : '';
  const requestedDiscoveryToolExists = requestedDiscoveryTool
    ? toolSummaries.some((tool) => tool.name === requestedDiscoveryTool)
    : false;

  return {
    tool: hasTool ? targetToolName : null,
    toolArguments,
    routedQuery:
      typeof parsed.routed_query === 'string' && parsed.routed_query.trim()
        ? parsed.routed_query
        : prompt,
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
    discovery: {
      tool: requestedDiscoveryToolExists ? requestedDiscoveryTool : null,
      toolArguments:
        discoveryInput?.tool_arguments &&
        typeof discoveryInput.tool_arguments === 'object' &&
        !Array.isArray(discoveryInput.tool_arguments)
          ? discoveryInput.tool_arguments
          : {},
      expected_paths: normalizeDiscoveryExpectedPaths(discoveryInput?.expected_paths),
    },
  };
};

const buildMCPHeaders = () => {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (LOCAL_MCP_TOKEN) {
    headers.Authorization = `Bearer ${LOCAL_MCP_TOKEN}`;
  }
  return headers;
};

const collectMCPToolContext = async ({ localEndpoint }) => {
  const targetUrl = resolveLocalMCPUrl({ localEndpoint });
  const headers = buildMCPHeaders();
  const requestId = String(Date.now());
  const postToMCP = async (payload) => {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return safeParseResponse(response);
  };

  const initializePayload = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
    },
  };

  const init = await postToMCP(initializePayload);
  if (init.status >= 400 || !init.parsed || init.parsed.jsonrpc !== '2.0') {
    return {
      ok: false,
      status: init.status,
      error: init.parsed?.error?.message || init.raw || 'initialize_failed',
      targetUrl,
      tools: [],
      manifestAttempt: null,
    };
  }

  const manifestAttempt = await fetchManifest(targetUrl, headers);
  const manifestTools = Array.isArray(manifestAttempt.data?.tools)
    ? manifestAttempt.data.tools
    : [];
  const toolsPayload = {
    jsonrpc: '2.0',
    id: `${requestId}-tools`,
    method: 'tools/list',
    params: {},
  };

  let tools = manifestTools;
  if (manifestTools.length > 0) {
    const toolsResponse = await postToMCP(toolsPayload);
    if (toolsResponse.status < 400 && Array.isArray(toolsResponse.parsed?.result?.tools)) {
      tools = mergeToolSpecs(manifestTools, toolsResponse.parsed.result.tools);
    }
  } else {
    const toolsResponse = await postToMCP(toolsPayload);
    if (toolsResponse.status < 400 && Array.isArray(toolsResponse.parsed?.result?.tools)) {
      tools = toolsResponse.parsed.result.tools;
    } else {
      return {
        ok: false,
        status: toolsResponse.status || 500,
        error: toolsResponse.parsed?.error?.message || toolsResponse.raw || 'tools_list_failed',
        targetUrl,
        tools: [],
        manifestAttempt,
      };
    }
  }

  return {
    ok: true,
    status: 200,
    error: null,
    targetUrl,
    tools,
    manifestAttempt,
  };
};

const planExecutionFromManifest = async ({ prompt, routedQuery, localEndpoint }) => {
  const context = await collectMCPToolContext({ localEndpoint });
  if (!context.ok || !Array.isArray(context.tools) || context.tools.length === 0) {
    return {
      executionPlan: null,
      context,
    };
  }

  const query = routedQuery || prompt;
  const syncStatusTool = findToolByName(context.tools, 'sync_status');
  const createPRTool = findToolByName(context.tools, 'create_pr');
  const pullTool =
    findToolByName(context.tools, 'sync_pull') ||
    findToolByName(context.tools, 'pull_changes') ||
    findToolByName(context.tools, 'pull');
  if (hasGitHubPRIntent(query) && syncStatusTool && createPRTool) {
    const createPRArgs = sanitizeToolArguments(
      createPRTool,
      query,
      { commit_message: 'Update knowledge' },
      query,
    );
    return {
      executionPlan: {
        tool: syncStatusTool.name,
        toolArguments: {},
        routedQuery: query,
        explanation: 'github_pr_workflow_precheck',
        workflow: buildGitHubPRWorkflowSteps({
          syncStatusToolName: syncStatusTool.name,
          pullToolName: pullTool?.name || null,
          createPRToolName: createPRTool.name,
          createPRToolArguments: createPRArgs,
        }),
      },
      context,
    };
  }

  const llmPlan = await planMCPToolCall(query, context.tools);
  if (llmPlan && llmPlan.tool) {
    const selected = findToolByName(context.tools, llmPlan.tool);
    if (selected) {
      const sanitizedArgs = sanitizeToolArguments(
        selected,
        query,
        llmPlan.toolArguments || {},
        llmPlan.routedQuery || query,
      );
      if (
        (!Array.isArray(sanitizedArgs.paths) || sanitizedArgs.paths.length === 0) &&
        hasSummaryIntent(query)
      ) {
        sanitizedArgs.paths = getDefaultPaths();
      }

      return {
        executionPlan: {
          ...llmPlan,
          toolArguments: sanitizedArgs,
          routedQuery: llmPlan.routedQuery || query,
        },
        context,
      };
    }
  }

  const selectedTool = chooseBestTool(context.tools, query);
  if (!selectedTool) {
    return {
      executionPlan: null,
      context,
    };
  }

  const args = sanitizeToolArguments(
    selectedTool,
    query,
    buildToolArguments(selectedTool, query),
    query,
  );
  if ((!Array.isArray(args.paths) || args.paths.length === 0) && hasSummaryIntent(query)) {
    args.paths = getDefaultPaths();
  }
  const discoveryTool = pickFallbackDiscoveryTool(context.tools, selectedTool.name);
  return {
    executionPlan: {
      tool: selectedTool.name,
      toolArguments: args,
      routedQuery: query,
      explanation: 'manifest 기반 도구/탐색 계획',
      discovery: {
        tool: discoveryTool?.name || null,
        toolArguments: { query },
        expected_paths: getRetryPathCandidates(),
      },
    },
    context,
  };
};

const shouldRetryForPathIssue = (response) => {
  if (!response || typeof response !== 'object') {
    return false;
  }

  if (response.requiresInput === true && response.missing === 'paths') {
    return true;
  }

  const answer = typeof response.answer === 'string' ? response.answer : '';
  if (!answer) {
    return false;
  }

  return (
    /(경로|path).*(없|누락|못 찾|찾기 어렵|does not exist|invalid)/i.test(answer) ||
    /no valid files/i.test(answer) ||
    /invalid paths?/i.test(answer) ||
    /use\s+list_docs/i.test(answer)
  );
};

const buildRetryExecutionPlan = (executionPlan = null) => {
  const fallbackPaths = getRetryPathCandidates();
  if (!executionPlan || typeof executionPlan !== 'object') {
    return null;
  }

  const nextToolArgs =
    executionPlan.toolArguments &&
    typeof executionPlan.toolArguments === 'object' &&
    !Array.isArray(executionPlan.toolArguments)
      ? { ...executionPlan.toolArguments }
      : {};
  nextToolArgs.paths = fallbackPaths;

  return {
    ...executionPlan,
    toolArguments: nextToolArgs,
    discovery: {
      ...(executionPlan.discovery || {}),
      expected_paths: fallbackPaths,
    },
  };
};

const resolveLocalMCPUrl = (body) => {
  if (typeof body?.localEndpoint === 'string' && body.localEndpoint.trim()) {
    try {
      const url = new URL(body.localEndpoint.trim());
      if (url.pathname.endsWith('/api/mcp/chat')) {
        url.pathname = '/mcp';
      } else if (!url.pathname || url.pathname === '/') {
        url.pathname = '/mcp';
      }
      return url.toString();
    } catch {
      return body.localEndpoint.trim();
    }
  }
  return LOCAL_MCP_ENDPOINT;
};

const callLocalMCP = async ({
  prompt,
  localEndpoint,
  conversation = [],
  useLLMPlanner = false,
  preplannedToolPlan = null,
  eventEmitter = null,
}) => {
  // MCP Agent 실행 핵심 루틴:
  // initialize -> tools 조회 -> (선택/탐색) -> tools/call -> 결과 정규화
  const targetUrl = resolveLocalMCPUrl({ localEndpoint });
  const emitEvent = (type, payload) => {
    if (typeof eventEmitter === 'function') {
      eventEmitter(type, payload || {});
    }
  };
  emitEvent('progress', { step: 'start', targetUrl, useLLMPlanner, prompt });
  console.log('[local-mcp call]', { prompt, targetUrl, useLLMPlanner });

  const headers = buildMCPHeaders();

  const requestId = String(Date.now());
  const postToMCP = async (payload) => {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return safeParseResponse(response);
  };

  const initializePayload = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
    },
  };

  const init = await postToMCP(initializePayload);
  if (init.status === 404) {
    emitEvent('progress', { step: 'init_legacy_fallback', status: init.status });
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        conversation: resolveConversation(conversation),
      }),
    });

    const textFallback = await response.text();
    let parsed = null;
    try {
      parsed = textFallback ? JSON.parse(textFallback) : null;
    } catch {
      if (textFallback) {
        parsed = { answer: textFallback };
      }
    }

    if (!response.ok) {
      emitEvent('error', {
        step: 'init_legacy_fallback_failed',
        status: response.status,
        raw: textFallback,
      });
      return {
        status: response.status,
        data: {
          action: 'local-mcp',
          answer: `로컬 MCP 오류 (${response.status}): ${textFallback || '응답이 비정상입니다.'}`,
        },
      };
    }

    return {
      status: 200,
      data: normalizeMCPResponse(parsed),
    };
  }

  if (init.status >= 400 || !init.parsed || init.parsed.jsonrpc !== '2.0') {
    emitEvent('error', {
      step: 'init_failed',
      status: init.status,
      error: init.parsed?.error || init.raw,
    });
    return {
      status: init.status,
      data: {
        action: 'local-mcp',
        answer: init.parsed?.error?.message || init.raw || '로컬 MCP 초기화에 실패했습니다.',
      },
    };
  }

  const toolsPayload = {
    jsonrpc: '2.0',
    id: `${requestId}-tools`,
    method: 'tools/list',
    params: {},
  };

  const manifestAttempt = await fetchManifest(targetUrl, headers);
  emitEvent('progress', {
    step: 'manifest_fetch',
    status: manifestAttempt.status,
    source: manifestAttempt.source,
    count: manifestAttempt.data?.tools?.length || 0,
  });
  const manifestTools = Array.isArray(manifestAttempt.data?.tools)
    ? manifestAttempt.data.tools
    : [];
  let toolList = [];
  let tools = manifestTools;
  const fallbackUsed = manifestTools.length === 0;

  if (tools.length > 0) {
    const toolsResponse = await postToMCP(toolsPayload);
    if (toolsResponse.status < 400 && Array.isArray(toolsResponse.parsed?.result?.tools)) {
      toolList = toolsResponse.parsed.result.tools;
      tools = mergeToolSpecs(manifestTools, toolList);
      emitEvent('progress', {
        step: 'tools_list',
        status: toolsResponse.status,
        toolCount: toolList.length,
        mergedFromManifest: true,
      });
    }
  } else {
    const toolsResponse = await postToMCP(toolsPayload);
    if (toolsResponse.status >= 400 || !Array.isArray(toolsResponse.parsed?.result?.tools)) {
      emitEvent('error', {
        step: 'tools_list_failed',
        status: toolsResponse.status,
        error: toolsResponse.parsed?.error || toolsResponse.raw,
      });
      return {
        status: toolsResponse.status || 500,
        data: {
          action: 'local-mcp',
          answer:
            toolsResponse.parsed?.error?.message ||
            toolsResponse.raw ||
            '로컬 MCP 도구 목록 조회 실패',
        },
      };
    }

    toolList = toolsResponse.parsed.result.tools;
    tools = toolList;
    emitEvent('progress', {
      step: 'tools_list',
      status: toolsResponse.status,
      toolCount: toolList.length,
      mergedFromManifest: false,
    });
  }

  const toolPlan =
    preplannedToolPlan || (useLLMPlanner ? await planMCPToolCall(prompt, tools) : null);
  emitEvent('plan', {
    step: 'tool_plan',
    hasPlan: !!toolPlan,
    tool: toolPlan?.tool || null,
    routedQuery: toolPlan?.routedQuery,
    explanation: toolPlan?.explanation,
  });
  console.log('[local-mcp tool-plan]', {
    useLLMPlanner,
    hasPlan: !!toolPlan,
    tool: toolPlan?.tool || null,
    discoveryTool: toolPlan?.discovery?.tool || null,
    routedQuery: toolPlan?.routedQuery,
  });
  const routedQuery = toolPlan?.routedQuery || prompt;
  const callTool = async (toolName, toolArguments, requestType = 'primary') => {
    const callPayload = {
      jsonrpc: '2.0',
      id: `${requestId}-${requestType}`,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArguments,
      },
    };

    const result = await postToMCP(callPayload);
    return result;
  };
  const selectedTool = toolPlan?.tool
    ? tools.find((tool) => tool?.name === toolPlan.tool)
    : chooseBestTool(tools, prompt);

  if (!selectedTool) {
    console.log('[local-mcp tool-plan] no selected tool');
    emitEvent('error', {
      step: 'tool_not_found',
      message: '로컬 MCP에서 사용 가능한 도구가 없어 호출할 수 없습니다.',
    });
    return {
      status: 500,
      data: {
        action: 'local-mcp',
        answer: '로컬 MCP에서 사용 가능한 도구가 없어 호출할 수 없습니다.',
      },
    };
  }

  const plannedArgs = toolPlan?.toolArguments
    ? toolPlan.toolArguments
    : buildToolArguments(selectedTool, routedQuery);
  let args = sanitizeToolArguments(selectedTool, routedQuery, plannedArgs, toolPlan?.routedQuery);
  emitEvent('progress', {
    step: 'arguments_ready',
    tool: selectedTool?.name,
    args,
  });
  const planTrace = {
    manifestStatus: manifestAttempt.status,
    manifestSource: manifestAttempt.source,
    manifestUsed: manifestTools.length > 0,
    manifestError: manifestAttempt.error || null,
    toolsFromFallback: fallbackUsed,
    toolListCount: toolList.length,
    toolUsed: selectedTool?.name || null,
    toolArguments: args,
    discovery: {
      requested: toolPlan?.discovery || null,
      attempts: [],
      resolvedPaths: [],
    },
  };

  console.log('[local-mcp plan]', JSON.stringify(planTrace));

  const selectedRequired = Array.isArray(selectedTool?.inputSchema?.required)
    ? selectedTool.inputSchema.required
    : [];
  const needsPath = selectedRequired.includes('paths');
  const hasPathArg = Array.isArray(args.paths) && args.paths.length > 0;
  const hasOnlyDirectoryHint = hasPathArg && args.paths.length === 1 && args.paths[0] === '.';

  if (needsPath && (!hasPathArg || hasOnlyDirectoryHint)) {
    emitEvent('progress', {
      step: 'path_required',
      tool: selectedTool?.name,
      currentPaths: args.paths || [],
    });
    const discoveryPlan = toolPlan?.discovery || {};
    const discoveryToolName = typeof discoveryPlan.tool === 'string' ? discoveryPlan.tool : '';
    const discoveryTool =
      pickDiscoveryTool(tools, discoveryToolName) ||
      pickFallbackDiscoveryTool(tools, selectedTool?.name);
    const expectedPaths = normalizeDiscoveryExpectedPaths(discoveryPlan.expected_paths);
    const resolvedCandidatePaths = new Set(expectedPaths.filter(Boolean));

    if (resolvedCandidatePaths.size === 0 && discoveryTool) {
      const {
        args: discoveryArgs,
        result: discoveryResult,
        paths: discoveryPaths,
      } = await discoverPathsWithTool({
        discoveryTool,
        routedQuery,
        discoveryPlan,
        callTool,
        requestType: 'discovery',
        requiredPathsFallback: [],
      });
      emitEvent('progress', {
        step: 'discovery_call',
        tool: discoveryTool?.name,
        status: discoveryResult.status,
      });
      planTrace.discovery.attempts.push({
        tool: discoveryTool.name,
        args: discoveryArgs,
        status: discoveryResult.status,
        discoveryPaths,
      });

      if (discoveryResult.status >= 400 || discoveryResult.parsed?.error) {
        planTrace.discovery.error =
          discoveryResult.parsed?.error?.message || discoveryResult.raw || null;
      } else {
        for (const path of discoveryPaths) {
          resolvedCandidatePaths.add(path);
        }
      }
    } else {
      planTrace.discovery.attempts.push({
        skipped: true,
        reason: resolvedCandidatePaths.size > 0 ? 'seeded_from_plan' : 'no_discovery_tool_or_plan',
      });
    }

    const discoveredPathList = Array.from(resolvedCandidatePaths);
    planTrace.discovery.resolvedPaths = discoveredPathList;
    emitEvent('progress', {
      step: 'discovery_resolved',
      paths: discoveredPathList,
    });

    if (discoveredPathList.length > 0) {
      args.paths = discoveredPathList;
      if (args.paths.length === 1 && args.paths[0] === '.') {
        args.paths = [];
      }
    } else {
      const defaultPaths = getDefaultPaths();
      args.paths = defaultPaths;
      emitEvent('progress', {
        step: 'paths_defaulted',
        tool: selectedTool?.name,
        paths: defaultPaths,
      });
    }

    console.log('[local-mcp plan discovery]', JSON.stringify(planTrace.discovery));
  }

  if (needsPath && args.paths.length === 0) {
    emitEvent('error', {
      step: 'paths_missing',
      tool: selectedTool?.name,
    });
    return {
      status: 200,
      data: {
        action: 'local-mcp',
        answer:
          '요약 도구는 요약할 파일 경로가 필요합니다. 경로를 지정해 주세요. 예: notes/today.md 또는 /absolute/path/file.md',
        tool: selectedTool?.name,
        requiresInput: true,
        missing: 'paths',
        routedQuery,
        explanation: toolPlan?.explanation,
        arguments: args,
        planTrace,
      },
    };
  }

  let callResult = await callTool(selectedTool?.name, args, 'primary');
  emitEvent('progress', {
    step: 'tool_call',
    tool: selectedTool?.name,
    status: callResult.status,
  });
  if (callResult.status >= 400 || callResult.parsed?.error) {
    emitEvent('error', {
      step: 'tool_call_failed',
      tool: selectedTool?.name,
      status: callResult.status,
      error: callResult.parsed?.error || callResult.raw,
    });
    return {
      status: callResult.status,
      data: {
        action: 'local-mcp',
        answer: callResult.parsed?.error?.message || callResult.raw || '로컬 MCP 도구 호출 실패',
        tool: selectedTool?.name,
        routedQuery,
        explanation: toolPlan?.explanation,
        arguments: args,
        planTrace,
      },
    };
  }

  let structured = callResult.parsed?.result?.structuredContent;
  let contentArray = Array.isArray(callResult.parsed?.result?.content)
    ? callResult.parsed.result.content
    : null;

  // search 계열 도구에서 hits가 비어 있으면, list_docs로 .md/.txt 경로를 수집해 1회 재검색한다.
  if (isSearchLikeTool(selectedTool?.name) && Array.isArray(structured?.hits) && structured.hits.length === 0) {
    const searchDiscoveryTool =
      findToolByName(tools, 'list_docs') || pickDiscoveryTool(tools, toolPlan?.discovery?.tool);
    if (searchDiscoveryTool) {
      const {
        args: searchDiscoveryArgs,
        result: searchDiscoveryResult,
        paths: searchDiscoveryPaths,
      } = await discoverPathsWithTool({
        discoveryTool: searchDiscoveryTool,
        routedQuery,
        discoveryPlan: {
          tool_arguments: {
            paths: getRetryPathCandidates(),
            extensions: ['.md', '.txt'],
          },
          expected_paths: getRetryPathCandidates(),
        },
        callTool,
        requestType: 'search-discovery',
      });

      emitEvent('progress', {
        step: 'search_discovery',
        tool: searchDiscoveryTool?.name,
        status: searchDiscoveryResult.status,
      });

      planTrace.searchDiscovery = {
        tool: searchDiscoveryTool?.name || null,
        args: searchDiscoveryArgs,
        status: searchDiscoveryResult.status,
        paths: searchDiscoveryPaths,
      };

      if (searchDiscoveryPaths.length > 0) {
        const retrySearchArgs = sanitizeToolArguments(
          selectedTool,
          routedQuery,
          {
            ...args,
            paths: searchDiscoveryPaths,
          },
          toolPlan?.routedQuery,
        );

        const retrySearchResult = await callTool(selectedTool?.name, retrySearchArgs, 'search-retry');
        emitEvent('progress', {
          step: 'search_retry',
          tool: selectedTool?.name,
          status: retrySearchResult.status,
        });

        if (retrySearchResult.status < 400 && !retrySearchResult.parsed?.error) {
          args = retrySearchArgs;
          callResult = retrySearchResult;
          structured = callResult.parsed?.result?.structuredContent;
          contentArray = Array.isArray(callResult.parsed?.result?.content)
            ? callResult.parsed.result.content
            : null;
          planTrace.searchDiscovery.retried = true;
        }
      }
    }
  }

  const createResponseFromCallResult = (resultPayload) => {
    const structuredPayload = resultPayload?.parsed?.result?.structuredContent;
    const contentArrayPayload = Array.isArray(resultPayload?.parsed?.result?.content)
      ? resultPayload.parsed.result.content
      : null;

    if (structuredPayload && Object.keys(structuredPayload).length > 0) {
      const structuredAnswer = summarizeStructuredForDisplay(structuredPayload, selectedTool?.name);
      if (structuredAnswer) {
        return {
          status: 200,
          data: {
            ...normalizeMCPResponse({
              action: 'local-mcp',
              answer: structuredAnswer,
            }),
            result: structuredPayload,
            tool: selectedTool?.name,
            routedQuery,
            explanation: toolPlan?.explanation,
            arguments: args,
            planTrace,
          },
        };
      }

      return {
        status: 200,
        data: {
          ...normalizeMCPResponse({
            action: 'local-mcp',
            answer: JSON.stringify(structuredPayload, null, 2),
          }),
          result: structuredPayload,
          tool: selectedTool?.name,
          routedQuery,
          explanation: toolPlan?.explanation,
          arguments: args,
          planTrace,
        },
      };
    }

    if (contentArrayPayload && contentArrayPayload.length > 0) {
      const answer =
        formatContentArrayAsMarkdown(contentArrayPayload) ||
        contentArrayPayload
          .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n')
          .trim();
      return {
        status: 200,
        data: {
          ...normalizeMCPResponse({
            action: 'local-mcp',
            answer: answer || JSON.stringify(resultPayload, null, 2),
          }),
          result: contentArrayPayload || structuredPayload || resultPayload,
          tool: selectedTool?.name,
          routedQuery,
          explanation: toolPlan?.explanation,
          arguments: args,
          planTrace,
        },
      };
    }

    return {
      status: 200,
      data: {
        ...normalizeMCPResponse(resultPayload),
        result: structuredPayload || contentArrayPayload || resultPayload,
        tool: selectedTool?.name,
        routedQuery,
        explanation: toolPlan?.explanation,
        arguments: args,
        planTrace,
      },
    };
  };

  const shouldTrySummaryChain = hasSummaryIntent(routedQuery);
  const summaryTool = shouldTrySummaryChain ? findSummaryTool(tools) : null;
  if (summaryTool && selectedTool?.name !== summaryTool.name) {
    emitEvent('progress', {
      step: 'summary_chain_start',
      from: selectedTool?.name,
      to: summaryTool?.name,
    });
    let inferredPaths = collectPathsFromToolResult(callResult);
    const summaryNeedsPath = Array.isArray(summaryTool?.inputSchema?.required)
      ? summaryTool.inputSchema.required.includes('paths')
      : true;
    const summaryDiscoveryTool =
      pickDiscoveryTool(tools, toolPlan?.discovery?.tool) ||
      pickFallbackDiscoveryTool(tools, summaryTool?.name);

    if (inferredPaths.length === 0 && summaryNeedsPath && summaryDiscoveryTool) {
      const {
        args: discoveryArgs,
        result: summaryDiscoveryResult,
        paths: discoveredPaths,
      } = await discoverPathsWithTool({
        discoveryTool: summaryDiscoveryTool,
        routedQuery,
        discoveryPlan: {
          tool_arguments: { query: routedQuery },
        },
        callTool,
        requestType: 'summary-discovery',
      });
      emitEvent('progress', {
        step: 'summary_discovery',
        tool: summaryDiscoveryTool?.name,
        status: summaryDiscoveryResult.status,
      });

      planTrace.summary = {
        discovery: {
          tool: summaryDiscoveryTool.name,
          args: discoveryArgs,
          status: summaryDiscoveryResult.status,
          paths: discoveredPaths,
        },
      };

      if (summaryDiscoveryResult.status >= 400 || summaryDiscoveryResult.parsed?.error) {
        planTrace.summary.error =
          summaryDiscoveryResult.parsed?.error?.message ||
          summaryDiscoveryResult.raw ||
          '요약용 탐색 tool 호출 실패';
      } else {
        inferredPaths = discoveredPaths;
      }
    }

    if (inferredPaths.length > 0) {
      const summaryArgs = sanitizeToolArguments(
        summaryTool,
        routedQuery,
        { paths: inferredPaths, output_path: 'output.md' },
        routedQuery,
      );
      const summaryResult = await callTool(summaryTool.name, summaryArgs, 'summary-chain');
      emitEvent('progress', {
        step: 'summary_chain_call',
        tool: summaryTool?.name,
        status: summaryResult.status,
      });

      planTrace.summary = {
        requested: {
          from: selectedTool?.name,
          paths: inferredPaths,
          args: summaryArgs,
        },
        status: summaryResult.status,
        tool: summaryTool?.name || null,
      };

      if (!summaryResult || summaryResult.status >= 400 || summaryResult.parsed?.error) {
        planTrace.summary.error =
          summaryResult?.parsed?.error?.message || summaryResult?.raw || '요약 tool 호출 실패';
      } else {
        const chained = createResponseFromCallResult(summaryResult);
        chained.data.tool = summaryTool.name;
        chained.data.arguments = summaryArgs;
        chained.data.planTrace = planTrace;
        return chained;
      }
    } else {
      planTrace.summary = {
        requested: {
          from: selectedTool?.name,
          reason: inferredPaths.length === 0 ? 'no_paths_for_summary' : null,
        },
      };
    }
  }

  if (structured && Object.keys(structured).length > 0) {
    return createResponseFromCallResult(callResult);
  }

  if (contentArray && contentArray.length > 0) {
    return createResponseFromCallResult(callResult);
  }

  return createResponseFromCallResult(callResult);
};

// 오케스트레이션 런타임은 분리 모듈에서 생성하고,
// index.js는 라우팅/입출력 경계만 담당한다.
const { A2A_PROTOCOL_VERSION, runOrchestration, runOutputAgentStream } = createOrchestrationRuntime({
  localMcpEndpoint: LOCAL_MCP_ENDPOINT,
  buildRouteDecisionPrompt,
  chatOnlyPrompt: CHAT_ONLY_PROMPT,
  callOpenAI,
  callLocalMCP,
  resolveConversation,
  proxyResponse,
  planExecutionFromManifest,
  shouldRetryForPathIssue,
  buildRetryExecutionPlan,
  evaluateGitHubPRReadiness,
  parseRoutePlan,
  streamText,
  writeSSE,
});

app.post('/api/mcp/chat/stream', async (req, res) => {
  // 스트리밍 엔드포인트: 오케스트레이션 결과를 SSE(delta/final/done)로 전송
  const { prompt, localEndpoint, conversation } = req.body || {};

  if (!OPENAI_API_KEY) {
    res.status(500).json({
      error: 'OPENAI_API_KEY가 환경변수에 설정되어 있지 않습니다.',
    });
    return;
  }

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({
      error: 'prompt는 필수 문자열입니다.',
    });
    return;
  }

  try {
    if (typeof localEndpoint === 'string' && localEndpoint.trim()) {
      new URL(localEndpoint.trim());
    }
  } catch {
    res.status(400).json({
      error: '유효하지 않은 로컬 MCP 엔드포인트입니다.',
    });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const emit = (event, payload = {}) => {
    if (res.writableEnded) {
      return;
    }
    writeSSE(res, event, payload);
  };

  try {
    const orchestration = await runOrchestration({
      prompt,
      localEndpoint,
      conversation,
      emit,
    });
    runOutputAgentStream({
      res,
      response: {
        ...orchestration.response,
        agentTrace: {
          protocol: A2A_PROTOCOL_VERSION,
          executionAgent: orchestration.executionAgent,
          requestId: orchestration.requestId,
          plan: orchestration.plan,
          executionPlan: orchestration.executionPlan,
          retried: orchestration.retried,
          workflow: orchestration.workflowState,
          manifest: {
            ok: orchestration.manifestContext?.ok === true,
            status:
              orchestration.manifestContext?.manifestAttempt?.status ||
              orchestration.manifestContext?.status ||
              0,
            source: orchestration.manifestContext?.manifestAttempt?.source || null,
          },
        },
      },
      requestId: orchestration.requestId,
      emit,
    });
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : '요청 처리 중 오류가 발생했습니다.';
    emit('error', { message });
    emit('done', { ok: false });
    res.end();
  }
});

app.post('/api/mcp/chat', async (req, res) => {
  // 비스트리밍 엔드포인트: 동일 오케스트레이션 경로를 JSON 응답으로 반환
  const { prompt, localEndpoint, conversation } = req.body || {};

  if (!OPENAI_API_KEY) {
    res.status(500).json({
      error: 'OPENAI_API_KEY가 환경변수에 설정되어 있지 않습니다.',
    });
    return;
  }

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({
      error: 'prompt는 필수 문자열입니다.',
    });
    return;
  }

  try {
    if (typeof localEndpoint === 'string' && localEndpoint.trim()) {
      new URL(localEndpoint.trim());
    }
  } catch {
    res.status(400).json({
      error: '유효하지 않은 로컬 MCP 엔드포인트입니다.',
    });
    return;
  }

  try {
    const orchestration = await runOrchestration({
      prompt,
      localEndpoint,
      conversation,
    });
    res.json({
      ...orchestration.response,
      agentTrace: {
        protocol: A2A_PROTOCOL_VERSION,
        executionAgent: orchestration.executionAgent,
        requestId: orchestration.requestId,
        plan: orchestration.plan,
        executionPlan: orchestration.executionPlan,
        retried: orchestration.retried,
        workflow: orchestration.workflowState,
        manifest: {
          ok: orchestration.manifestContext?.ok === true,
          status:
            orchestration.manifestContext?.manifestAttempt?.status ||
            orchestration.manifestContext?.status ||
            0,
          source: orchestration.manifestContext?.manifestAttempt?.source || null,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '요청 처리 중 오류가 발생했습니다.';
    res.status(500).json({
      action: 'local-mcp',
      answer: message,
    });
  }
});

app.post('/api/mcp/query', async (req, res) => {
  const { prompt } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({
      error: 'prompt는 필수 문자열입니다.',
    });
    return;
  }

  let targetUrl = resolveLocalMCPUrl(req.body);
  try {
    new URL(targetUrl);
  } catch {
    res.status(400).json({
      error: '유효하지 않은 로컬 MCP 엔드포인트입니다.',
    });
    return;
  }
  try {
    const localResult = await callLocalMCP({
      prompt,
      localEndpoint: targetUrl,
      conversation: req.body?.conversation,
    });

    res.json(proxyResponse(localResult));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : '로컬 MCP 통신 중 오류가 발생했습니다.';
    res.status(500).json({
      action: 'local-mcp',
      answer: message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`[local-mcp-bridge] listening on http://localhost:${PORT}`);
});
