import type { MCPMode, KnowledgeResponse } from '../types/mcp';

const DEFAULT_LOCAL_MCP_PROMPT =
  '너는 로컬 MCP 지식 검색 도우미야. 사용자의 요청을 지식 검색/요약/편집 힌트 형태로 정리해줘.';

export const buildSystemPrompt = (mode: MCPMode) => {
  if (mode === 'local') {
    return DEFAULT_LOCAL_MCP_PROMPT;
  }

  return DEFAULT_LOCAL_MCP_PROMPT;
};

const ensureOk = async (response: Response, fallback: string) => {
  if (response.ok) {
    return;
  }
  const message = await response.text();
  throw new Error(`${fallback} (${response.status}): ${message || '엔드포인트 응답이 비정상입니다.'}`);
};

export interface QueryKnowledgeOptions {
  localEndpoint?: string;
  conversation?: Array<{ role: 'user' | 'assistant'; text: string }>;
  onProgress?: (event: { type: string; data: unknown }) => void;
  onDelta?: (chunk: string) => void;
  onFinal?: (response: KnowledgeResponse) => void;
  onError?: (message: string) => void;
}

export async function queryKnowledge(
  mode: MCPMode,
  userPrompt: string,
  options: QueryKnowledgeOptions = {},
): Promise<KnowledgeResponse> {
  const payload = {
    mode,
    prompt: userPrompt,
    localEndpoint: options.localEndpoint,
    conversation: options.conversation,
  };

  const response = await fetch('/api/mcp/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  await ensureOk(response, 'Local MCP 질의 실패');

  const responseData = (await response.json()) as Partial<KnowledgeResponse>;
  if (typeof responseData.answer === 'string' && responseData.answer.length > 0) {
    return {
      action: responseData.action || 'local-mcp',
      answer: responseData.answer,
      explanation: responseData.explanation,
      route: responseData.route,
      routedQuery: responseData.routedQuery,
      tool: responseData.tool,
      arguments: responseData.arguments,
      result: responseData.result,
      requiresInput: (responseData as { requiresInput?: boolean })?.requiresInput,
      missing: (responseData as { missing?: string })?.missing,
    };
  }

  const prompt = `${buildSystemPrompt(mode)}\n\n사용자 요청: ${userPrompt}`;
  return {
    action: 'local-mcp',
    answer: `시스템 프롬프트:\n${prompt}\n\n로컬 MCP 응답 형식이 없거나 비어 있어 임시 응답을 표시합니다.`,
    explanation: responseData.explanation,
    route: responseData.route,
    routedQuery: responseData.routedQuery,
    tool: responseData.tool,
    arguments: responseData.arguments,
    result: responseData.result,
    requiresInput: (responseData as { requiresInput?: boolean })?.requiresInput,
    missing: (responseData as { missing?: string })?.missing,
  };
}

const parseStreamMessage = (block: string) => {
  const lines = block
    .split('\n')
    .map((line) => line.trimEnd())
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return { event, data: dataLines.join('\n') };
};

export async function streamKnowledge(
  mode: MCPMode,
  userPrompt: string,
  options: QueryKnowledgeOptions = {},
): Promise<void> {
  const payload = {
    mode,
    prompt: userPrompt,
    localEndpoint: options.localEndpoint,
    conversation: options.conversation,
  };

  const response = await fetch('/api/mcp/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await response.text();
    const error = `${response.status}: ${message || '엔드포인트 응답이 실패했습니다.'}`;
    options.onError?.(error);
    throw new Error(error);
  }

  if (!response.body) {
    const error = 'SSE 응답 본문이 없습니다.';
    options.onError?.(error);
    throw new Error(error);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalData: KnowledgeResponse | null = null;
  let accumulatedAnswer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (buffer.includes('\n\n')) {
      const boundary = buffer.indexOf('\n\n');
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const { event, data } = parseStreamMessage(block);
      if (!data) {
        continue;
      }

      if (event === 'delta') {
        try {
          const parsed = JSON.parse(data);
          const chunk = typeof parsed?.chunk === 'string' ? parsed.chunk : '';
          if (chunk) {
            accumulatedAnswer += chunk;
            options.onDelta?.(chunk);
          }
        } catch {
          accumulatedAnswer += data;
          options.onDelta?.(data);
        }
        continue;
      }

      if (event === 'final') {
        try {
          const parsed = JSON.parse(data);
          if (typeof parsed.answer === 'string') {
            finalData = parsed as KnowledgeResponse;
            if (!accumulatedAnswer) {
              accumulatedAnswer = parsed.answer;
            }
            options.onFinal?.(finalData);
          } else {
            finalData = {
              action: 'local-mcp',
              answer: data,
            } as KnowledgeResponse;
            options.onFinal?.(finalData);
          }
        } catch {
          finalData = {
            action: 'local-mcp',
            answer: data,
          } as KnowledgeResponse;
          options.onFinal?.(finalData);
        }
        continue;
      }

      if (event === 'error') {
        options.onError?.(data);
        continue;
      }

      if (event === 'done') {
        continue;
      }

      options.onProgress?.({ type: event, data });
    }
  }

  if (!finalData && accumulatedAnswer) {
    const fallbackFinal = {
      action: finalData?.action || 'local-mcp',
      answer: accumulatedAnswer,
      route: finalData?.route,
      routedQuery: finalData?.routedQuery,
      explanation: finalData?.explanation,
      tool: finalData?.tool,
      arguments: finalData?.arguments,
      requiresInput: finalData?.requiresInput,
      missing: finalData?.missing,
    } as KnowledgeResponse;
    options.onFinal?.(fallbackFinal);
    return;
  }

  if (finalData) {
    return;
  }

  if (!buffer.trim()) {
    return;
  }

  const fallback = parseStreamMessage(buffer);
  if (fallback.data) {
    options.onFinal?.({
      action: 'local-mcp',
      answer: fallback.data,
    } as KnowledgeResponse);
  }
}
