import type { MCPMode } from '../types/mcp';

const STORAGE_KEY = 'notion-mcp-mode';

export function readStoredMode(): MCPMode | null {
  const value = window.localStorage.getItem(STORAGE_KEY);
  if (value === 'local' || value === 'notion') {
    return value;
  }
  return null;
}

export function writeStoredMode(mode: MCPMode): void {
  window.localStorage.setItem(STORAGE_KEY, mode);
}

export function clearStoredMode(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
