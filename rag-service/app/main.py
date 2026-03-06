"""
DeskMate RAG Service - FastAPI Application.

This service handles the Retrieval-Augmented Generation (RAG) pipeline:
  1. Ingests the IT Handbook by chunking + embedding + FAISS indexing.
  2. Accepts semantic search queries and returns ranked chunks.
  3. Exposes a health endpoint for service monitoring.

All operations are in-memory with mock embeddings, making this fully
self-contained with zero external dependencies (no API keys, no DB).
"""

import json
import logging
import os
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.chunking import chunk_text
from app.embeddings import generate_embedding
from app.vector_store import vector_store

# ---------------------------------------------------------------------------
# Structured JSON Logging
# WHY JSON LOGGING? In a containerized/microservices environment, structured
# logs are parseable by log aggregation tools (ELK, Datadog, CloudWatch).
# Human-readable logs are great for dev but terrible for observability at scale.
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",  # We handle formatting ourselves for JSON output
)
logger = logging.getLogger("rag-service")


def log_json(event: str, **kwargs):
    """Emit a structured JSON log entry."""
    entry = {
        "service": "rag-service",
        "event": event,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        **kwargs,
    }
    logger.info(json.dumps(entry))


# ---------------------------------------------------------------------------
# Pydantic Models
# ---------------------------------------------------------------------------

class QueryRequest(BaseModel):
    """Request body for the /rag/query endpoint."""
    query: str = Field(..., min_length=1, description="The search query text")
    top_k: int = Field(default=3, ge=1, le=20, description="Number of results to return")


class IngestResponse(BaseModel):
    """Response from the /rag/ingest endpoint."""
    status: str
    chunks_created: int
    source_file: str


class QueryResult(BaseModel):
    """A single search result from the vector store."""
    chunk: str
    score: float
    similarity: float = 0.0  # Alias of score for spec compliance
    source: str = "IT_Handbook.txt"  # Source document identifier
    index: int


class QueryResponse(BaseModel):
    """Response from the /rag/query endpoint."""
    query: str
    results: list[QueryResult]
    latency_ms: float


class HealthResponse(BaseModel):
    """Response from the /rag/health endpoint."""
    status: str
    vector_store: dict


# ---------------------------------------------------------------------------
# Application Lifecycle
# WHY LIFESPAN? FastAPI's lifespan context manager is the recommended way
# to handle startup/shutdown tasks. We auto-ingest the handbook on startup
# so the service is ready to serve queries immediately.
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Auto-ingest the IT Handbook on startup for immediate availability."""
    log_json("startup", message="RAG service starting up")
    try:
        _perform_ingestion()
        log_json("startup_complete", message="IT Handbook auto-ingested on startup")
    except Exception as e:
        log_json("startup_warning", message=f"Auto-ingest failed: {e}. Use POST /rag/ingest manually.")
    yield
    log_json("shutdown", message="RAG service shutting down")


app = FastAPI(
    title="DeskMate RAG Service",
    description="Retrieval-Augmented Generation service for IT Help Desk knowledge base",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — Allow the orchestrator and frontend to make requests
# WHY BROAD CORS? In a Docker Compose network, services communicate via
# internal hostnames. But during local development, the frontend runs on
# a different port. Broad CORS is acceptable here since this is an internal
# microservice, not a public API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------------------------

def _get_handbook_path() -> str:
    """
    Resolve the path to the IT Handbook.
    WHY ENVIRONMENT VARIABLE? In Docker, the data volume is mounted at a
    different path than on the host. An env var lets us configure the path
    per environment without changing code.

    FALLBACK LOGIC: If no env var is set, we try to find the handbook
    relative to this script's location (../data/IT_Handbook.txt), which
    works for local development on any OS. The Docker default is only
    used if the env var is explicitly set.
    """
    env_path = os.environ.get("HANDBOOK_PATH")
    if env_path:
        return env_path

    # Auto-resolve relative to the project structure: rag-service/app/main.py → ../../data/
    script_dir = os.path.dirname(os.path.abspath(__file__))
    local_path = os.path.join(script_dir, "..", "..", "data", "IT_Handbook.txt")
    local_path = os.path.normpath(local_path)
    if os.path.exists(local_path):
        return local_path

    # Final fallback: Docker path
    return "/app/data/IT_Handbook.txt"


def _perform_ingestion() -> int:
    """
    Read the IT Handbook, chunk it, generate embeddings, and build the FAISS index.
    Returns the number of chunks ingested.
    """
    handbook_path = _get_handbook_path()
    log_json("ingest_start", path=handbook_path)

    if not os.path.exists(handbook_path):
        raise FileNotFoundError(f"Handbook not found at: {handbook_path}")

    with open(handbook_path, "r", encoding="utf-8") as f:
        raw_text = f.read()

    # Step 1: Chunk the text
    start_time = time.time()
    chunks = chunk_text(raw_text)
    chunk_time = (time.time() - start_time) * 1000

    log_json("chunking_complete", chunk_count=len(chunks), latency_ms=round(chunk_time, 2))

    # Step 2: Generate embeddings for all chunks
    embed_start = time.time()
    embeddings = np.array([generate_embedding(chunk) for chunk in chunks], dtype=np.float32)
    embed_time = (time.time() - embed_start) * 1000

    log_json("embedding_complete", chunk_count=len(chunks), latency_ms=round(embed_time, 2))

    # Step 3: Build the FAISS index
    index_start = time.time()
    count = vector_store.build_index(chunks, embeddings)
    index_time = (time.time() - index_start) * 1000

    log_json("index_built", chunk_count=count, latency_ms=round(index_time, 2))

    return count


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/rag/ingest", response_model=IngestResponse)
async def ingest():
    """
    Ingest the IT Handbook: read → chunk → embed → index.

    This endpoint is idempotent — calling it multiple times rebuilds the index
    from scratch, which is useful during development when the handbook changes.
    """
    try:
        count = _perform_ingestion()
        log_json("ingest_success", chunks_created=count)
        return IngestResponse(
            status="success",
            chunks_created=count,
            source_file=_get_handbook_path(),
        )
    except FileNotFoundError as e:
        log_json("ingest_error", error=str(e))
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        log_json("ingest_error", error=str(e))
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")


@app.post("/rag/query", response_model=QueryResponse)
async def query(request: QueryRequest):
    """
    Perform semantic search against the ingested IT Handbook.

    Accepts a natural language query and returns the top_k most relevant
    chunks with their similarity scores.
    """
    start_time = time.time()

    try:
        # Generate embedding for the query using the same mock function
        query_embedding = generate_embedding(request.query)

        # Search the FAISS index
        results = vector_store.search(query_embedding, top_k=request.top_k)

        latency_ms = round((time.time() - start_time) * 1000, 2)

        # Structured logging: log every query with full details
        log_json(
            "query_executed",
            query=request.query,
            top_k=request.top_k,
            results_returned=len(results),
            latency_ms=latency_ms,
            chunks_retrieved=[
                {"index": r["index"], "score": round(r["score"], 4), "preview": r["chunk"][:80]}
                for r in results
            ],
        )

        return QueryResponse(
            query=request.query,
            results=[
                QueryResult(**r, similarity=r["score"], source="IT_Handbook.txt")
                for r in results
            ],
            latency_ms=latency_ms,
        )
    except RuntimeError as e:
        log_json("query_error", error=str(e), query=request.query)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log_json("query_error", error=str(e), query=request.query)
        raise HTTPException(status_code=500, detail=f"Query failed: {str(e)}")


@app.post("/rag/health", response_model=HealthResponse)
async def health():
    """
    Health check endpoint for the RAG service.

    Returns the current state of the vector store, including whether it's
    been initialized and how many chunks are indexed.
    """
    status = vector_store.get_status()
    log_json("health_check", **status)
    return HealthResponse(
        status="healthy" if status["is_initialized"] else "not_initialized",
        vector_store=status,
    )
