export type MCPMode = 'local' | 'notion';

export interface MCPSettings {
  mode: MCPMode;
}

export interface KnowledgeResponse {
  action: string;
  answer: string;
}

export interface KnowledgeMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}
