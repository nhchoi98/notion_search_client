# Notion MCP Knowledge Client

React 19 + MUI로 만든 CSR 기반 Notion MCP 지식 탐색 클라이언트 예시입니다.

## 실행

```bash
pnpm install
pnpm dev
```

## 스크립트

- `pnpm dev`: 개발 서버 실행
- `pnpm build`: 타입 검사 + 빌드
- `pnpm lint`: ESLint 실행
- `pnpm format`: Prettier 실행
- `pnpm format:check`: Prettier 검사

## 구조

- `src/components/McpSetup.tsx`: 최초 MCP 연결 방식 선택(로컬/Notion)
- `src/components/KnowledgeEditor.tsx`: 에디터형 메인 화면 + 질의 로그
- `src/services/mcpClient.ts`: GPT/MCP 호출 엔드포인트 교체 포인트
- `src/services/storage.ts`: 로컬스토리지 기반 mode 저장/복원

## React Compiler

`vite.config.ts`에 react compiler Babel 플러그인 설정이 들어가 있습니다. 실제 사용 시
```bash
babel-plugin-react-compiler
eslint-plugin-react-compiler
```
버전을 맞춰 설치합니다.
