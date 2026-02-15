# Local MCP Knowledge Client

React 19 + Vite + MUI + Express 기반으로 구성된 로컬 MCP 챗 인터페이스입니다.

## 실행

백엔드 실행:

```bash
pnpm install
pnpm server
```

프론트 실행 (새 터미널):

```bash
pnpm dev
```

## 환경변수

루트에 `.env` 생성 후 사용:

```bash
VITE_MCP_API_BASE_URL=http://localhost:4000
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4o-mini
LOCAL_MCP_TOKEN=your_local_mcp_token

PORT=4000
FRONT_ORIGIN=http://localhost:5173
LOCAL_MCP_ENDPOINT=http://localhost:3001/mcp
```

## 동작

1. 첫 화면에서 `로컬 MCP 엔드포인트` 입력 후 연결
2. 채팅창에서 메시지 입력
3. 프론트가 `/api/mcp/chat`를 호출
4. 백엔드가 OpenAI에게 요청을 분석시켜, 필요 시 MCP 호출 여부를 판단
5. 로컬 MCP가 필요한 경우 `LOCAL_MCP_ENDPOINT`(또는 화면에서 입력한 endpoint)로 요청을 전송
6. 최종 답변/실행 액션을 챗 화면에 표시

백엔드 라우트:

- `POST /api/mcp/chat`: GPT 기반 라우터(요청 분기 + MCP 호출)
- `POST /api/mcp/query`: 로컬 MCP 직접 호출 용도(내부/디버깅 용도)

## 주요 파일

- `server/index.js`: Express 브릿지 (로컬 MCP 호출 라우트)
  - `POST /api/mcp/query`
- `src/components/McpSetup.tsx`: 엔드포인트 등록 화면
- `src/components/KnowledgeEditor.tsx`: ChatGPT 스타일 채팅 UI
- `src/services/mcpClient.ts`: 프론트-브릿지 API 호출
- `src/services/storage.ts`: 로컬 모드/엔드포인트 저장/복원
