import { useState } from 'react';
import { Alert, Box, Stack, ThemeProvider, CssBaseline } from '@mui/material';
import McpSetup from './components/McpSetup';
import KnowledgeEditor from './components/KnowledgeEditor';
import type { MCPMode, LocalMCPConfig } from './types/mcp';
import { theme } from './theme';
import {
  clearStoredLocalMCPConfig,
  clearStoredMode,
  readStoredLocalMCPConfig,
  readStoredMode,
  writeStoredLocalMCPConfig,
  writeStoredMode,
} from './services/storage';

const defaultLocalConfig: LocalMCPConfig = {
  endpoint: 'http://localhost:3001/mcp',
};

export default function App() {
  const [mode, setMode] = useState<MCPMode | null>(readStoredMode());
  const [localConfig, setLocalConfig] = useState<LocalMCPConfig>(
    readStoredLocalMCPConfig() || defaultLocalConfig,
  );

  const shouldShowSetup = !mode || !localConfig.endpoint;

  const handleSelectMode = (nextMode: MCPMode, localEndpoint: string) => {
    const nextConfig = { endpoint: localEndpoint };
    writeStoredMode(nextMode);
    writeStoredLocalMCPConfig(nextConfig);
    setMode(nextMode);
    setLocalConfig(nextConfig);
  };

  const handleDisconnect = () => {
    clearStoredMode();
    clearStoredLocalMCPConfig();
    setMode(null);
    setLocalConfig(defaultLocalConfig);
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 2,
        }}
      >
        <Stack width="100%" alignItems="center">
          {shouldShowSetup ? (
            <McpSetup onSelect={handleSelectMode} />
          ) : (
            <KnowledgeEditor
              mode={mode}
              localEndpoint={localConfig.endpoint}
              onDisconnect={handleDisconnect}
            />
          )}
        </Stack>
      </Box>
    </ThemeProvider>
  );
}
