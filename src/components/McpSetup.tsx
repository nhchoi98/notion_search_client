import { useState } from 'react';
import { Button, Card, CardContent, Stack, TextField, Typography, Alert } from '@mui/material';
import type { MCPMode } from '../types/mcp';

interface MCPSetupProps {
  onSelect: (mode: MCPMode, localEndpoint: string) => void;
}

const DEFAULT_ENDPOINT = 'http://localhost:3001/mcp';

export default function MCPSetup({ onSelect }: MCPSetupProps) {
  const [localEndpoint, setLocalEndpoint] = useState(DEFAULT_ENDPOINT);
  const [error, setError] = useState('');

  const handleConnectLocalMCP = () => {
    setError('');
    if (!localEndpoint.trim()) {
      setError('로컬 MCP 엔드포인트를 입력해주세요.');
      return;
    }

    try {
      new URL(localEndpoint);
    } catch {
      setError('올바른 URL 형식이 아닙니다. 예: http://localhost:3001/mcp');
      return;
    }

    onSelect('local', localEndpoint.trim());
  };

  return (
    <Card elevation={3} sx={{ width: 560, maxWidth: '95vw' }}>
      <CardContent>
        <Stack spacing={3}>
          <Typography variant="h5" fontWeight={800}>
            Local MCP 연결 설정
          </Typography>
          <Typography color="text.secondary">
            로컬 MCP 엔드포인트를 등록해두면, 이후 채팅창에서 지식 질의가 해당 MCP로 전달됩니다.
          </Typography>

          <TextField
            label="Local MCP 엔드포인트"
            fullWidth
            value={localEndpoint}
            onChange={(event) => setLocalEndpoint(event.target.value)}
          />

          <Button variant="contained" size="large" onClick={handleConnectLocalMCP}>
            연결 시작하기
          </Button>

          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </CardContent>
    </Card>
  );
}
