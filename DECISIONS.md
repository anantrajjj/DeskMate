# Technical Decisions — DeskMate

This document captures **five non-obvious technical decisions** made during the development of DeskMate, explaining the reasoning, trade-offs, and alternatives considered.

---

## Decision 1: FAISS IndexFlatIP Over Approximate Search Indices

**Context**: FAISS offers multiple index types, from exact (Flat) to approximate (IVF, HNSW). We needed to choose the right one for our vector store.

**Decision**: Use `IndexFlatIP` (exact inner product search).

**Reasoning**:
- Our dataset is small (~18-25 chunks from the IT Handbook). At this scale, brute-force search completes in <1ms, making approximate indices unnecessary overhead.
- `IndexFlatIP` on L2-normalized vectors computes cosine similarity directly, which is the standard metric for text similarity.
- Approximate indices (IVF, HNSW) shine at 100K+ vectors. Using them on a 20-vector dataset would add training steps, memory overhead, and configuration complexity (nlist, nprobe) with zero performance benefit.

**Trade-off**: If the knowledge base grows to thousands of documents, we would need to upgrade to `IndexIVFFlat` or `IndexHNSWFlat` for sub-linear search time. The `VectorStore` class is designed to make this a drop-in replacement.

**Alternatives Considered**:
- `IndexFlatL2` — L2 distance instead of inner product. Works but requires manual conversion to similarity scores.
- `IndexIVFFlat` — Approximate search with inverted file indexing. Overkill for our dataset size.
- Pinecone/Weaviate (managed vector DB) — Adds external dependency; violates the "no external DB" requirement.

---

## Decision 2: Hash-Based Mock Embeddings with N-gram Strategy

**Context**: The project requires no API keys, ruling out real embedding models (OpenAI, Cohere, Sentence Transformers). We needed a mock that still demonstrates the full RAG pipeline.

**Decision**: Use SHA-256 hashing of word unigrams and bigrams to generate deterministic 128-dimensional vectors.

**Reasoning**:
- **Determinism**: The same text always produces the same embedding, essential for reproducible search results and debugging.
- **N-grams over characters**: Hashing individual characters loses word-level semantics entirely. Unigrams capture word frequency signals; bigrams capture local word co-occurrence (e.g., "password reset" as a unit), providing marginally better retrieval precision than character-level hashing.
- **L2 normalization**: Normalizing vectors enables cosine similarity via inner product, which is more interpretable (0 = unrelated, 1 = identical) than raw hash magnitudes.
- **128 dimensions**: Balances expressiveness and memory. Real models use 384–1536, but for hash-based vectors, additional dimensions don't add information — they just spread the same hash entropy thinner.

**Trade-off**: Semantic similarity is very weak compared to real embeddings. "VPN" and "remote access" won't be close in our embedding space. This is acceptable because the purpose is demonstrating the pipeline, not achieving production-grade retrieval.

**How to swap in real embeddings**: Replace the `generate_embedding()` function in `rag-service/app/embeddings.py`. No other code changes are needed.

---

## Decision 3: Keyword-Based Intent Parsing Instead of LLM

**Context**: The orchestrator needs to classify user intent (check tickets, create ticket, query knowledge, etc.) to route to the correct handler. The project requires no API keys.

**Decision**: Implement a deterministic keyword/regex-based intent parser instead of using an LLM for classification.

**Reasoning**:
- **Zero external dependencies**: No OpenAI/Anthropic API key needed. The system works fully offline.
- **Deterministic behavior**: Same input → same intent classification → same handler. This makes debugging, testing, and demo reproducibility trivial.
- **Sub-millisecond latency**: Regex matching is ~0.01ms vs. ~500-2000ms for an LLM API call. For a demo, instant response to intent classification improves perceived performance.
- **Ordered pattern matching**: Patterns are checked in priority order (specific intents first, `knowledge_query` as fallback). This prevents ambiguous inputs from matching the wrong handler.

**Trade-off**: The parser is brittle. "Can you help me file a complaint?" might not match "create_ticket" unless we add that exact pattern. An LLM would understand that naturally. However, for the defined demo scenarios, our patterns cover the expected inputs comprehensively.

**Production upgrade path**: Replace `parseIntent()` in `orchestrator.ts` with a LangChain `ChatPromptTemplate` + `StructuredOutputParser` calling an LLM. The rest of the orchestration pipeline (tool selection, RAG querying, response assembly) is LLM-agnostic and stays unchanged.

---

## Decision 4: Paragraph-Based Chunking with Sentence-Aware Overlap

**Context**: The IT Handbook needs to be split into searchable chunks. Chunking strategy directly impacts retrieval quality — too large and you lose precision, too small and you lose context.

**Decision**: Split on paragraph boundaries (double newlines) first, then sub-split long paragraphs at sentence or newline boundaries with 100-character overlap between chunks.

**Reasoning**:
- **Paragraph-first splitting**: Our IT Handbook is organized by topic (VPN, passwords, hardware, etc.). Splitting on `\n\n` preserves these natural topic boundaries, meaning each chunk is likely about one topic.
- **1000-character target size**: ~150-200 words per chunk. This size is specifically chosen because troubleshooting steps (like the VPN fix) are often grouped together as lists. If the chunk size was smaller (e.g. 500 characters), lists would be severed mid-way through their steps. 1000 guarantees entire policy sections remain intact.
- **Sentence and Newline-aware sub-splitting**: When a paragraph exceeds 1000 chars, we split at sentence boundaries (`.` + space) or explicit newlines (`\n`) rather than at arbitrary character positions. Preserving `\n` is crucial so bullet points are never merged into a giant unreadable block.
- **100-character overlap**: ~1-2 sentences of overlap ensures that information spanning two chunks isn't lost. If a relevant fact appears at the end of chunk N, it's also present at the beginning of chunk N+1.

**Alternatives Considered**:
- **Fixed-size character splitting**: Simple but creates incoherent chunks at arbitrary break points.
- **Recursive character splitting** (LangChain default): More flexible but adds complexity without benefit when the source document has clear structural markers.
- **Semantic splitting** (embedding-based): Would require real embeddings to compute between-sentence similarity. Circular dependency with our mock approach.
- **No overlap**: Risk of missing relevant information at chunk boundaries.

---

## Decision 5: Multi-Step Intent Handlers with Combined Software + Knowledge Flow

**Context**: Some user queries require multiple operations in sequence. For example, "How do I get Photoshop?" should: (1) check if the user already has a Photoshop license, and (2) look up the software request process from the handbook.

**Decision**: Create a dedicated `software_and_knowledge` intent that triggers a sequential multi-step handler: entitlement check → RAG query → combined response.

**Reasoning**:
- **User-centric responses**: A user asking "How do I get Photoshop?" expects the system to not just look up the process, but also tell them whether they already have it. Combining both data points into one response saves a round trip.
- **Sequential, not parallel**: The entitlement result influences how we frame the RAG results. If the user already has a license, we say "You already have Photoshop (Creative Cloud)." If not, we say "You're not entitled — here's how to request access." This sequencing is intentional.
- **Graceful degradation**: If the entitlement check succeeds but the RAG query fails (service down), the response still includes the entitlement information plus a fallback message. Neither step's failure blocks the other from contributing to the response.
- **Explicit intent routing**: Rather than having the orchestrator "figure out" multi-step flows at runtime (which requires an LLM), we pre-define the `software_and_knowledge` intent with its multi-step behavior. This is the deterministic analog to an LLM agent's planning loop.

**Trade-off**: We need to anticipate multi-step flows at design time and create dedicated intents for them. If a new multi-step flow is needed (e.g., "Create a ticket about my VPN issue" → check existing VPN tickets first → create if none exist), we'd need to add a new intent handler. An LLM-based agent could compose these steps dynamically.

**Why Not a Full Agent Loop?**: A reasoning loop like ReAct (Reason → Act → Observe → Repeat) requires an LLM to decide the next action. Without an LLM, we'd need to build a rule-based state machine that quickly becomes unmaintainable. The explicit handler approach is a pragmatic middle ground: it demonstrates multi-step reasoning while remaining deterministic and debuggable.

---

## Decision 6: Hybrid Architecture — Deterministic Routing + LLM Synthesis

**Context**: The initial design used template-based response generation (hardcoded strings and raw RAG chunk pasting). This functioned as a search engine with a chat wrapper, not a conversational AI agent. The system needed real LLM-powered response synthesis.

**Decision**: Use a **hybrid architecture** — keep the deterministic keyword-based intent parser for routing, but add an LLM synthesis step at the end of the orchestration pipeline to compose natural-language answers from the gathered context (RAG chunks + tool outputs).

**Reasoning**:
- **Separation of concerns**: Intent parsing (fast, deterministic, no API cost) is separate from response generation (LLM-powered, natural language). Each can be upgraded independently.
- **Groq via OpenAI SDK**: We use the `openai` npm package pointed at Groq's API (`https://api.groq.com/openai/v1`). Groq offers free-tier access and extremely fast inference (~200ms). The OpenAI-compatible SDK means swapping to OpenAI, Anthropic, or Ollama requires only changing `baseURL` and `apiKey`.
- **Context injection**: The LLM receives a structured prompt containing the user's question, detected intent, all retrieved RAG chunks, and all tool results. It synthesizes a coherent, natural response grounded in this context.
- **Graceful fallback**: If `GROQ_API_KEY` is not set or the LLM call fails, the system returns the template-based answers from the original implementation. The app always works — LLM enhances but is not required.
- **Selective synthesis**: Greeting and out-of-scope intents skip the LLM (no need to synthesize static responses), saving API calls and latency.

**Trade-off**: Adding an LLM call introduces latency (~200-1500ms) and an external dependency. The graceful fallback mitigates the reliability risk. For latency, Groq's LPU hardware keeps generation under 500ms for typical responses.

**Alternatives Considered**:
- **Full LLM agent (LangChain/Mastra)**: Would replace both intent parsing AND response generation with LLM calls. More flexible but slower (multiple LLM round-trips for routing decisions) and less predictable for a demo.
- **Ollama (fully local)**: No API key needed, but requires local GPU resources and model download. Not practical for a portable demo.
- **OpenAI GPT-4**: Higher quality but more expensive, no free tier for sustained usage.
