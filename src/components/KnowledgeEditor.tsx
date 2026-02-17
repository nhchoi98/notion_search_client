import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppBar,
  Box,
  Button,
  Collapse,
  Container,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { MCPMode, KnowledgeMessage } from '../types/mcp';
import { streamKnowledge } from '../services/mcpClient';

interface KnowledgeEditorProps {
  mode: MCPMode;
  localEndpoint: string;
  onDisconnect: () => void;
}

export default function KnowledgeEditor({
  mode,
  localEndpoint,
  onDisconnect,
}: KnowledgeEditorProps) {
  const [input, setInput] = useState('오늘 배운 내용 중 중요한 항목을 찾아 요약해줘.');
  const [loading, setLoading] = useState(false);
  const [showSSELogs, setShowSSELogs] = useState(false);
  const [messages, setMessages] = useState<KnowledgeMessage[]>([
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '안녕하세요! 로컬 MCP에 연결되었습니다. 질문을 입력해주세요.',
      createdAt: new Date().toLocaleTimeString(),
    },
  ]);
  const endOfMessagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const title = useMemo(() => (mode === 'local' ? 'Local MCP Chat' : 'MCP Chat'), [mode]);
  const status = useMemo(() => `Endpoint: ${localEndpoint}`, [localEndpoint]);

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

  const renderMarkdown = (text: string) => {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          p: ({ children }) => (
            <Typography variant="body1" sx={{ mt: 1, lineHeight: 1.72, color: '#0f172a' }}>
              {children}
            </Typography>
          ),
          strong: ({ children }) => <Box component="strong">{children}</Box>,
          em: ({ children }) => <Box component="em">{children}</Box>,
          ul: ({ children }) => (
            <Box component="ul" sx={{ m: 0, mt: 1, pl: 3 }}>
              {children}
            </Box>
          ),
          ol: ({ children }) => (
            <Box component="ol" sx={{ m: 0, mt: 1, pl: 3 }}>
              {children}
            </Box>
          ),
          li: ({ children }) => (
            <Box component="li" sx={{ mt: 0.4, color: '#0f172a', lineHeight: 1.65 }}>
              {children}
            </Box>
          ),
          blockquote: ({ children }) => (
            <Box
              sx={{
                mt: 1,
                px: 1.5,
                py: 0.75,
                borderLeft: '3px solid #d1d5db',
                bgcolor: '#f9fafb',
                borderRadius: 1,
                color: '#374151',
              }}
            >
              {children}
            </Box>
          ),
          h1: ({ children }) => (
            <Typography variant="h6" sx={{ mt: 1.6, mb: 0.6, fontWeight: 700, color: '#0f172a' }}>
              {children}
            </Typography>
          ),
          h2: ({ children }) => (
            <Typography variant="subtitle1" sx={{ mt: 1.5, mb: 0.5, fontWeight: 700, color: '#0f172a' }}>
              {children}
            </Typography>
          ),
          h3: ({ children }) => (
            <Typography variant="subtitle2" sx={{ mt: 1.3, mb: 0.4, fontWeight: 700, color: '#0f172a' }}>
              {children}
            </Typography>
          ),
          hr: () => <Divider sx={{ my: 1.5 }} />,
          code: ({ className, children }) => {
            const isBlock = className?.includes('language-') || String(children).includes('\n');
            if (!isBlock) {
              return (
                <Box
                  component="code"
                  sx={{
                    px: 0.6,
                    py: 0.1,
                    borderRadius: 1,
                    bgcolor: '#f3f4f6',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: '0.87em',
                  }}
                >
                  {children}
                </Box>
              );
            }

            const langLabel = (className || '').replace('hljs', '').match(/language-([\w-]+)/)?.[1] || '';
            return (
              <Box
                sx={{
                  mt: 1,
                  mb: 1,
                  borderRadius: 2,
                  border: '1px solid #e5e7eb',
                  bgcolor: '#0d1117',
                  color: '#f9fafb',
                  overflowX: 'auto',
                }}
              >
                {langLabel ? (
                  <Typography
                    variant="caption"
                    sx={{ display: 'block', px: 1.25, pt: 0.75, color: '#9ca3af' }}
                  >
                    {langLabel}
                  </Typography>
                ) : null}
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    p: 1.25,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 13,
                    lineHeight: 1.5,
                    whiteSpace: 'pre',
                  }}
                >
                  <Box component="code" className={className}>
                    {children}
                  </Box>
                </Box>
              </Box>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    );
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
        conversation: nextMessages.filter(
          (message) => message.role === 'user' || message.role === 'assistant',
        ),
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
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantMessage.id
                ? {
                    ...message,
                    isStreaming: false,
                    text: response.answer,
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
      const message =
        error instanceof Error ? error.message : '로컬 MCP 질의 중 오류가 발생했습니다.';
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

  useEffect(() => {
    if (!loading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [loading]);

  return (
    <Box sx={{ minHeight: '100vh', background: '#ffffff', width: '100%' }}>
      <AppBar
        position="sticky"
        color="transparent"
        elevation={0}
        sx={{ borderBottom: '1px solid #e5e7eb', backdropFilter: 'blur(6px)' }}
      >
        <Container
          maxWidth="md"
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 1.25 }}
        >
          <Typography variant="body1" fontWeight={700} sx={{ color: '#111827' }}>
            {title}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              color="inherit"
              variant="text"
              onClick={() => setShowSSELogs((prev) => !prev)}
            >
              {showSSELogs ? 'SSE 로그 숨기기' : 'SSE 로그 보기'}
            </Button>
            <Button size="small" color="inherit" variant="text" onClick={onDisconnect}>
              연결 해제
            </Button>
          </Stack>
        </Container>
      </AppBar>

      <Container
        maxWidth="md"
        sx={{
          pt: 0,
          pb: 0,
          display: 'flex',
          flexDirection: 'column',
          height: 'calc(100vh - 65px)',
        }}
      >
        <Paper
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 0,
            overflow: 'hidden',
            boxShadow: 'none',
            backgroundColor: '#fff',
          }}
          elevation={0}
        >
          <Box
            sx={{
              px: { xs: 2, md: 4 },
              py: 1,
              borderBottom: '1px solid #f3f4f6',
              background: '#fafafa',
            }}
          >
            <Typography variant="caption" sx={{ color: '#6b7280' }}>
              {status}
            </Typography>
          </Box>

          <Box
            sx={{
              flex: 1,
              overflowY: 'auto',
              px: { xs: 2, md: 4 },
              py: 3,
              display: 'flex',
              flexDirection: 'column',
              gap: 2.5,
              background: '#ffffff',
            }}
          >
            {messages.map((message) => {
              const isUser = message.role === 'user';
              return (
                <Box
                  key={message.id}
                  sx={{
                    alignSelf: isUser ? 'flex-end' : 'flex-start',
                    width: '100%',
                    display: 'flex',
                    justifyContent: isUser ? 'flex-end' : 'flex-start',
                  }}
                >
                  <Box
                    sx={{
                      px: 2.2,
                      py: 1.5,
                      borderRadius: 6,
                      maxWidth: { xs: '92%', md: '82%' },
                      background: isUser ? '#f4f4f5' : '#ffffff',
                      border: isUser ? '1px solid #ececf1' : '1px solid #e5e7eb',
                      boxShadow: isUser ? 'none' : '0 2px 8px rgba(0,0,0,0.04)',
                    }}
                  >
                    {renderMarkdown(message.text)}
                    {message.isStreaming ? (
                      <Typography
                        variant="caption"
                        sx={{ mt: 1, display: 'block', color: '#6b7280' }}
                      >
                        응답 생성 중...
                      </Typography>
                    ) : null}
                    <Collapse
                      in={
                        showSSELogs &&
                        Array.isArray(message.thoughts) &&
                        message.thoughts.length > 0
                      }
                    >
                      <Box
                        sx={{
                          mt: 1.25,
                          p: 1.25,
                          borderRadius: 2,
                          border: '1px solid #e5e7eb',
                          background: '#fafafa',
                        }}
                      >
                        <Typography variant="caption" sx={{ color: '#4b5563', fontWeight: 700 }}>
                          SSE 로그
                        </Typography>
                        <Typography
                          variant="caption"
                          sx={{
                            mt: 0.75,
                            whiteSpace: 'pre-wrap',
                            display: 'block',
                            color: '#6b7280',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            lineHeight: 1.5,
                          }}
                        >
                          {(message.thoughts || []).join('\n')}
                        </Typography>
                      </Box>
                    </Collapse>
                  </Box>
                </Box>
              );
            })}
            <div ref={endOfMessagesRef} />
          </Box>

          <Divider sx={{ borderColor: '#e5e7eb' }} />
          <Box sx={{ px: { xs: 2, md: 4 }, py: 2, backgroundColor: '#fff' }}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleSubmit();
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  gap: 1,
                  alignItems: 'flex-end',
                  border: '1px solid #d1d5db',
                  borderRadius: 5,
                  p: 0.75,
                  background: '#ffffff',
                }}
              >
                <TextField
                  fullWidth
                  multiline
                  minRows={1}
                  maxRows={5}
                  inputRef={inputRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="메시지를 입력하세요"
                  variant="standard"
                  disabled={loading}
                  InputProps={{ disableUnderline: true }}
                />
                <Button
                  variant="contained"
                  type="submit"
                  disabled={loading || !input.trim()}
                  sx={{
                    minWidth: 44,
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    boxShadow: 'none',
                    background: '#111827',
                    '&:hover': { background: '#1f2937' },
                  }}
                >
                  <SendIcon />
                </Button>
              </Box>
            </form>
          </Box>
        </Paper>
      </Container>
    </Box>
  );
}
