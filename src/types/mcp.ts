export type MCPMode = 'local';

export interface KnowledgeResponse {
  action: string;
  answer: string;
  explanation?: string;
  route?: 'local_mcp' | 'chat_only';
  routedQuery?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  requiresInput?: boolean;
  missing?: string;
  result?: unknown;
}

export interface KnowledgeMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  detail?: string;
  thoughts?: string[];
  isStreaming?: boolean;
}

export interface LocalMCPConfig {
  endpoint: string;
}
