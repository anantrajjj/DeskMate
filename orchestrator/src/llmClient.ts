/**
 * LLM Client — Groq-powered response synthesis.
 *
 * Uses the OpenAI-compatible SDK pointed at Groq's API to synthesize natural
 * language answers from RAG chunks and tool outputs gathered by the orchestrator.
 *
 * WHY GROQ?
 * Groq offers a free tier with very fast inference speed (LPU hardware).
 * We use the `openai` npm package because Groq's API is OpenAI-compatible,
 * making it trivial to swap providers later (OpenAI, Anthropic, Ollama, etc.)
 * by changing the baseURL and apiKey.
 *
 * WHY GRACEFUL FALLBACK?
 * If GROQ_API_KEY is not set or the LLM call fails, we return the
 * template-based fallback answer so the app always works — even without
 * an API key configured.
 */

import OpenAI from "openai";
import { logJson } from "./logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const MODEL = "llama-3.3-70b-versatile";

// Max tokens for the response — keeps answers concise and costs low
const MAX_TOKENS = 1024;

// Timeout for LLM calls (15 seconds — Groq is typically <2s)
const LLM_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Client Initialization
// ---------------------------------------------------------------------------

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
    if (!GROQ_API_KEY) return null;
    if (!client) {
        client = new OpenAI({
            apiKey: GROQ_API_KEY,
            baseURL: GROQ_BASE_URL,
            timeout: LLM_TIMEOUT,
        });
    }
    return client;
}

/**
 * Check if the LLM is configured (API key present).
 */
export function isLLMConfigured(): boolean {
    return GROQ_API_KEY.length > 0;
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are DeskMate, an AI-powered IT Help Desk Assistant for a corporate environment.

Your role:
- Answer IT-related questions using the provided context from the IT Handbook and tool outputs.
- Be helpful, professional, and concise.
- Structure your responses clearly using markdown formatting (bold, bullet points, etc.).
- If tool results are provided (tickets, entitlements), incorporate them naturally into your response.
- Do NOT invent information that isn't in the provided context.
- If the context doesn't fully answer the question, say so and suggest contacting IT Support at ext. 4357 (HELP).
- Never reveal internal system details (chunk scores, tool names, API internals).

Tone: Friendly, professional, knowledgeable. Like a helpful senior IT support engineer.`;

// ---------------------------------------------------------------------------
// Synthesis Function
// ---------------------------------------------------------------------------

export interface SynthesizeParams {
    userMessage: string;
    intent: string;
    ragChunks: { chunk: string; score: number }[];
    toolResults: { tool: string; args: Record<string, unknown>; result: unknown }[];
    fallbackAnswer: string;
}

/**
 * Synthesize a natural-language answer from RAG chunks and tool outputs.
 *
 * Returns `fallbackAnswer` if the LLM is not configured or the call fails.
 */
export async function synthesizeAnswer(params: SynthesizeParams): Promise<string> {
    const llm = getClient();
    if (!llm) {
        logJson("llm_skipped", { reason: "no_api_key" });
        return params.fallbackAnswer;
    }

    try {
        // Build the user prompt with all gathered context
        const contextParts: string[] = [];

        // Add RAG context
        if (params.ragChunks.length > 0) {
            contextParts.push("=== IT Handbook Context ===");
            params.ragChunks.forEach((chunk, i) => {
                contextParts.push(`[Source ${i + 1}]:\n${chunk.chunk}`);
            });
        }

        // Add tool results
        if (params.toolResults.length > 0) {
            contextParts.push("=== Tool Results ===");
            params.toolResults.forEach((tool) => {
                contextParts.push(
                    `[${tool.tool}] Called with: ${JSON.stringify(tool.args)}\nResult: ${JSON.stringify(tool.result, null, 2)}`
                );
            });
        }

        const userPrompt = [
            `User Question: ${params.userMessage}`,
            `Detected Intent: ${params.intent}`,
            "",
            contextParts.length > 0
                ? contextParts.join("\n\n")
                : "No additional context was retrieved.",
            "",
            "Based on the above context, provide a helpful and complete answer to the user's question. " +
            "Use markdown formatting for readability. Be concise but thorough.",
        ].join("\n");

        logJson("llm_call_start", {
            model: MODEL,
            intent: params.intent,
            ragChunkCount: params.ragChunks.length,
            toolResultCount: params.toolResults.length,
        });

        const completion = await llm.chat.completions.create({
            model: MODEL,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
            ],
            max_tokens: MAX_TOKENS,
            temperature: 0.3, // Low temperature for factual, grounded responses
        });

        const response = completion.choices[0]?.message?.content;

        if (!response) {
            logJson("llm_empty_response", { model: MODEL });
            return params.fallbackAnswer;
        }

        logJson("llm_call_complete", {
            model: MODEL,
            responseLength: response.length,
            tokensUsed: completion.usage?.total_tokens,
        });

        return response;
    } catch (error) {
        const errMsg = (error as Error).message;
        logJson("llm_call_error", { error: errMsg, model: MODEL });
        // Graceful degradation: return the template-based answer
        return params.fallbackAnswer;
    }
}
