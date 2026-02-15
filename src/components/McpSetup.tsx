import { useMemo, useState } from 'react';
import { FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Button, Card, CardContent, Stack, Typography, Chip } from '@mui/material';
import type { MCPMode } from '../types/mcp';

interface MCPSetupProps {
  onSelect: (mode: MCPMode) => void;
}

export default function MCPSetup({ onSelect }: MCPSetupProps) {
  const [mode, setMode] = useState<MCPMode>('local');

  const chipLabel = useMemo(() => {
    return mode === 'local'
      ? '현재 선택: LOCAL MCP(기본)'
      : '현재 선택: NOTION MCP';
  }, [mode]);

  return (
    <Card elevation={3} sx={{ width: 560, maxWidth: '95vw' }}>
      <CardContent>
        <Stack spacing={3}>
          <Typography variant="h5" fontWeight={800}>
            Notion MCP 연결 설정
          </Typography>
          <Typography color="text.secondary">
            첫 실행 시, 사용할 MCP 서버 타입을 선택하세요. 선택 정보는 브라우저 localStorage에 저장되어 다음 실행에도 유지됩니다.
          </Typography>

          <Chip label={chipLabel} color="primary" />

          <FormControl>
            <FormLabel>연결 방식</FormLabel>
            <RadioGroup
              row
              value={mode}
              onChange={(event) => setMode(event.target.value as MCPMode)}
            >
              <FormControlLabel value="local" control={<Radio />} label="Local MCP" />
              <FormControlLabel value="notion" control={<Radio />} label="Notion MCP" />
            </RadioGroup>
          </FormControl>

          <Button variant="contained" onClick={() => onSelect(mode)} size="large">
            연결 시작하기
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
