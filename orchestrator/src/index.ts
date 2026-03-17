/**
 * DeskMate Orchestrator Service - Express Entry Point.
 *
 * This is the HTTP layer that exposes the orchestration engine via REST endpoints.
 * It handles:
 *   - POST /api/chat — Main chat endpoint (user message → AI response)
 *   - POST /api/debug — Returns the last debug trace for inspection
 *   - GET /api/health — Service health check
 *
 * WHY EXPRESS?
 * Express is the most widely-used Node.js HTTP framework, with a massive
 * ecosystem and minimal learning curve. For an orchestration service that
 * primarily proxies to other services, Express's simplicity is ideal.
 * Fastify would offer slightly better performance but adds complexity
 * unnecessary for this use case.
 */

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { orchestrate, ChatRequest, ChatResponse, DebugTrace } from "./orchestrator";
import { checkRAGHealth } from "./ragClient";
import { logJson } from "./logger";

const app = express();
// Hardcode to 3001. Azure Container Apps injects PORT=80 which causes
// a mismatch with the expected Ingress Target Port (3001) causing crash loops.
const PORT = 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
    logJson("http_request", {
        method: req.method,
        path: req.path,
        body: req.method === "POST" ? req.body : undefined,
    });
    next();
});

// ---------------------------------------------------------------------------
// In-Memory Debug Trace Store
// WHY IN-MEMORY? This is a debugging tool for development. In production,
// traces would go to a distributed tracing system (Jaeger, Zipkin, Datadog).
// We keep the last 100 traces in memory for the /api/debug endpoint.
// ---------------------------------------------------------------------------
const debugTraces: DebugTrace[] = [];
const MAX_TRACES = 100;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/chat
 * Main chat endpoint. Accepts a user message and employee ID, orchestrates
 * the response using intent parsing, RAG, and tools, and returns structured JSON.
 */
app.post("/api/chat", async (req: Request, res: Response) => {
    try {
        const { message, employeeId } = req.body as ChatRequest;

        // Input validation
        if (!message || typeof message !== "string") {
            res.status(400).json({
                error: "Missing or invalid 'message' field. Expected a non-empty string.",
            });
            return;
        }

        if (!employeeId || typeof employeeId !== "string") {
            res.status(400).json({
                error: "Missing or invalid 'employeeId' field. Expected a non-empty string.",
            });
            return;
        }

        // Run the orchestration engine
        const { response, debugTrace } = await orchestrate({ message, employeeId });

        // Store the debug trace
        debugTraces.push(debugTrace);
        if (debugTraces.length > MAX_TRACES) {
            debugTraces.shift(); // Remove the oldest trace
        }

        logJson("chat_response_sent", {
            requestId: response.requestId,
            intent: debugTrace.intent.intent,
            toolCount: response.tools_invoked.length,
            ragChunks: response.rag_context.length,
            errorCount: response.errors.length,
        });

        res.json(response);
    } catch (error) {
        const errMsg = `Internal server error: ${(error as Error).message}`;
        logJson("chat_error", { error: errMsg, stack: (error as Error).stack });
        res.status(500).json({
            requestId: "error",
            answer: "An internal error occurred. Please try again.",
            tools_invoked: [],
            rag_context: [],
            errors: [errMsg],
        });
    }
});

/**
 * POST /api/debug
 * Returns a verbose step-by-step execution trace of the most recent request,
 * or a specific request by requestId.
 *
 * WHY POST? We accept an optional body with { requestId } for querying a
 * specific trace. GET with query params would also work, but POST is
 * consistent with the other endpoints.
 */
app.post("/api/debug", (req: Request, res: Response) => {
    try {
        const { requestId } = req.body || {};

        if (requestId) {
            // Find a specific trace
            const trace = debugTraces.find((t) => t.requestId === requestId);
            if (!trace) {
                res.status(404).json({
                    error: `No debug trace found for requestId: ${requestId}`,
                    availableTraces: debugTraces.length,
                });
                return;
            }
            res.json(trace);
            return;
        }

        // Return the most recent trace
        if (debugTraces.length === 0) {
            res.json({
                message: "No debug traces available. Send a chat message first.",
                totalTraces: 0,
            });
            return;
        }

        res.json({
            latestTrace: debugTraces[debugTraces.length - 1],
            totalTraces: debugTraces.length,
        });
    } catch (error) {
        res.status(500).json({
            error: `Debug endpoint error: ${(error as Error).message}`,
        });
    }
});

/**
 * GET /api/health
 * Health check for the orchestrator and its downstream dependency (RAG service).
 */
app.get("/api/health", async (_req: Request, res: Response) => {
    const ragHealth = await checkRAGHealth();

    const status = {
        service: "orchestrator",
        status: "healthy",
        uptime: process.uptime(),
        ragService: ragHealth.success
            ? { status: "healthy", details: ragHealth.data }
            : { status: "unhealthy", error: ragHealth.error },
    };

    res.json(status);
});

// ---------------------------------------------------------------------------
// Error Handling Middleware
// WHY A CATCH-ALL? Express doesn't catch async errors by default.
// This ensures any unhandled promise rejections return a proper 500
// instead of crashing the process.
// ---------------------------------------------------------------------------
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logJson("unhandled_error", {
        error: err.message,
        stack: err.stack,
    });
    res.status(500).json({
        error: "An unexpected error occurred.",
        message: err.message,
    });
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
    logJson("server_started", {
        port: PORT,
        environment: process.env.NODE_ENV || "development",
        ragServiceUrl: process.env.RAG_SERVICE_URL || "http://localhost:8000",
    });
    console.log(`\n🤖 DeskMate Orchestrator running on http://localhost:${PORT}`);
    console.log(`   → POST /api/chat    - Chat with the AI assistant`);
    console.log(`   → POST /api/debug   - View execution traces`);
    console.log(`   → GET  /api/health  - Service health check\n`);
});

export default app;
