import type { MCPMode, LocalMCPConfig } from '../types/mcp';

const MODE_STORAGE_KEY = 'local-mcp-mode';
const LOCAL_MCP_CONFIG_KEY = 'local-mcp-endpoint';

export function readStoredMode(): MCPMode | null {
  const value = window.localStorage.getItem(MODE_STORAGE_KEY);
  return value === 'local' ? 'local' : null;
}

export function writeStoredMode(mode: MCPMode): void {
  window.localStorage.setItem(MODE_STORAGE_KEY, mode);
}

export function clearStoredMode(): void {
  window.localStorage.removeItem(MODE_STORAGE_KEY);
}

export function readStoredLocalMCPConfig(): LocalMCPConfig | null {
  const value = window.localStorage.getItem(LOCAL_MCP_CONFIG_KEY);
  if (!value) {
    return null;
  }

  return { endpoint: value };
}

export function writeStoredLocalMCPConfig(config: LocalMCPConfig): void {
  window.localStorage.setItem(LOCAL_MCP_CONFIG_KEY, config.endpoint);
}

export function clearStoredLocalMCPConfig(): void {
  window.localStorage.removeItem(LOCAL_MCP_CONFIG_KEY);
}
