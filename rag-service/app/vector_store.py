"""
Vector Store Module - In-memory vector storage with NumPy-based similarity search.

This module provides semantic search over document embeddings using brute-force
cosine similarity (via inner product on L2-normalized vectors).

WHY NUMPY INSTEAD OF FAISS?
----------------------------
FAISS (Facebook AI Similarity Search) is the industry standard for large-scale
vector search. However, on some Windows environments, `import faiss` hangs
indefinitely due to MKL/PyTorch dependency conflicts.

For our small dataset (~18-25 chunks from the IT Handbook), pure-NumPy
brute-force search completes in <1ms and is functionally identical to
FAISS IndexFlatIP. This makes the service portable and dependency-light.

TO UPGRADE TO FAISS:
  Replace the NumPy dot-product in `search()` with a FAISS IndexFlatIP.
  The API remains identical.

WHY IN-MEMORY vs. PERSISTENT?
  This is a demonstration project. In production, you'd use FAISS with
  on-disk indices or migrate to a managed vector DB (Pinecone, Weaviate,
  Qdrant). In-memory is simpler, faster, and sufficient for our dataset.
"""

import numpy as np
from typing import Optional
from app.embeddings import EMBEDDING_DIM


class VectorStore:
    """
    In-memory vector store using NumPy for brute-force similarity search.

    Stores document chunks alongside their embeddings and allows
    efficient similarity search via inner product (cosine similarity
    on L2-normalized vectors).
    """

    def __init__(self):
        self.embeddings: Optional[np.ndarray] = None
        self.chunks: list[str] = []
        self.is_initialized: bool = False

    def build_index(self, chunks: list[str], embeddings: np.ndarray) -> int:
        """
        Store chunks and their embeddings for later search.

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

        self.embeddings = embeddings.astype(np.float32)
        self.chunks = chunks
        self.is_initialized = True
        return len(chunks)

    def search(self, query_embedding: np.ndarray, top_k: int = 3) -> list[dict]:
        """
        Search for the most similar chunks to the query embedding.

        Uses brute-force inner product (equivalent to cosine similarity
        on L2-normalized vectors).

        Args:
            query_embedding: 1D numpy array of shape (EMBEDDING_DIM,).
            top_k: Number of results to return.

        Returns:
            List of dicts with keys: 'chunk', 'score', 'index'.
            Sorted by descending similarity score.
        """
        if not self.is_initialized or self.embeddings is None:
            raise RuntimeError(
                "Vector store is not initialized. Call /rag/ingest first."
            )

        # Compute inner product scores (cosine sim for L2-normalized vectors)
        query_2d = query_embedding.reshape(1, -1).astype(np.float32)
        scores = np.dot(self.embeddings, query_2d.T).flatten()

        # Get top-k indices sorted by descending score
        effective_k = min(top_k, len(self.chunks))
        top_indices = np.argsort(scores)[::-1][:effective_k]

        results = []
        for idx in top_indices:
            results.append({
                "chunk": self.chunks[int(idx)],
                "score": float(scores[int(idx)]),
                "index": int(idx),
            })

        return results

    def get_status(self) -> dict:
        """Return the current status of the vector store."""
        return {
            "is_initialized": self.is_initialized,
            "total_chunks": len(self.chunks) if self.is_initialized else 0,
            "embedding_dimension": EMBEDDING_DIM,
            "index_type": "NumPy Brute-Force (Cosine Similarity via Inner Product)",
        }


# Singleton instance - shared across the application lifecycle
# WHY SINGLETON? FastAPI runs in a single process per worker. A module-level
# singleton ensures all endpoints share the same vector store state without
# needing dependency injection or a database.
vector_store = VectorStore()
