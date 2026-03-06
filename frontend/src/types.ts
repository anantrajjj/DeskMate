/** API response types matching the orchestrator's response schema. */

export interface ToolInvocation {
    tool: string;
    args: Record<string, unknown>;
    result: unknown;
    latencyMs: number;
}

export interface RAGResult {
    chunk: string;
    score: number;
    index: number;
}

export interface ChatResponse {
    requestId: string;
    answer: string;
    tools_invoked: ToolInvocation[];
    rag_context: RAGResult[];
    errors: string[];
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    response?: ChatResponse;  // Full response data for assistant messages
    isLoading?: boolean;
    error?: string;
}

export type AgentActivity =
    | 'idle'
    | 'parsing_intent'
    | 'searching_handbook'
    | 'checking_tickets'
    | 'creating_ticket'
    | 'checking_entitlement'
    | 'generating_response';

export const ACTIVITY_LABELS: Record<AgentActivity, string> = {
    idle: '',
    parsing_intent: '🔍 Analyzing your question...',
    searching_handbook: '📚 Searching IT Handbook...',
    checking_tickets: '🎫 Checking your tickets...',
    creating_ticket: '📝 Creating support ticket...',
    checking_entitlement: '🔑 Checking software entitlement...',
    generating_response: '💬 Generating response...',
};
