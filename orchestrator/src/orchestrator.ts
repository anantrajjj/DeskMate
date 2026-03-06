/**
 * DeskMate Orchestration Engine.
 *
 * This is the brain of the system. It takes a user message, determines intent,
 * and orchestrates multi-step responses by combining:
 *   - RAG lookups (for IT policy/procedure questions)
 *   - Tool calls (for ticket management and entitlement checks)
 *   - Template-based response generation
 *
 * WHY NOT USE AN LLM FOR INTENT PARSING?
 * This project is designed to run with no API keys. Instead of calling GPT/Claude
 * for intent classification, we use a keyword-based intent parser. In production,
 * you would swap `parseIntent()` with an LLM call via LangChain. The rest of the
 * orchestration pipeline (tool selection, RAG querying, response assembly) would
 * remain identical.
 *
 * MULTI-STEP REASONING FLOW:
 *   1. Parse user intent from the message
 *   2. Based on intent, determine which tools/RAG calls are needed
 *   3. Execute them (possibly in sequence — e.g., check entitlement, THEN query RAG)
 *   4. Assemble a structured response with all context
 */

import { v4 as uuidv4 } from "uuid";
import { logJson } from "./logger";
import {
    getEmployeeTickets,
    createSupportTicket,
    checkSoftwareEntitlement,
    Ticket,
} from "./tools";
import { queryRAG, RAGQueryResult } from "./ragClient";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatRequest {
    message: string;
    employeeId: string;
}

export interface ToolInvocation {
    tool: string;
    args: Record<string, unknown>;
    result: unknown;
    latencyMs: number;
}

export interface ChatResponse {
    requestId: string;
    answer: string;
    tools_invoked: ToolInvocation[];
    rag_context: RAGQueryResult[];
    errors: string[];
}

export interface DebugTrace {
    requestId: string;
    query: string;
    employeeId: string;
    intent: IntentResult;
    steps: DebugStep[];
    totalLatencyMs: number;
    timestamp: string;
}

export interface DebugStep {
    step: number;
    action: string;
    input: unknown;
    output: unknown;
    latencyMs: number;
}

type Intent =
    | "compound_query"
    | "check_tickets"
    | "create_ticket"
    | "check_software"
    | "knowledge_query"
    | "software_and_knowledge"
    | "greeting"
    | "out_of_scope"
    | "unknown";

interface IntentResult {
    intent: Intent;
    confidence: number;
    extractedEntities: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Intent Parser
// WHY KEYWORD-BASED? Without an LLM, we use pattern matching to classify
// intents. This is fragile compared to an LLM but deterministic and fast.
// Each pattern group maps to an intent with regex matching for entity
// extraction (e.g., software names, ticket subjects).
// ---------------------------------------------------------------------------

const INTENT_PATTERNS: {
    intent: Intent;
    patterns: RegExp[];
    entityExtractor?: (msg: string) => Record<string, string>;
}[] = [
        {
            // COMPOUND QUERY — Highest priority. Detects multi-part requests that
            // combine knowledge retrieval + ticket operations in a single message.
            // WHY FIRST? Compound queries contain keywords that would match simpler
            // intents (e.g., "ticket" would match check_tickets). By checking for
            // compound patterns first, we avoid misclassifying multi-step requests.
            intent: "compound_query",
            patterns: [
                // Matches messages containing BOTH a knowledge question AND a ticket action
                /(?:vpn|password|reset|hardware|software|email|wifi|network|printer).*(?:ticket|check.*ticket|create.*ticket|open.*ticket)/i,
                /(?:ticket|check.*ticket|create.*ticket|open.*ticket).*(?:vpn|password|reset|hardware|software|email|wifi|network|printer)/i,
                // "also" / "and" bridging knowledge + action
                /(?:what|how|why).*(?:also|and also|and then|then).*(?:ticket|check|create|open)/i,
                /(?:check|create|open).*(?:ticket).*(?:also|and also|and then|then).*(?:what|how|why)/i,
            ],
            entityExtractor: (msg: string) => {
                const entities: Record<string, string> = {};
                // Extract subject for potential ticket creation
                const subjectMatch = msg.match(/(?:about|for|regarding)\s*["']?([^"'\n.?]+)["']?/i);
                if (subjectMatch) entities.subject = subjectMatch[1].trim();

                // Extract priority
                const priorityMatch = msg.match(/(?:priority|P)\s*['"]?([1-4]|high|medium|low|critical)['"]?/i);
                if (priorityMatch) {
                    const p = priorityMatch[1].toLowerCase();
                    const priorityMap: Record<string, string> = { high: "P2", critical: "P1", medium: "P3", low: "P4" };
                    entities.priority = priorityMap[p] || `P${p}`;
                }

                return entities;
            },
        },
        {
            intent: "create_ticket",
            patterns: [
                /create\s+(a\s+)?ticket/i,
                /submit\s+(a\s+)?ticket/i,
                /open\s+(a\s+)?ticket/i,
                /raise\s+(a\s+)?(ticket|issue|request)/i,
                /file\s+(a\s+)?(ticket|complaint)/i,
                /need\s+help\s+with.*create/i,
                /log\s+(a\s+)?(ticket|issue)/i,
            ],
            entityExtractor: (msg: string) => {
                const entities: Record<string, string> = {};
                const subjectMatch = msg.match(/(?:about|for|regarding|subject[:\s]+)\s*["']?([^"'\n.]+)["']?/i);
                if (subjectMatch) entities.subject = subjectMatch[1].trim();

                const priorityMatch = msg.match(/(?:priority|P)\s*([1-4])/i);
                if (priorityMatch) entities.priority = `P${priorityMatch[1]}`;

                return entities;
            },
        },
        {
            intent: "check_tickets",
            patterns: [
                /(?:my|check|view|list|show|get)\s+tickets?/i,
                /ticket\s+status/i,
                /existing\s+tickets?/i,
                /open\s+tickets?/i,
                /any\s+tickets?/i,
                /do\s+i\s+have\s+(?:any\s+)?tickets?/i,
            ],
        },
        {
            intent: "check_software",
            patterns: [
                /(?:do\s+i\s+have|am\s+i\s+entitled|can\s+i\s+(?:use|access|get))\s+(\w[\w\s]*)/i,
                /(?:check|verify)\s+(?:my\s+)?(?:access|license|entitlement)\s+(?:for|to)\s+(\w[\w\s]*)/i,
                /(?:software|license)\s+(?:for|check)\s+(\w[\w\s]*)/i,
            ],
            entityExtractor: (msg: string) => {
                const entities: Record<string, string> = {};
                const patterns = [
                    /(?:do\s+i\s+have|am\s+i\s+entitled\s+to|can\s+i\s+(?:use|access|get))\s+(?:access\s+(?:to|for)\s+)?(.+?)(?:\?|$)/i,
                    /(?:access|license|entitlement)\s+(?:for|to)\s+(.+?)(?:\?|$)/i,
                    /(?:software|license)\s+(?:for|check)\s+(.+?)(?:\?|$)/i,
                ];
                for (const pattern of patterns) {
                    const match = msg.match(pattern);
                    if (match) {
                        entities.softwareName = match[1].trim().replace(/[?.!]+$/, "");
                        break;
                    }
                }
                return entities;
            },
        },
        {
            intent: "software_and_knowledge",
            patterns: [
                /(?:how\s+(?:do\s+i|can\s+i|to)\s+(?:get|install|request|access))\s+(\w[\w\s]*)/i,
                /(?:i\s+need|i\s+want)\s+(\w[\w\s]*?)(?:\s+(?:installed|access|license)|\?|$)/i,
            ],
            entityExtractor: (msg: string) => {
                const entities: Record<string, string> = {};
                const patterns = [
                    /(?:how\s+(?:do\s+i|can\s+i|to)\s+(?:get|install|request|access))\s+(.+?)(?:\?|$)/i,
                    /(?:i\s+need|i\s+want)\s+(.+?)(?:\s+(?:installed|access|license)|\?|$)/i,
                ];
                for (const pattern of patterns) {
                    const match = msg.match(pattern);
                    if (match) {
                        entities.softwareName = match[1].trim().replace(/[?.!]+$/, "");
                        break;
                    }
                }
                return entities;
            },
        },
        {
            intent: "greeting",
            patterns: [
                /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|howdy|greetings)/i,
            ],
        },
        {
            // OUT-OF-SCOPE — Catch non-IT questions AFTER all action intents.
            // WHY AFTER ACTIONS? Words like "show" appear in both IT commands
            // ("show my tickets") and non-IT phrases ("show me a movie").
            // By placing this after check_tickets/create_ticket/etc., we ensure
            // IT-related "show" commands match first.
            intent: "out_of_scope",
            patterns: [
                /(?:weather|forecast|temperature|rain)/i,
                /(?:recipe|cook|food|restaurant|eat)/i,
                /(?:sports|game|score|football|basketball|cricket)/i,
                /(?:movie|film|netflix|tv\s+show)/i,
                /(?:joke|funny|laugh)/i,
                /(?:stock|invest|crypto|bitcoin)/i,
                /(?:news|politics|election)/i,
            ],
        },
        {
            intent: "knowledge_query",
            // This is the fallback — if we don't match any specific action intent,
            // we treat it as a general IT knowledge question and search the handbook.
            patterns: [
                /(?:how|what|when|where|who|why|can|do|does|is|are|tell\s+me|explain)/i,
                /(?:vpn|password|reset|hardware|software|email|wifi|network|printer|backup|security|mfa|incident|escalat)/i,
                /(?:policy|procedure|process|guide|help|support)/i,
            ],
        },
    ];

function parseIntent(message: string): IntentResult {
    const normalizedMsg = message.trim();

    for (const { intent, patterns, entityExtractor } of INTENT_PATTERNS) {
        for (const pattern of patterns) {
            if (pattern.test(normalizedMsg)) {
                const entities = entityExtractor ? entityExtractor(normalizedMsg) : {};
                // WHY FIXED CONFIDENCE? Without an LLM, we can't compute real
                // confidence scores. We use 0.85 for specific intents and 0.5
                // for the fallback knowledge_query to signal lower certainty.
                const confidence = intent === "knowledge_query" ? 0.5 : 0.85;

                logJson("intent_parsed", { intent, confidence, entities });
                return { intent, confidence, extractedEntities: entities };
            }
        }
    }

    return { intent: "unknown", confidence: 0.1, extractedEntities: {} };
}

// ---------------------------------------------------------------------------
// Orchestration Engine
// ---------------------------------------------------------------------------

/**
 * Main orchestration function: parses intent, calls tools/RAG, assembles response.
 *
 * WHY THIS ARCHITECTURE?
 * This function acts as a "controller" that delegates to specialized handlers
 * based on intent. Each handler can make multiple async calls (tools + RAG) and
 * build up the response incrementally. This is analogous to how LangChain Agents
 * work, but with deterministic routing instead of LLM-based planning.
 */
export async function orchestrate(request: ChatRequest): Promise<{
    response: ChatResponse;
    debugTrace: DebugTrace;
}> {
    const requestId = uuidv4();
    const startTime = Date.now();

    const toolsInvoked: ToolInvocation[] = [];
    const ragContext: RAGQueryResult[] = [];
    const errors: string[] = [];
    const debugSteps: DebugStep[] = [];
    let stepCounter = 0;

    logJson("orchestration_start", {
        requestId,
        message: request.message,
        employeeId: request.employeeId,
    });

    // Step 1: Parse intent
    const intentResult = parseIntent(request.message);

    debugSteps.push({
        step: ++stepCounter,
        action: "intent_parsing",
        input: { message: request.message },
        output: intentResult,
        latencyMs: Date.now() - startTime,
    });

    let answer = "";

    try {
        switch (intentResult.intent) {
            case "greeting":
                answer = `Hello! I'm DeskMate, your IT Help Desk Assistant. I can help you with:\n` +
                    `• Checking your support tickets\n` +
                    `• Creating new support tickets\n` +
                    `• Checking software entitlements\n` +
                    `• Answering IT policy questions (VPN, passwords, hardware, etc.)\n\n` +
                    `How can I help you today?`;
                break;

            case "out_of_scope":
                // WHY EXPLICIT REDIRECT? Out-of-scope queries should not hit RAG
                // (which would return irrelevant results) or confuse the user.
                answer = "I appreciate the question, but I'm specifically designed to help with IT-related topics. " +
                    "I can assist you with:\n\n" +
                    "• **IT Policies**: VPN, passwords, hardware, software access\n" +
                    "• **Support Tickets**: Create, view, or check status of tickets\n" +
                    "• **Software Entitlements**: Check your software licenses\n\n" +
                    "Could you rephrase your question as an IT-related request?";
                break;

            case "compound_query":
                // MULTI-STEP: RAG + check tickets + conditionally create ticket
                answer = await handleCompoundQuery(
                    request.employeeId,
                    request.message,
                    intentResult.extractedEntities,
                    toolsInvoked,
                    ragContext,
                    debugSteps,
                    errors,
                    stepCounter
                ).then(({ answer, stepCounter: sc }) => {
                    stepCounter = sc;
                    return answer;
                });
                break;

            case "check_tickets":
                answer = await handleCheckTickets(
                    request.employeeId,
                    toolsInvoked,
                    debugSteps,
                    errors,
                    stepCounter
                ).then(({ answer, stepCounter: sc }) => {
                    stepCounter = sc;
                    return answer;
                });
                break;

            case "create_ticket":
                answer = await handleCreateTicket(
                    request.employeeId,
                    request.message,
                    intentResult.extractedEntities,
                    toolsInvoked,
                    debugSteps,
                    errors,
                    stepCounter
                ).then(({ answer, stepCounter: sc }) => {
                    stepCounter = sc;
                    return answer;
                });
                break;

            case "check_software":
                answer = await handleCheckSoftware(
                    request.employeeId,
                    intentResult.extractedEntities,
                    toolsInvoked,
                    debugSteps,
                    errors,
                    stepCounter
                ).then(({ answer, stepCounter: sc }) => {
                    stepCounter = sc;
                    return answer;
                });
                break;

            case "software_and_knowledge":
                // MULTI-STEP: Check entitlement first, then query RAG for related policies
                answer = await handleSoftwareAndKnowledge(
                    request.employeeId,
                    request.message,
                    intentResult.extractedEntities,
                    toolsInvoked,
                    ragContext,
                    debugSteps,
                    errors,
                    stepCounter
                ).then(({ answer, stepCounter: sc }) => {
                    stepCounter = sc;
                    return answer;
                });
                break;

            case "knowledge_query":
                answer = await handleKnowledgeQuery(
                    request.message,
                    ragContext,
                    debugSteps,
                    errors,
                    stepCounter
                ).then(({ answer, stepCounter: sc }) => {
                    stepCounter = sc;
                    return answer;
                });
                break;

            case "unknown":
            default:
                // Even for unknown intents, try RAG as a fallback
                // WHY? The user might ask about something the handbook covers,
                // phrased in a way our keyword patterns don't catch.
                answer = await handleKnowledgeQuery(
                    request.message,
                    ragContext,
                    debugSteps,
                    errors,
                    stepCounter
                ).then(({ answer, stepCounter: sc }) => {
                    stepCounter = sc;
                    return answer;
                });

                if (ragContext.length === 0) {
                    answer = "I'm not sure how to help with that. I can assist with:\n" +
                        "• IT policy questions (VPN, passwords, hardware, software)\n" +
                        "• Viewing or creating support tickets\n" +
                        "• Checking software entitlements\n\n" +
                        "Could you rephrase your question?";
                }
                break;
        }
    } catch (error) {
        const errMsg = `Orchestration error: ${(error as Error).message}`;
        errors.push(errMsg);
        logJson("orchestration_error", { requestId, error: errMsg });
        answer = "I encountered an error processing your request. Please try again, " +
            "or contact IT Support directly at ext. 4357 (HELP).";
    }

    const totalLatency = Date.now() - startTime;

    logJson("orchestration_complete", {
        requestId,
        intent: intentResult.intent,
        toolsInvoked: toolsInvoked.map((t) => t.tool),
        ragResultCount: ragContext.length,
        errorCount: errors.length,
        totalLatencyMs: totalLatency,
    });

    const response: ChatResponse = {
        requestId,
        answer,
        tools_invoked: toolsInvoked,
        rag_context: ragContext,
        errors,
    };

    const debugTrace: DebugTrace = {
        requestId,
        query: request.message,
        employeeId: request.employeeId,
        intent: intentResult,
        steps: debugSteps,
        totalLatencyMs: totalLatency,
        timestamp: new Date().toISOString(),
    };

    return { response, debugTrace };
}

// ---------------------------------------------------------------------------
// Intent Handlers
// Each handler is responsible for a specific intent and uses the appropriate
// tools and/or RAG calls to build a response.
// ---------------------------------------------------------------------------

async function handleCheckTickets(
    employeeId: string,
    toolsInvoked: ToolInvocation[],
    debugSteps: DebugStep[],
    errors: string[],
    stepCounter: number
): Promise<{ answer: string; stepCounter: number }> {
    const startTime = Date.now();

    const result = await getEmployeeTickets(employeeId);
    const latency = Date.now() - startTime;

    toolsInvoked.push({
        tool: "getEmployeeTickets",
        args: { employeeId },
        result,
        latencyMs: latency,
    });

    debugSteps.push({
        step: ++stepCounter,
        action: "tool_call: getEmployeeTickets",
        input: { employeeId },
        output: result,
        latencyMs: latency,
    });

    if (!result.success) {
        errors.push(result.message);
        return {
            answer: `I couldn't find employee ${employeeId} in our system. Please verify your employee ID.`,
            stepCounter,
        };
    }

    if (result.tickets.length === 0) {
        return {
            answer: `Good news! You don't have any open support tickets, ${employeeId}.`,
            stepCounter,
        };
    }

    const ticketList = result.tickets
        .map(
            (t: Ticket) =>
                `• **${t.ticketId}** — ${t.subject} (${t.priority}, ${t.status})\n  Created: ${t.createdAt}`
        )
        .join("\n");

    return {
        answer: `Here are your support tickets, ${employeeId}:\n\n${ticketList}`,
        stepCounter,
    };
}

async function handleCreateTicket(
    employeeId: string,
    message: string,
    entities: Record<string, string>,
    toolsInvoked: ToolInvocation[],
    debugSteps: DebugStep[],
    errors: string[],
    stepCounter: number
): Promise<{ answer: string; stepCounter: number }> {
    // Extract ticket details from the message or use defaults
    const subject = entities.subject || extractSubjectFromMessage(message);
    const priority = (entities.priority as "P1" | "P2" | "P3" | "P4") || "P3";
    const description = message;

    const startTime = Date.now();

    const result = await createSupportTicket(employeeId, subject, description, priority);
    const latency = Date.now() - startTime;

    toolsInvoked.push({
        tool: "createSupportTicket",
        args: { employeeId, subject, description, priority },
        result,
        latencyMs: latency,
    });

    debugSteps.push({
        step: ++stepCounter,
        action: "tool_call: createSupportTicket",
        input: { employeeId, subject, description, priority },
        output: result,
        latencyMs: latency,
    });

    if (!result.success) {
        errors.push(result.message);
        return {
            answer: `I wasn't able to create the ticket. ${result.message}`,
            stepCounter,
        };
    }

    return {
        answer: `✅ Ticket created successfully!\n\n` +
            `• **Ticket ID**: ${result.ticket!.ticketId}\n` +
            `• **Subject**: ${subject}\n` +
            `• **Priority**: ${priority}\n` +
            `• **Status**: Open\n\n` +
            `You can reference this ticket ID for follow-ups.`,
        stepCounter,
    };
}

async function handleCheckSoftware(
    employeeId: string,
    entities: Record<string, string>,
    toolsInvoked: ToolInvocation[],
    debugSteps: DebugStep[],
    errors: string[],
    stepCounter: number
): Promise<{ answer: string; stepCounter: number }> {
    const softwareName = entities.softwareName || "unknown";

    if (softwareName === "unknown") {
        return {
            answer: "I'd like to check your software entitlement, but I couldn't determine " +
                "which software you're asking about. Could you specify the software name? " +
                'For example: "Do I have access to Photoshop?"',
            stepCounter,
        };
    }

    const startTime = Date.now();
    const result = await checkSoftwareEntitlement(employeeId, softwareName);
    const latency = Date.now() - startTime;

    toolsInvoked.push({
        tool: "checkSoftwareEntitlement",
        args: { employeeId, softwareName },
        result,
        latencyMs: latency,
    });

    debugSteps.push({
        step: ++stepCounter,
        action: "tool_call: checkSoftwareEntitlement",
        input: { employeeId, softwareName },
        output: result,
        latencyMs: latency,
    });

    if (!result.success) {
        errors.push(result.message);
        return { answer: result.message, stepCounter };
    }

    return { answer: result.message, stepCounter };
}

/**
 * MULTI-STEP HANDLER: Software + Knowledge.
 *
 * This demonstrates multi-step reasoning:
 *   Step 1: Check if the employee has the software entitlement.
 *   Step 2: Query RAG for related IT policies (e.g., how to request software).
 *   Step 3: Combine both results into a comprehensive response.
 *
 * Example flow:
 *   User: "How do I get Photoshop?"
 *   → Step 1: checkSoftwareEntitlement("EMP001", "Photoshop") → NOT entitled
 *   → Step 2: RAG query "software access request" → returns handbook section
 *   → Step 3: "You're not entitled to Photoshop. Here's how to request it: ..."
 */
async function handleSoftwareAndKnowledge(
    employeeId: string,
    message: string,
    entities: Record<string, string>,
    toolsInvoked: ToolInvocation[],
    ragContext: RAGQueryResult[],
    debugSteps: DebugStep[],
    errors: string[],
    stepCounter: number
): Promise<{ answer: string; stepCounter: number }> {
    const softwareName = entities.softwareName || "software";
    let answerParts: string[] = [];

    // Step 1: Check entitlement
    const entitlementStart = Date.now();
    const entitlementResult = await checkSoftwareEntitlement(employeeId, softwareName);
    const entitlementLatency = Date.now() - entitlementStart;

    toolsInvoked.push({
        tool: "checkSoftwareEntitlement",
        args: { employeeId, softwareName },
        result: entitlementResult,
        latencyMs: entitlementLatency,
    });

    debugSteps.push({
        step: ++stepCounter,
        action: "tool_call: checkSoftwareEntitlement (multi-step 1/2)",
        input: { employeeId, softwareName },
        output: entitlementResult,
        latencyMs: entitlementLatency,
    });

    if (entitlementResult.success) {
        answerParts.push(`**Entitlement Check**: ${entitlementResult.message}`);
    } else {
        errors.push(entitlementResult.message);
    }

    // Step 2: Query RAG for relevant policies
    const ragStart = Date.now();
    const ragResult = await queryRAG(`${softwareName} software access request install`, 3);
    const ragLatency = Date.now() - ragStart;

    debugSteps.push({
        step: ++stepCounter,
        action: "rag_query (multi-step 2/2)",
        input: { query: `${softwareName} software access request install`, topK: 3 },
        output: ragResult,
        latencyMs: ragLatency,
    });

    if (ragResult.success && ragResult.data) {
        ragContext.push(...ragResult.data.results);
        if (ragResult.data.results.length > 0) {
            const topChunk = ragResult.data.results[0];
            answerParts.push(
                `\n**From the IT Handbook**:\n${topChunk.chunk}\n\n` +
                `_(Relevance score: ${topChunk.score.toFixed(4)})_`
            );
        }
    } else {
        errors.push(ragResult.error || "RAG query failed");
        answerParts.push(
            "\n_Note: I couldn't search the IT Handbook right now, but you can try " +
            "the Software Access Portal at https://software.acme-corp.internal._"
        );
    }

    return {
        answer: answerParts.join("\n\n"),
        stepCounter,
    };
}

/**
     * COMPOUND QUERY HANDLER: Knowledge + Ticket Check + Conditional Ticket Creation.
     *
     * This is the showcase handler for the spec's example query:
     *   "My VPN keeps disconnecting when I switch to Wi-Fi. What does the IT handbook say
     *    about VPN troubleshooting? Also, can you check if I have any open tickets already,
     *    and if not, create a new one for me with priority 'High'."
     *
     * WHY THREE STEPS IN SEQUENCE?
     *   Step 1 (RAG): Retrieve IT handbook content about the topic → provides immediate value.
     *   Step 2 (Check tickets): Look up existing tickets → prevents duplicate creation.
     *   Step 3 (Conditional create): Only create a new ticket if no relevant open ticket exists.
     *   This sequence mimics how a human L1 support agent would handle the request.
     *
     * WHY CONDITIONAL LOGIC? Creating duplicate tickets wastes support bandwidth.
     * A smart agent checks first, then acts — demonstrating agentic reasoning.
     */
async function handleCompoundQuery(
    employeeId: string,
    message: string,
    entities: Record<string, string>,
    toolsInvoked: ToolInvocation[],
    ragContext: RAGQueryResult[],
    debugSteps: DebugStep[],
    errors: string[],
    stepCounter: number
): Promise<{ answer: string; stepCounter: number }> {
    const answerParts: string[] = [];

    // --- Step 1: Query RAG for knowledge content ---
    const ragStart = Date.now();
    const ragResult = await queryRAG(message, 3);
    const ragLatency = Date.now() - ragStart;

    debugSteps.push({
        step: ++stepCounter,
        action: "rag_query (compound step 1/3: knowledge retrieval)",
        input: { query: message, topK: 3 },
        output: ragResult,
        latencyMs: ragLatency,
    });

    if (ragResult.success && ragResult.data && ragResult.data.results.length > 0) {
        ragContext.push(...ragResult.data.results);
        const topChunk = ragResult.data.results[0];
        answerParts.push(
            `**From the IT Handbook:**\n${topChunk.chunk}\n\n` +
            `_(Relevance score: ${topChunk.score.toFixed(4)})_`
        );
    } else {
        if (ragResult.error) errors.push(ragResult.error);
        answerParts.push(
            "I couldn't find specific handbook content for your issue, " +
            "but I'll still check your tickets below."
        );
    }

    // --- Step 2: Check existing tickets ---
    const ticketCheckStart = Date.now();
    const ticketResult = await getEmployeeTickets(employeeId);
    const ticketCheckLatency = Date.now() - ticketCheckStart;

    toolsInvoked.push({
        tool: "getEmployeeTickets",
        args: { employeeId },
        result: ticketResult,
        latencyMs: ticketCheckLatency,
    });

    debugSteps.push({
        step: ++stepCounter,
        action: "tool_call: getEmployeeTickets (compound step 2/3: check existing)",
        input: { employeeId },
        output: ticketResult,
        latencyMs: ticketCheckLatency,
    });

    // Check if any existing ticket matches the topic of the query
    const queryKeywords = message.toLowerCase().split(/\s+/);
    const relevantKeywords = queryKeywords.filter((w) =>
        ["vpn", "password", "network", "wifi", "laptop", "email", "printer", "software"].includes(w)
    );

    let hasMatchingTicket = false;
    if (ticketResult.success && ticketResult.tickets.length > 0) {
        // Look for an existing open ticket that matches the topic
        const matchingTicket = ticketResult.tickets.find((t: Ticket) => {
            const subjectLower = t.subject.toLowerCase();
            return (
                t.status === "Open" &&
                relevantKeywords.some((kw) => subjectLower.includes(kw))
            );
        });

        if (matchingTicket) {
            hasMatchingTicket = true;
            answerParts.push(
                `**Existing Ticket Found:**\n` +
                `You already have an open ticket about this issue:\n` +
                `• **${matchingTicket.ticketId}** — ${matchingTicket.subject} ` +
                `(${matchingTicket.priority}, ${matchingTicket.status})\n\n` +
                `No duplicate ticket was created. You can reference this ticket for follow-ups.`
            );
        } else {
            answerParts.push(
                `**Ticket Check:** You have ${ticketResult.tickets.length} existing ticket(s), ` +
                `but none match this issue.`
            );
        }
    } else if (ticketResult.success) {
        answerParts.push(`**Ticket Check:** You have no existing tickets.`);
    } else {
        errors.push(ticketResult.message);
    }

    // --- Step 3: Conditionally create a new ticket ---
    if (!hasMatchingTicket) {
        const subject = entities.subject || extractSubjectFromMessage(message);
        const priority = (entities.priority as "P1" | "P2" | "P3" | "P4") || "P2";

        const createStart = Date.now();
        const createResult = await createSupportTicket(employeeId, subject, message, priority);
        const createLatency = Date.now() - createStart;

        toolsInvoked.push({
            tool: "createSupportTicket",
            args: { employeeId, subject, priority },
            result: createResult,
            latencyMs: createLatency,
        });

        debugSteps.push({
            step: ++stepCounter,
            action: "tool_call: createSupportTicket (compound step 3/3: conditional create)",
            input: { employeeId, subject, description: message, priority },
            output: createResult,
            latencyMs: createLatency,
        });

        if (createResult.success) {
            answerParts.push(
                `**New Ticket Created:**\n` +
                `✅ **${createResult.ticket!.ticketId}** — ${subject}\n` +
                `• Priority: ${priority}\n` +
                `• Status: Open\n` +
                `• Assigned to L1 Support`
            );
        } else {
            errors.push(createResult.message);
            answerParts.push(`⚠️ Could not create ticket: ${createResult.message}`);
        }
    }

    return {
        answer: answerParts.join("\n\n"),
        stepCounter,
    };
}

async function handleKnowledgeQuery(
    message: string,
    ragContext: RAGQueryResult[],
    debugSteps: DebugStep[],
    errors: string[],
    stepCounter: number
): Promise<{ answer: string; stepCounter: number }> {
    const ragStart = Date.now();
    const ragResult = await queryRAG(message, 3);
    const ragLatency = Date.now() - ragStart;

    debugSteps.push({
        step: ++stepCounter,
        action: "rag_query",
        input: { query: message, topK: 3 },
        output: ragResult,
        latencyMs: ragLatency,
    });

    if (!ragResult.success) {
        errors.push(ragResult.error || "RAG service unavailable");
        return {
            answer: "I'm having trouble accessing the IT Handbook right now. " +
                "Please try again in a moment, or contact IT Support at ext. 4357.",
            stepCounter,
        };
    }

    if (!ragResult.data || ragResult.data.results.length === 0) {
        return {
            answer: "I searched the IT Handbook but couldn't find relevant information " +
                "for your question. Could you rephrase it, or would you like to create " +
                "a support ticket instead?",
            stepCounter,
        };
    }

    ragContext.push(...ragResult.data.results);

    // Build answer from top RAG results
    const topResult = ragResult.data.results[0];
    const additionalContext = ragResult.data.results
        .slice(1)
        .filter((r) => r.score > 0.1)  // Only include results above a relevance threshold
        .map((r) => `— ${r.chunk}`)
        .join("\n\n");

    let answer = `**From the IT Handbook:**\n\n${topResult.chunk}`;
    if (additionalContext) {
        answer += `\n\n**Related Information:**\n${additionalContext}`;
    }
    answer += `\n\n_(Search relevance: ${topResult.score.toFixed(4)})_`;

    return { answer, stepCounter };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractSubjectFromMessage(message: string): string {
    // Try to create a reasonable subject from the user's message
    // WHY TRUNCATE AT 80 CHARS? Ticket subjects in ITSM tools (ServiceNow,
    // Jira) typically have a 200-char limit. 80 is a readable preview length.
    const cleaned = message
        .replace(/create\s+(a\s+)?ticket\s*(about|for|regarding)?/i, "")
        .replace(/please\s*/i, "")
        .trim();

    return cleaned.length > 80
        ? cleaned.substring(0, 77) + "..."
        : cleaned || "General Support Request";
}
