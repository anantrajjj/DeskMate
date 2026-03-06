import { ChatResponse } from './types';

/**
 * API client for communicating with the orchestrator service.
 *
 * WHY A SEPARATE API LAYER?
 * Decoupling API calls from components makes it easy to:
 *   1. Change the backend URL (dev vs. Docker vs. production)
 *   2. Add auth headers, retries, or caching in one place
 *   3. Mock the API for testing
 */

// In Docker: the frontend is served statically and needs the full URL.
// In dev: Vite's proxy handles /api → http://localhost:3001.
const API_BASE = import.meta.env.VITE_API_URL || '';

export async function sendChatMessage(
    message: string,
    employeeId: string
): Promise<ChatResponse> {
    const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, employeeId }),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
            errorData.error || `Server error: ${response.status} ${response.statusText}`
        );
    }

    return response.json();
}

export async function checkHealth(): Promise<{
    service: string;
    status: string;
    ragService: { status: string };
}> {
    const response = await fetch(`${API_BASE}/api/health`);
    if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
    }
    return response.json();
}
