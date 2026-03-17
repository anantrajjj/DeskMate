import { useState, useRef, useEffect, useCallback } from 'react';
import { ChatMessage, AgentActivity, ACTIVITY_LABELS, ChatResponse } from './types';
import { sendChatMessage } from './api';

/**
 * DeskMate Frontend - Main App Component.
 *
 * Architecture: Single-component design with local state (useState).
 * WHY NO STATE MANAGEMENT LIBRARY? The app has one primary state flow:
 * messages[] + input + loading. React's built-in hooks handle this cleanly
 * without Redux/Zustand overhead.
 */

// Quick action suggestions for the welcome screen
const QUICK_ACTIONS = [
    { icon: '🔐', text: 'How do I reset my password?', message: 'How do I reset my password?' },
    { icon: '🎫', text: 'Check my support tickets', message: 'Show my tickets' },
    { icon: '💻', text: 'Do I have Photoshop?', message: 'Do I have access to Adobe Photoshop?' },
    { icon: '🌐', text: 'VPN troubleshooting help', message: 'My VPN keeps disconnecting, what should I do?' },
];

/**
 * Lightweight markdown-to-HTML renderer.
 * WHY NOT A LIBRARY? We only need bold, italic, bullets, and line breaks.
 * A full markdown library (marked, react-markdown) adds 20-50KB for features
 * we don't use. This covers the patterns our orchestrator actually produces.
 */
function renderMarkdown(text: string): string {
    return text
        // Escape HTML entities to prevent XSS
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Headers: ### text → <h3>text</h3>
        .replace(/^### (.*$)/gm, '<h3>$1</h3>')
        .replace(/^## (.*$)/gm, '<h2>$1</h2>')
        .replace(/^# (.*$)/gm, '<h1>$1</h1>')
        // Bold: **text** → <strong>text</strong>
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // Italic: _text_ → <em>text</em>
        .replace(/(?:^|\s)_(.+?)_(?:\s|$)/g, ' <em>$1</em> ')
        // Bullet points: • or - or * at line start
        .replace(/^[•\-\*]\s+(.+)$/gm, '<li>$1</li>')
        // Wrap consecutive <li> in <ul>
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        // Line breaks: \n → <br>
        .replace(/\n/g, '<br/>');
}

function App() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [employeeId, setEmployeeId] = useState('EMP001');
    const [isLoading, setIsLoading] = useState(false);
    const [activity, setActivity] = useState<AgentActivity>('idle');
    const [expandedDebug, setExpandedDebug] = useState<Set<string>>(new Set());

    const chatEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, activity]);

    // Simulate agent activity stages for UX feedback
    const simulateActivity = useCallback(async (message: string) => {
        // Parse likely activity from the message content
        const lowerMsg = message.toLowerCase();

        setActivity('parsing_intent');
        await new Promise((r) => setTimeout(r, 400));

        if (lowerMsg.includes('ticket') && (lowerMsg.includes('create') || lowerMsg.includes('open') || lowerMsg.includes('submit'))) {
            setActivity('creating_ticket');
        } else if (lowerMsg.includes('ticket') || lowerMsg.includes('status')) {
            setActivity('checking_tickets');
        } else if (lowerMsg.includes('access') || lowerMsg.includes('entitled') || lowerMsg.includes('license') || lowerMsg.includes('have')) {
            setActivity('checking_entitlement');
        } else {
            setActivity('searching_handbook');
        }
        await new Promise((r) => setTimeout(r, 300));
        setActivity('generating_response');
    }, []);

    const handleSend = useCallback(async (messageText?: string) => {
        const text = (messageText || input).trim();
        if (!text || isLoading) return;

        const userMessage: ChatMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: text,
            timestamp: new Date(),
        };

        setMessages((prev) => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        // Start activity simulation (non-blocking)
        simulateActivity(text);

        try {
            const response: ChatResponse = await sendChatMessage(text, employeeId);

            const assistantMessage: ChatMessage = {
                id: response.requestId || `asst-${Date.now()}`,
                role: 'assistant',
                content: response.answer,
                timestamp: new Date(),
                response,
            };

            setMessages((prev) => [...prev, assistantMessage]);
        } catch (error) {
            const errorMessage: ChatMessage = {
                id: `error-${Date.now()}`,
                role: 'assistant',
                content: '',
                timestamp: new Date(),
                error: (error as Error).message || 'Failed to connect to the server. Please check that the orchestrator is running.',
            };

            setMessages((prev) => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
            setActivity('idle');
        }
    }, [input, employeeId, isLoading, simulateActivity]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const toggleDebug = (messageId: string) => {
        setExpandedDebug((prev) => {
            const next = new Set(prev);
            if (next.has(messageId)) {
                next.delete(messageId);
            } else {
                next.add(messageId);
            }
            return next;
        });
    };

    return (
        <>
            {/* Dynamic Mesh Gradient Background */}
            <div className="ambient-background">
                <div className="ambient-blob blob-1"></div>
                <div className="ambient-blob blob-2"></div>
                <div className="ambient-blob blob-3"></div>
            </div>

            <div className="app-container">
                {/* Header */}
                <header className="app-header">
                    <div className="header-left">
                        <div className="app-logo">🤖</div>
                        <div>
                            <h1 className="app-title">DeskMate</h1>
                            <p className="app-subtitle">AI IT Help Desk Assistant</p>
                        </div>
                    </div>
                    <div className="header-right">
                        <div className="employee-badge">
                            <span className="badge-dot"></span>
                            <span>Employee:</span>
                            <input
                                className="employee-input"
                                value={employeeId}
                                onChange={(e) => setEmployeeId(e.target.value)}
                                placeholder="EMP001"
                                aria-label="Employee ID"
                            />
                        </div>
                    </div>
                </header>

                {/* Chat Area */}
                <div className="chat-area">
                    {messages.length === 0 ? (
                        <div className="welcome-screen">
                            <div className="welcome-icon">🤖</div>
                            <h2 className="welcome-title">Welcome to DeskMate</h2>
                            <p className="welcome-subtitle">
                                I'm your AI IT Help Desk Assistant. Ask me about IT policies,
                                manage support tickets, or check software entitlements.
                            </p>
                            <div className="quick-actions">
                                {QUICK_ACTIONS.map((action, i) => (
                                    <button
                                        key={i}
                                        className="quick-action"
                                        onClick={() => handleSend(action.message)}
                                    >
                                        <div className="quick-action-icon">{action.icon}</div>
                                        <div className="quick-action-text">{action.text}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <>
                            {messages.map((msg) => (
                                <div key={msg.id}>
                                    {msg.error ? (
                                        <div className="error-message">
                                            <span className="error-icon">⚠️</span>
                                            <div className="error-text">
                                                <strong>Connection Error</strong>
                                                <br />
                                                {msg.error}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className={`message ${msg.role}`}>
                                            <div className="message-avatar">
                                                {msg.role === 'assistant' ? '🤖' : '👤'}
                                            </div>
                                            <div>
                                                <div
                                                    className="message-content"
                                                    dangerouslySetInnerHTML={{
                                                        __html: msg.role === 'assistant'
                                                            ? renderMarkdown(msg.content)
                                                            : msg.content
                                                    }}
                                                />

                                                {/* Response metadata badges */}
                                                {msg.response && (
                                                    <div className="response-metadata">
                                                        {msg.response.tools_invoked.map((tool, i) => (
                                                            <span key={i} className="metadata-badge badge-tool">
                                                                🔧 {tool.tool}
                                                            </span>
                                                        ))}
                                                        {msg.response.rag_context.length > 0 && (
                                                            <span className="metadata-badge badge-rag">
                                                                📚 RAG ({msg.response.rag_context.length} chunks)
                                                            </span>
                                                        )}
                                                        {msg.response.errors.length > 0 && (
                                                            <span className="metadata-badge badge-error">
                                                                ⚠ {msg.response.errors.length} error(s)
                                                            </span>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Debug Toggle */}
                                                {msg.response && (
                                                    <div className="debug-toggle">
                                                        <button
                                                            className={`debug-toggle-btn ${expandedDebug.has(msg.id) ? 'active' : ''}`}
                                                            onClick={() => toggleDebug(msg.id)}
                                                        >
                                                            {expandedDebug.has(msg.id) ? '▼ Hide' : '▶ Show'} Debug Trace
                                                        </button>
                                                    </div>
                                                )}

                                                {/* Debug Panel */}
                                                {msg.response && expandedDebug.has(msg.id) && (
                                                    <div className="debug-panel">
                                                        <pre>{JSON.stringify(msg.response, null, 2)}</pre>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </>
                    )}

                    {/* Agent Activity Indicator */}
                    {isLoading && activity !== 'idle' && (
                        <div className="activity-indicator">
                            <div className="activity-spinner"></div>
                            <div>
                                <div className="activity-text">{ACTIVITY_LABELS[activity]}</div>
                            </div>
                        </div>
                    )}

                    <div ref={chatEndRef} />
                </div>

                {/* Input Area */}
                <div className="input-area">
                    <div className="input-container">
                        <div className="input-wrapper">
                            <textarea
                                ref={inputRef}
                                className="chat-input"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Ask about IT policies, tickets, or software access..."
                                disabled={isLoading}
                                rows={1}
                            />
                        </div>
                        <button
                            className="send-btn"
                            onClick={() => handleSend()}
                            disabled={isLoading || !input.trim()}
                            aria-label="Send message"
                        >
                            ↑
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}

export default App;
