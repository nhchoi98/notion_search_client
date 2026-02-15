import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppBar,
  Avatar,
  Box,
  Chip,
  Container,
  Divider,
  IconButton,
  Paper,
  List,
  ListItem,
  TextField,
  Typography,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import LogoutIcon from '@mui/icons-material/Logout';
import type { MCPMode, KnowledgeMessage } from '../types/mcp';
import { streamKnowledge } from '../services/mcpClient';

interface KnowledgeEditorProps {
  mode: MCPMode;
  localEndpoint: string;
  onDisconnect: () => void;
}

export default function KnowledgeEditor({ mode, localEndpoint, onDisconnect }: KnowledgeEditorProps) {
  const [input, setInput] = useState('오늘 배운 내용 중 중요한 항목을 찾아 요약해줘.');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<KnowledgeMessage[]>([
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '안녕하세요! 로컬 MCP에 연결되었습니다. 질문을 입력해주세요.',
      createdAt: new Date().toLocaleTimeString(),
    },
  ]);
  const endOfMessagesRef = useRef<HTMLDivElement>(null);

  const title = useMemo(() => (mode === 'local' ? '로컬 MCP로 지식 탐색' : 'MCP 연결'), [mode]);
  const status = useMemo(() => `로컬 MCP 엔드포인트: ${localEndpoint}`, [localEndpoint]);

  const appendThought = (messageId: string, thought: string) => {
    setMessages((prev) =>
      prev.map((message) => {
        if (message.id !== messageId) {
          return message;
        }

        const currentThoughts = Array.isArray(message.thoughts) ? message.thoughts : [];
        return {
          ...message,
          thoughts: [...currentThoughts, thought],
        };
      }),
    );
  };

  const makeThinkingLine = (eventType: string, data: unknown) => {
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object') {
          return `${eventType}: ${JSON.stringify(parsed, null, 2)}`;
        }
      } catch {
        return `${eventType}: ${data}`;
      }
    }

    if (data && typeof data === 'object') {
      return `${eventType}: ${JSON.stringify(data, null, 2)}`;
    }

    return `${eventType}`;
  };

  const summarizeResult = (result: unknown) => {
    if (!result || typeof result !== 'object') {
      return '';
    }

    try {
      return `원문 result: ${JSON.stringify(result, null, 2)}`;
    } catch {
      return '';
    }
  };

  const renderMarkdown = (text: string) => {
    const rawLines = text.split('\n');
    const nodes = [];
    let listItems: string[] = [];
    let pendingBuffer: string[] = [];

    const flushParagraph = () => {
      if (pendingBuffer.length === 0) {
        return;
      }
      nodes.push(
        <Typography
          key={`p-${nodes.length}`}
          variant="body2"
          sx={{ whiteSpace: 'pre-wrap', display: 'block', mt: 1 }}
        >
          {pendingBuffer.join('\n')}
        </Typography>,
      );
      pendingBuffer = [];
    };

    const flushList = () => {
      if (listItems.length === 0) {
        return;
      }

      nodes.push(
        <List key={`ul-${nodes.length}`} dense sx={{ pl: 2, mt: 0.5 }}>
          {listItems.map((item, index) => (
            <ListItem disableGutters key={`li-${nodes.length}-${index}`} sx={{ display: 'list-item', pl: 0.5 }}>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                {item}
              </Typography>
            </ListItem>
          ))}
        </List>,
      );
      listItems = [];
    };

    rawLines.forEach((line) => {
      const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
      if (headingMatch) {
        flushParagraph();
        flushList();
        const level = headingMatch[1].length;
        const content = headingMatch[2];
        nodes.push(
          <Typography
            key={`h-${nodes.length}`}
            variant={level >= 3 ? 'subtitle2' : 'subtitle1'}
            fontWeight={700}
            sx={{ mt: 1.5, mb: 0.5 }}
          >
            {content}
          </Typography>,
        );
        return;
      }

      const listMatch = /^-\s+(.*)$/.exec(line);
      if (listMatch) {
        flushParagraph();
        listItems.push(listMatch[1]);
        return;
      }

      if (line.trim() === '') {
        flushParagraph();
        flushList();
        return;
      }

      pendingBuffer.push(line);
    });

    flushParagraph();
    flushList();

    return nodes.length > 0 ? nodes : <Typography variant="body2">{text}</Typography>;
  };

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

    const assistantMessage: KnowledgeMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '',
      createdAt: new Date().toLocaleTimeString(),
      isStreaming: true,
      thoughts: [],
    };

    const nextMessages = [...messages, nextUser, assistantMessage];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      await streamKnowledge(mode, trimmed, {
        localEndpoint,
        conversation: nextMessages.filter((message) => message.role === 'user' || message.role === 'assistant'),
        onProgress: ({ type, data }) => {
          appendThought(assistantMessage.id, makeThinkingLine(type, data));
        },
        onDelta: (chunk) => {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantMessage.id
                ? {
                    ...message,
                    text: `${message.text}${chunk}`,
                  }
                : message,
            ),
          );
        },
        onFinal: (response) => {
          const action = response.action || 'local-mcp';
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantMessage.id
                ? {
                    ...message,
                    isStreaming: false,
                    text: `${response.answer}\n\n실행 액션: ${action}`,
                    detail: [
                      response.route && `라우팅: ${response.route}`,
                      response.routedQuery ? `전달 쿼리: ${response.routedQuery}` : null,
                      response.explanation && `판단: ${response.explanation}`,
                      response.requiresInput ? `요청 보완 필요: ${response.missing || '추가 정보'}` : null,
                      response.tool ? `도구: ${response.tool}` : null,
                      response.arguments ? `인자: ${JSON.stringify(response.arguments, null, 2)}` : null,
                      response.result ? summarizeResult(response.result) : null,
                    ]
                        .filter(Boolean)
                        .join('\n\n'),
                  }
                : message,
            ),
          );
        },
        onError: (message) => {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessage.id
                ? {
                    ...msg,
                    isStreaming: false,
                    text: `오류: ${message}`,
                  }
                : msg,
            ),
          );
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '로컬 MCP 질의 중 오류가 발생했습니다.';
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessage.id
            ? {
                ...msg,
                isStreaming: false,
                text: `오류: ${message}`,
              }
            : msg,
        ),
      );
      appendThought(assistantMessage.id, `오류: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    await submit();
  };

  const handleKeyDown = async (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      await handleSubmit();
    }
  };

  useEffect(() => {
    if (endOfMessagesRef.current) {
      endOfMessagesRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading]);

  return (
    <Box sx={{ minHeight: '100vh', background: 'linear-gradient(145deg, #eef2ff 0%, #f8fafc 70%)', width: '100%' }}>
      <AppBar position="sticky" color="default" elevation={0}>
        <Container maxWidth="md" sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
          <Typography variant="h6" color="primary" fontWeight={700} sx={{ flexGrow: 1 }}>
            MCP Knowledge Hub
          </Typography>
          <Chip size="small" label={status} />
          <IconButton color="primary" onClick={onDisconnect} aria-label="disconnect">
            <LogoutIcon />
          </IconButton>
        </Container>
      </AppBar>

      <Container maxWidth="md" sx={{ pt: 3, pb: 3, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)' }}>
        <Paper
          sx={{
            p: 0,
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 4,
            overflow: 'hidden',
          }}
          elevation={4}
        >
          <Box sx={{ px: 3, py: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Typography variant="h6" fontWeight={700}>
              {title}
            </Typography>
          </Box>

          <Box
            sx={{
              flex: 1,
              overflowY: 'auto',
              px: 3,
              py: 2,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              background:
                'radial-gradient(circle at top right, rgba(11, 92, 255, 0.06), transparent 35%), radial-gradient(circle at 20% 90%, rgba(15, 118, 110, 0.04), transparent 40%)',
            }}
          >
            {messages.map((message) => {
              const isUser = message.role === 'user';
              return (
                <Box
                  key={message.id}
                  sx={{
                    alignSelf: isUser ? 'flex-end' : 'flex-start',
                    maxWidth: '85%',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 1,
                    flexDirection: isUser ? 'row-reverse' : 'row',
                  }}
                >
                  <Avatar sx={{ bgcolor: isUser ? 'primary.main' : 'success.main', width: 28, height: 28 }}>
                    {isUser ? '나' : 'M'}
                  </Avatar>
                  <Paper
                    sx={{
                      px: 2,
                      py: 1.25,
                      borderRadius: 3,
                      background: isUser ? 'primary.light' : 'background.paper',
                      border: isUser ? 'none' : '1px solid rgba(15,23,42,0.06)',
                      color: isUser ? 'primary.contrastText' : 'text.primary',
                    }}
                  >
                    <Typography variant="caption" color={isUser ? 'primary.contrastText' : 'text.secondary'}>
                      {message.role === 'user' ? '나' : '어시스턴트'} · {message.createdAt}
                    </Typography>
                    {renderMarkdown(message.text)}
                    {message.detail ? (
                      <Typography
                        variant="caption"
                        color={isUser ? 'primary.contrastText' : 'text.secondary'}
                        sx={{ mt: 1, whiteSpace: 'pre-wrap', display: 'block' }}
                      >
                        {message.detail}
                      </Typography>
                    ) : null}
                    {Array.isArray(message.thoughts) && message.thoughts.length > 0 ? (
                      <details>
                        <summary style={{ cursor: 'pointer', marginTop: 8, userSelect: 'none' }}>사고 로그 보기</summary>
                        <Typography
                          variant="caption"
                          color={isUser ? 'primary.contrastText' : 'text.secondary'}
                          sx={{ mt: 1, whiteSpace: 'pre-wrap', display: 'block' }}
                        >
                          {message.thoughts.join('\n')}
                        </Typography>
                      </details>
                    ) : null}
                    {message.isStreaming ? (
                      <Typography
                        variant="caption"
                        color={isUser ? 'primary.contrastText' : 'text.secondary'}
                        sx={{ mt: 1, display: 'block' }}
                      >
                        응답 생성 중...
                      </Typography>
                    ) : null}
                  </Paper>
                </Box>
              );
            })}
            <div ref={endOfMessagesRef} />
          </Box>

          <Divider />

          <Box sx={{ p: 2, backgroundColor: 'background.paper' }}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleSubmit();
              }}
            >
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
                <TextField
                  fullWidth
                  multiline
                  minRows={1}
                  maxRows={5}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="지식 검색 또는 정리 요청을 입력하세요."
                  variant="outlined"
                  disabled={loading}
                />
                <IconButton
                  color="primary"
                  type="submit"
                  size="large"
                  disabled={loading || !input.trim()}
                  sx={{ minWidth: 48, height: 48 }}
                >
                  <SendIcon />
                </IconButton>
              </Box>
            </form>
          </Box>
        </Paper>
      </Container>
    </Box>
  );
}
