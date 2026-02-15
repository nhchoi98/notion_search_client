import { useMemo, useState } from 'react';
import {
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Box,
  Container,
  Stack,
  Paper,
  TextField,
  Button,
  Chip,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import type { MCPMode, KnowledgeMessage } from '../types/mcp';
import { queryKnowledge } from '../services/mcpClient';

interface KnowledgeEditorProps {
  mode: MCPMode;
  onDisconnect: () => void;
}

export default function KnowledgeEditor({ mode, onDisconnect }: KnowledgeEditorProps) {
  const [input, setInput] = useState('오늘 배운 내용 중 중요한 항목을 찾아 요약해줘.');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<KnowledgeMessage[]>([]);

  const title = useMemo(
    () => (mode === 'local' ? '로컬 MCP로 지식 탐색' : 'Notion MCP로 지식 탐색'),
    [mode],
  );

  const status = useMemo(
    () =>
      mode === 'local'
        ? '로컬 MCP 연결 활성'
        : 'Notion MCP 토큰 기반 연결 활성',
    [mode],
  );

  const submit = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) {
      return;
    }

    const nextUser: KnowledgeMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: trimmed,
      createdAt: new Date().toLocaleTimeString(),
    };

    setMessages((prev) => [...prev, nextUser]);
    setInput('');
    setLoading(true);

    try {
      const response = await queryKnowledge(mode, trimmed);
      const nextAssistant: KnowledgeMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `${response.answer}\n\n실행 액션: ${response.action}`,
        createdAt: new Date().toLocaleTimeString(),
      };
      setMessages((prev) => [...prev, nextAssistant]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', background: 'linear-gradient(145deg, #eef2ff 0%, #f8fafc 70%)', pb: 4 }}>
      <AppBar position="static" color="default" elevation={0}>
        <Toolbar>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="h6" color="primary" fontWeight={700}>
              Notion MCP Knowledge Hub
            </Typography>
            <Chip size="small" label={status} />
          </Stack>
          <Box sx={{ flexGrow: 1 }} />
          <IconButton color="primary" onClick={onDisconnect} aria-label="disconnect">
            <LogoutIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ mt: 4 }}>
        <Paper sx={{ p: 3 }} elevation={4}>
          <Typography variant="h4" gutterBottom>
            {title}
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            아래 에디터에 지식 검색/수정 요청을 입력하세요. 모델이 MCP 서버를 호출해 자연어를 내부 액션으로 바꾼 뒤 실행 로그를 제공합니다.
          </Typography>

          <Stack spacing={2}>
            <TextField
              label="질문 입력"
              fullWidth
              multiline
              minRows={6}
              maxRows={10}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="예: 최근 1주일간 회의 내용에서 프로젝트 관련 핵심만 추출해서 태그로 정리해줘"
              disabled={loading}
            />
            <Button variant="contained" onClick={submit} disabled={loading || !input.trim()}>
              {loading ? '요청 처리 중...' : 'GPT + MCP로 실행'}
            </Button>
          </Stack>
        </Paper>

        <Stack spacing={2} mt={3}>
          {messages.map((message) => (
            <Paper
              key={message.id}
              sx={{
                p: 2,
                borderLeft: message.role === 'user' ? '4px solid #0b5cff' : '4px solid #16a34a',
              }}
            >
              <Typography variant="caption" color="text.secondary">
                {message.role === 'user' ? 'USER' : 'ASSISTANT'} · {message.createdAt}
              </Typography>
              <Typography whiteSpace="pre-wrap">{message.text}</Typography>
            </Paper>
          ))}
        </Stack>
      </Container>
    </Box>
  );
}
