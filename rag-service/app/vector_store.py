"""
Vector Store Module - FAISS-backed in-memory vector storage.

WHY FAISS?
----------
FAISS (Facebook AI Similarity Search) is the industry standard for efficient
similarity search on dense vectors. Even though we're using mock embeddings,
FAISS gives us:
  1. Sub-millisecond search on small datasets (our IT handbook).
  2. The exact same API we'd use in production with real embeddings.
  3. Inner product search (IndexFlatIP) on L2-normalized vectors = cosine
     similarity, which is the standard metric for text similarity.

WHY IN-MEMORY vs. PERSISTENT?
  This is a demonstration project. In production, you'd use FAISS with
  on-disk indices or migrate to a managed vector DB (Pinecone, Weaviate,
  Qdrant). In-memory is simpler, faster, and sufficient for our ~18-chunk
  dataset.
"""

import faiss
import numpy as np
from typing import Optional
from app.embeddings import EMBEDDING_DIM


class VectorStore:
    """
    In-memory FAISS vector store with metadata tracking.

    Stores document chunks alongside their embeddings and allows
    efficient similarity search via inner product (cosine similarity
    on L2-normalized vectors).
    """

    def __init__(self):
        # WHY IndexFlatIP?
        # Flat = brute-force (exact search, no approximation).
        # IP = Inner Product. On L2-normalized vectors, IP == cosine similarity.
        # For small datasets (<10K vectors), flat indices are fast enough and
        # give exact results. IVF/HNSW indices are for million-scale datasets.
        self.index: Optional[faiss.IndexFlatIP] = None
        self.chunks: list[str] = []
        self.is_initialized: bool = False

    def build_index(self, chunks: list[str], embeddings: np.ndarray) -> int:
        """
        Build the FAISS index from pre-computed embeddings.

        Args:
            chunks: List of text chunks corresponding to the embeddings.
            embeddings: numpy array of shape (n_chunks, EMBEDDING_DIM).

        Returns:
            Number of chunks indexed.
        """
        # Validate dimensions
        assert embeddings.shape[1] == EMBEDDING_DIM, (
            f"Embedding dimension mismatch: expected {EMBEDDING_DIM}, "
            f"got {embeddings.shape[1]}"
        )

        # Create a fresh index each time (idempotent re-ingestion)
        self.index = faiss.IndexFlatIP(EMBEDDING_DIM)
        self.index.add(embeddings)
        self.chunks = chunks
        self.is_initialized = True
        return len(chunks)

    def search(self, query_embedding: np.ndarray, top_k: int = 3) -> list[dict]:
        """
        Search for the most similar chunks to the query embedding.

        Args:
            query_embedding: 1D numpy array of shape (EMBEDDING_DIM,).
            top_k: Number of results to return.

        Returns:
            List of dicts with keys: 'chunk', 'score', 'index'.
            Sorted by descending similarity score.
        """
        if not self.is_initialized or self.index is None:
            raise RuntimeError(
                "Vector store is not initialized. Call /rag/ingest first."
            )

        # FAISS expects a 2D array for queries
        query_2d = query_embedding.reshape(1, -1)

        # Clamp top_k to the number of stored chunks
        effective_k = min(top_k, len(self.chunks))

        # Search returns (distances, indices) arrays
        scores, indices = self.index.search(query_2d, effective_k)

        results = []
        for i in range(effective_k):
            idx = int(indices[0][i])
            if idx < 0:
                # FAISS returns -1 for missing results in some edge cases
                continue
            results.append({
                "chunk": self.chunks[idx],
                "score": float(scores[0][i]),
                "index": idx,
            })

        return results

    def get_status(self) -> dict:
        """Return the current status of the vector store."""
        return {
            "is_initialized": self.is_initialized,
            "total_chunks": len(self.chunks) if self.is_initialized else 0,
            "embedding_dimension": EMBEDDING_DIM,
            "index_type": "IndexFlatIP (Cosine Similarity via Inner Product)",
        }


# Singleton instance - shared across the application lifecycle
# WHY SINGLETON? FastAPI runs in a single process per worker. A module-level
# singleton ensures all endpoints share the same vector store state without
# needing dependency injection or a database.
vector_store = VectorStore()
