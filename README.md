# DeskMate — AI IT Help Desk Assistant

A dual-language, microservices-based AI IT Help Desk Assistant that combines a **Python RAG service** (FastAPI + FAISS) with a **TypeScript orchestration layer** (Express + custom intent parsing) and a **React frontend**.

![Architecture](https://img.shields.io/badge/Architecture-Microservices-blue)
![Python](https://img.shields.io/badge/Python-3.10+-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![React](https://img.shields.io/badge/React-18-61dafb)

---

## 🏗️ Architecture Overview

```
┌────────────┐     ┌──────────────────┐     ┌────────────────┐
│            │     │                  │     │                │
│  Frontend  │────▶│  Orchestrator    │────▶│  RAG Service   │
│  (React)   │     │  (Express/TS)    │     │  (FastAPI/Py)  │
│  :3000     │     │  :3001           │     │  :8000         │
│            │     │                  │     │                │
│  • Chat UI │     │  • Intent Parse  │     │  • Ingest      │
│  • Debug   │     │  • Tool Calls    │     │  • Embed       │
│  • Activity│     │  • RAG Query     │     │  • FAISS Search│
│            │     │  • Response Asm  │     │                │
└────────────┘     └──────────────────┘     └────────────────┘
                           │
                     ┌─────┴─────┐
                     │ Mock Tools│
                     │           │
                     │ • Tickets │
                     │ • Software│
                     │ • Entitle.│
                     └───────────┘
```

### Data Flow

1. **User** sends a message via the React frontend.
2. **Orchestrator** parses the intent using keyword-based classification.
3. Based on intent, the orchestrator:
   - Calls **RAG Service** for IT policy knowledge queries.
   - Calls **Mock Tools** for ticket management or entitlement checks.
   - Performs **multi-step reasoning** (e.g., check entitlement → then query RAG for how to request access).
4. Response is assembled with `answer`, `tools_invoked`, `rag_context`, and `errors`.
5. **Frontend** renders the response with activity indicators and debug trace toggle.

---

## 🚀 Quick Start

### Prerequisites

- **Docker & Docker Compose** (recommended)
- OR: **Node.js 18+**, **Python 3.10+**, **pip**

### Option 1: Docker Compose (Recommended)

```bash
cd deskmate
docker-compose up --build
```

Services will be available at:
| Service       | URL                         |
|---------------|-----------------------------|
| Frontend      | http://localhost:3000        |
| Orchestrator  | http://localhost:3001        |
| RAG Service   | http://localhost:8000        |

### Option 2: Local Development

#### 1. Start the RAG Service

```bash
cd rag-service
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Set the handbook path (if not using the default):
```bash
# Windows
set HANDBOOK_PATH=../data/IT_Handbook.txt

# Linux/macOS
export HANDBOOK_PATH=../data/IT_Handbook.txt
```

#### 2. Start the Orchestrator

```bash
cd orchestrator
npm install
npm run dev
```

#### 3. Start the Frontend

```bash
cd frontend
npm install
npm run dev
```

---

## 📋 API Reference

### RAG Service (`:8000`)

| Endpoint         | Method | Body                              | Description                          |
|------------------|--------|-----------------------------------|--------------------------------------|
| `/rag/ingest`    | POST   | _(none)_                          | Ingest IT_Handbook.txt into FAISS    |
| `/rag/query`     | POST   | `{ "query": str, "top_k": int }` | Semantic search over handbook        |
| `/rag/health`    | POST   | _(none)_                          | Vector store status                  |

### Orchestrator (`:3001`)

| Endpoint       | Method | Body                                        | Description                  |
|----------------|--------|---------------------------------------------|------------------------------|
| `/api/chat`    | POST   | `{ "message": str, "employeeId": str }`     | Chat with the AI assistant   |
| `/api/debug`   | POST   | `{ "requestId"?: str }` _(optional)_        | Get execution trace          |
| `/api/health`  | GET    | _(none)_                                    | Service + RAG health status  |

### Example Chat Request

```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "How do I reset my password?", "employeeId": "EMP001"}'
```

### Example Response

```json
{
  "requestId": "abc-123",
  "answer": "**From the IT Handbook:**\n\nAll corporate passwords must...",
  "tools_invoked": [],
  "rag_context": [
    { "chunk": "All corporate passwords must...", "score": 0.4231, "index": 1 }
  ],
  "errors": []
}
```

---

## 📚 RAG Pipeline Explanation

### What is RAG?

**Retrieval-Augmented Generation (RAG)** combines document retrieval with AI response generation. Instead of relying solely on a language model's training data, RAG first searches a knowledge base for relevant information, then uses that context to generate accurate, grounded answers.

### Our Implementation

1. **Ingestion**: `IT_Handbook.txt` is split into chunks using paragraph-based splitting with **1000-char** limit and **100-char** overlap. Special regex `(?<=[.!?\n])\s+` ensures bullet points and newlines are preserved.
2. **Embedding**: Each chunk is converted to a 128-dimensional vector using a deterministic hash-based embedding function (mock — no API keys needed).
3. **Indexing**: Embeddings are stored in a FAISS IndexFlatIP index for cosine similarity search.
4. **Retrieval**: User queries are embedded with the same function and searched against the index.
5. **Response**: Top-K results are returned with similarity scores to the orchestrator.

### Mock Embeddings

The embedding function uses SHA-256 hashing of word n-grams (unigrams + bigrams) distributed across 128 dimensions. While this doesn't capture true semantic meaning like transformer-based models, it provides deterministic, consistent embeddings that demonstrate the full RAG pipeline without API dependencies.

**To use real embeddings**, replace `generate_embedding()` in `rag-service/app/embeddings.py` with a call to OpenAI, Sentence Transformers, or Cohere.

---

## 🛡️ Failure Handling

| Scenario                    | Behavior                                                                |
|-----------------------------|-------------------------------------------------------------------------|
| RAG service down            | Orchestrator returns fallback message; errors array populated           |
| Unknown employee ID         | Tools return `employee_not_found`; user prompted to verify              |
| Out-of-scope question       | Explicit redirect to IT-related topics; no RAG or tools invoked         |
| Invalid request body        | 400 error with descriptive validation message                           |
| Internal server error       | 500 with generic message; full error logged in structured JSON          |
| RAG not ingested            | 400 error suggesting to call `/rag/ingest`                              |
| Compound multi-step query   | Sequential RAG → ticket check → conditional create; no duplicates       |

---

## 🔧 Environment Variables

### RAG Service
| Variable         | Default                     | Description                     |
|------------------|-----------------------------|---------------------------------|
| `HANDBOOK_PATH`  | `/app/data/IT_Handbook.txt` | Path to the IT handbook file    |

### Orchestrator
| Variable           | Default                   | Description                      |
|--------------------|---------------------------|----------------------------------|
| `RAG_SERVICE_URL`  | `http://localhost:8000`   | URL of the RAG service           |
| `PORT`             | `3001`                    | Orchestrator server port         |
| `NODE_ENV`         | `development`             | Environment mode                 |

### Frontend
| Variable         | Default   | Description                                |
|------------------|-----------|--------------------------------------------| 
| `VITE_API_URL`   | _(empty)_ | Orchestrator URL (uses proxy in dev mode)  |

---

## 📁 Project Structure

```
deskmate/
├── frontend/                   # React + TypeScript UI
│   ├── src/
│   │   ├── App.tsx             # Main chat component
│   │   ├── api.ts              # API client
│   │   ├── types.ts            # TypeScript interfaces
│   │   ├── index.css           # Design system & styles
│   │   └── main.tsx            # React entry point
│   ├── Dockerfile
│   └── package.json
├── orchestrator/               # Node.js + TypeScript orchestration
│   ├── src/
│   │   ├── index.ts            # Express server & endpoints
│   │   ├── orchestrator.ts     # Intent parsing & multi-step reasoning
│   │   ├── tools.ts            # Mock IT tools (tickets, entitlements)
│   │   ├── ragClient.ts        # RAG service HTTP client
│   │   └── logger.ts           # Structured JSON logger
│   ├── Dockerfile
│   └── package.json
├── rag-service/                # Python + FastAPI RAG pipeline
│   ├── app/
│   │   ├── main.py             # FastAPI endpoints & lifecycle
│   │   ├── embeddings.py       # Mock embedding function
│   │   ├── vector_store.py     # FAISS vector store wrapper
│   │   └── chunking.py         # Text chunking logic
│   ├── Dockerfile
│   └── requirements.txt
├── data/
│   └── IT_Handbook.txt         # IT policy knowledge base (18 sections)
├── docker-compose.yml          # Multi-service orchestration
├── README.md                   # This file
├── DECISIONS.md                # Technical decision documentation
└── production_architecture.md  # Azure Production Migration Strategy
```

---

## 🧪 Testing the System

### Test Queries

Try these in the chat to exercise different features:

| Query                                      | Expected Behavior                           |
|--------------------------------------------|---------------------------------------------|
| "How do I reset my password?"              | RAG search → password policy from handbook  |
| "Show my tickets"                          | Tool call → getEmployeeTickets              |
| "Create a ticket about VPN issues"         | Tool call → createSupportTicket             |
| "Do I have access to Adobe Photoshop?"     | Tool call → checkSoftwareEntitlement        |
| "How do I get Photoshop?"                  | Multi-step: entitlement check + RAG query   |
| "Hello"                                    | Greeting response with capability list      |
| "What's the weather?"                      | Out-of-scope: polite IT redirect            |
| _(spec showcase)_ "My VPN keeps disconnecting... check tickets... create one" | Compound: RAG + ticket check + conditional create |

### Test Mock Employee IDs

| Employee ID | Has Tickets | Has Photoshop |
|-------------|-------------|---------------|
| `EMP001`    | ✅ 2 open   | ❌ Not entitled|
| `EMP002`    | ✅ 1 open   | ✅ Creative Cloud|
| `EMP003`    | ❌ None     | ❌ Not entitled|
| `EMP999`    | ❌ Unknown  | ❌ Unknown    |
