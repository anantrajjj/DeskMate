/**
 * RAG Service Client.
 *
 * Handles HTTP communication with the Python RAG microservice.
 * Encapsulates error handling, timeouts, and response parsing so the
 * orchestrator logic stays clean.
 *
 * WHY A SEPARATE CLIENT?
 * Separating API communication into its own module follows the
 * "Gateway" or "Adapter" pattern. If the RAG service's API changes
 * (e.g., different endpoints, response format), we only update this file.
 */

import axios, { AxiosError } from "axios";
import { logJson } from "./logger";

// Configurable via environment variable for Docker networking
const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";

// Request timeout: 10 seconds is generous for a local FAISS search
// WHY 10s? In-memory FAISS search is <10ms, but we add buffer for network
// latency in Docker and the embedding computation step.
const REQUEST_TIMEOUT = 10_000;

export interface RAGQueryResult {
    chunk: string;
    score: number;
    index: number;
}

export interface RAGQueryResponse {
    query: string;
    results: RAGQueryResult[];
    latency_ms: number;
}

export interface RAGHealthResponse {
    status: string;
    vector_store: {
        is_initialized: boolean;
        total_chunks: number;
        embedding_dimension: number;
        index_type: string;
    };
}

/**
 * Query the RAG service for relevant IT Handbook chunks.
 */
export async function queryRAG(
    query: string,
    topK: number = 3
): Promise<{ success: boolean; data?: RAGQueryResponse; error?: string }> {
    const startTime = Date.now();

    try {
        logJson("rag_query_start", { query, topK, ragUrl: RAG_SERVICE_URL });

        const response = await axios.post<RAGQueryResponse>(
            `${RAG_SERVICE_URL}/rag/query`,
            { query, top_k: topK },
            { timeout: REQUEST_TIMEOUT }
        );

        const latency = Date.now() - startTime;
        logJson("rag_query_complete", {
            query,
            resultsReturned: response.data.results.length,
            latencyMs: latency,
        });

        return { success: true, data: response.data };
    } catch (error) {
        const latency = Date.now() - startTime;
        const errMsg = error instanceof AxiosError
            ? `RAG service error: ${error.response?.status} - ${error.response?.data?.detail || error.message}`
            : `RAG service error: ${(error as Error).message}`;

        logJson("rag_query_error", { query, error: errMsg, latencyMs: latency });
        return { success: false, error: errMsg };
    }
}

/**
 * Check RAG service health status.
 */
export async function checkRAGHealth(): Promise<{
    success: boolean;
    data?: RAGHealthResponse;
    error?: string;
}> {
    try {
        const response = await axios.post<RAGHealthResponse>(
            `${RAG_SERVICE_URL}/rag/health`,
            {},
            { timeout: 5_000 }
        );
        return { success: true, data: response.data };
    } catch (error) {
        const errMsg = error instanceof AxiosError
            ? `RAG health check failed: ${error.message}`
            : `RAG health check failed: ${(error as Error).message}`;
        logJson("rag_health_error", { error: errMsg });
        return { success: false, error: errMsg };
    }
}

/**
 * Trigger handbook ingestion on the RAG service.
 */
export async function triggerRAGIngest(): Promise<{
    success: boolean;
    chunksIngested?: number;
    error?: string;
}> {
    try {
        const response = await axios.post(
            `${RAG_SERVICE_URL}/rag/ingest`,
            {},
            { timeout: 30_000 }  // Ingestion can take longer
        );
        return { success: true, chunksIngested: response.data.chunks_ingested };
    } catch (error) {
        const errMsg = error instanceof AxiosError
            ? `RAG ingest failed: ${error.message}`
            : `RAG ingest failed: ${(error as Error).message}`;
        return { success: false, error: errMsg };
    }
}
