import { useState } from 'react';
import { ThemeProvider, CssBaseline, Box, Stack } from '@mui/material';
import MCPSetup from './components/McpSetup';
import KnowledgeEditor from './components/KnowledgeEditor';
import type { MCPMode } from './types/mcp';
import { theme } from './theme';
import { readStoredMode, writeStoredMode, clearStoredMode } from './services/storage';

export default function App() {
  const [mode, setMode] = useState<MCPMode | null>(readStoredMode());

  const handleSelectMode = (nextMode: MCPMode) => {
    writeStoredMode(nextMode);
    setMode(nextMode);
  };

  const handleDisconnect = () => {
    clearStoredMode();
    setMode(null);
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
          {!mode ? (
            <MCPSetup onSelect={handleSelectMode} />
          ) : (
            <KnowledgeEditor mode={mode} onDisconnect={handleDisconnect} />
          )}
        </Stack>
      </Box>
    </ThemeProvider>
  );
}
