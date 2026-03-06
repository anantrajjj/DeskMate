"""
Mock Embedding Function for DeskMate RAG Service.

WHY MOCK EMBEDDINGS?
--------------------
In a production system, we would use a real embedding model (e.g., OpenAI's
text-embedding-ada-002, Sentence Transformers, or Cohere). However, this project
is designed to run without any API keys or GPU resources.

Our mock embedding function uses a deterministic hash-based approach to generate
consistent, fixed-dimension vectors from text. This means:
  1. The same text always produces the same embedding (deterministic).
  2. Similar texts will have SOME overlap in their hash-derived features, though
     the semantic similarity is much weaker than real embeddings.
  3. It's fast, requires no external dependencies, and is fully offline.

TRADE-OFFS:
- Real embeddings capture semantic meaning (e.g., "VPN" and "remote access" would
  be close in vector space). Our mock embeddings rely on character/word-level
  hashing, so semantic proximity is approximated but not guaranteed.
- For demonstration purposes, this is sufficient to show the full RAG pipeline
  (ingest → embed → store → retrieve) working end-to-end.

TO SWAP IN REAL EMBEDDINGS:
  Replace `generate_embedding()` with a call to your embedding API. The rest
  of the pipeline (FAISS indexing, retrieval, scoring) works identically.
"""

import hashlib
import numpy as np

# WHY 384 DIMENSIONS?
# A balance between vector expressiveness and memory/performance.
# 384 is a standard small embedding size (e.g. all-MiniLM-L6-v2 uses 384).
EMBEDDING_DIM = 384

# Minimal stop words to improve keyword hashing accuracy
STOP_WORDS = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", 
    "by", "from", "up", "about", "into", "over", "after", "is", "are", "was", "were", 
    "be", "been", "being", "have", "has", "had", "do", "does", "did", "how", "what", 
    "why", "when", "where", "who", "which", "i", "you", "he", "she", "it", "we", "they", 
    "my", "your", "his", "her", "their", "our", "this", "that", "these", "those", "can", 
    "could", "would", "should", "will", "me", "am", "so", "as", "if"
}


def generate_embedding(text: str) -> np.ndarray:
    """
    Generate a deterministic mock embedding vector from text.

    Strategy: "Random Indexing"
    Instead of summing dense positive hashes (which causes all vectors to be
    highly correlated), we use a pseudo-random number generator seeded by the
    hash of each n-gram. We assign a dense, zero-mean randomized vector to
    each token and sum them up.

    By filtering out common stop words, the resulting vector strongly isolates
    the keywords. Documents sharing identical keywords will have high cosine
    similarity, while mismatched documents will be pseudo-orthogonal (~0 sim).
    """
    # Normalize text: lowercase and strip excess whitespace
    text = text.lower().strip()

    # Remove basic punctuation to prevent it from skewing word tokens
    import re
    text = re.sub(r'[^\w\s]', '', text)

    # Initialize the embedding vector
    embedding = np.zeros(EMBEDDING_DIM, dtype=np.float32)

    # Tokenize into words and filter stop words
    words = [w for w in text.split() if w not in STOP_WORDS]
    
    if not words:
        return embedding

    # Process unigrams and bigrams
    grams = words[:]  # unigrams
    for i in range(len(words) - 1):
        grams.append(f"{words[i]} {words[i+1]}")  # bigrams

    for gram in grams:
        # Generate a deterministic integer seed for this gram
        seed = int(hashlib.md5(gram.encode("utf-8")).hexdigest()[:8], 16)
        rng = np.random.RandomState(seed)
        
        # Add a dense random vector with mean 0
        gram_vec = rng.randn(EMBEDDING_DIM).astype(np.float32)
        embedding += gram_vec

    # L2 Normalize the embedding
    # WHY? FAISS IndexFlatIP (Inner Product) on L2-normalized vectors is
    # equivalent to cosine similarity. This gives us meaningful similarity
    # scores in the [-1, 1] range.
    norm = np.linalg.norm(embedding)
    if norm > 0:
        embedding = embedding / norm

    return embedding
