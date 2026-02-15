import type { MCPMode, KnowledgeResponse } from '../types/mcp';

const SYSTEM_PROMPT_BY_MODE: Record<MCPMode, string> = {
  local: `너는 로컬 Notion MCP 캐시 지식 저장소 어시스턴트야. \
사용자가 요청한 내용을 먼저 분류해서 필요한 지식 검색/추가/수정 작업을 제안하고, \
가능하면 쿼리, 페이지 제목, 핵심 키워드 형식으로 구조화해서 반환해.`,
  notion:
    '너는 Notion MCP API를 통해 Notion 지식 체계를 검색/조회/수정하는 전담 어시스턴트야. 사용자는 자연어로 업무 지식이나 문서 검색을 요청한다.',
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const buildSystemPrompt = (mode: MCPMode) => SYSTEM_PROMPT_BY_MODE[mode];

export async function queryKnowledge(
  mode: MCPMode,
  userPrompt: string,
): Promise<KnowledgeResponse> {
  const prompt = `${buildSystemPrompt(mode)}\n\n사용자 요청: ${userPrompt}`;

  // TODO: 실제 MCP + GPT 호출 지점
  // - 실제 배포시 아래 fetch를 실제 엔드포인트로 교체하세요.
  // - 예: /api/mcp/query -> { mode, prompt }
  await delay(550);

  return {
    action: mode === 'local' ? 'local-search' : 'notion-api-request',
    answer: `시스템 프롬프트:\n${prompt}\n\n응답 예시: 사용자가 요청한 내용에 대해 지식 체계를 검색해 관련 항목을 찾아왔고, 다음 단계로 실행할 액션은 '${mode}' 모드에서 유효한 MCP 호출입니다.`,
  };
}
