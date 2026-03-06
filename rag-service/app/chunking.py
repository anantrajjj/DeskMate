"""
Text Chunking Module for the RAG Pipeline.

WHY CHUNKING?
-------------
Large documents must be split into smaller pieces for two reasons:
  1. Embedding models have token/length limits (even our mock one benefits
     from focused text segments).
  2. Retrieval precision improves when chunks are topically focused. A user
     asking about "VPN" shouldn't get a 5000-word blob that includes VPN,
     printers, and HR policies.

STRATEGY: Paragraph-Based Chunking with Sentence-Aware Overlap
  We split on double newlines (paragraph boundaries) first, since our IT
  Handbook is already organized by topic paragraphs. Then we apply a character
  limit with overlap to handle paragraphs that exceed our target size.

WHY THESE SPECIFIC VALUES?
  - CHUNK_SIZE = 500 chars: Each chunk is roughly 75–100 words, which is
    enough to capture a complete policy point while staying focused. Smaller
    chunks (200) would split mid-sentence; larger (1000+) would reduce
    retrieval precision.
  - CHUNK_OVERLAP = 50 chars: ~1 sentence of overlap ensures that information
    at paragraph boundaries isn't lost. If a user asks about something
    mentioned at the end of one chunk and the start of the next, the overlap
    increases the chance of retrieval.
"""

import re


# These constants are intentionally module-level for easy tuning
CHUNK_SIZE = 1000     # Target maximum characters per chunk
CHUNK_OVERLAP = 100   # Overlap between consecutive chunks from the same section


def chunk_text(text: str) -> list[str]:
    """
    Split text into semantically meaningful chunks.

    Process:
    1. Split on double newlines (paragraph/section boundaries).
    2. If a paragraph exceeds CHUNK_SIZE, split it further at sentence
       boundaries with CHUNK_OVERLAP character overlap.
    3. Strip whitespace and discard empty chunks.

    Returns:
        List of non-empty text chunks.
    """
    # Step 1: Split on paragraph boundaries (double newlines)
    # WHY? Our IT handbook uses blank lines between sections, so this
    # naturally splits by topic.
    paragraphs = re.split(r"\n\s*\n", text.strip())

    chunks = []
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        if len(para) <= CHUNK_SIZE:
            # Paragraph fits in one chunk — keep it intact
            chunks.append(para)
        else:
            # Step 2: Break long paragraphs at sentence boundaries
            # WHY SENTENCE SPLITTING? Cutting mid-sentence would create
            # incoherent chunks that reduce embedding quality and retrieval
            # precision.
            sub_chunks = _split_with_overlap(para, CHUNK_SIZE, CHUNK_OVERLAP)
            chunks.extend(sub_chunks)

    return chunks


def _split_with_overlap(text: str, max_size: int, overlap: int) -> list[str]:
    """
    Split a long text into overlapping chunks at sentence boundaries.

    WHY SENTENCE-AWARE SPLITTING?
    Naive character-based splitting can cut words or sentences in half,
    producing chunks like "...submit a tick" + "et to IT Support...".
    By splitting at sentence boundaries ('. '), we preserve readability
    and semantic coherence.
    """
    # Split into sentences (simple heuristic: period + space or newline)
    # This prevents lists (e.g., "Step 1\nStep 2\n") from being merged into one giant line
    sentences = re.split(r"(?<=[.!?\n])\s+", text)

    chunks = []
    current_chunk = ""
    overlap_buffer = ""

    for sentence in sentences:
        # If adding this sentence exceeds the limit, finalize the current chunk
        if current_chunk and len(current_chunk) + len(sentence) + 1 > max_size:
            chunks.append(current_chunk.strip())
            # Start next chunk with overlap from the end of the current one
            # WHY? Overlap ensures continuity between chunks. If a policy
            # states "VPN access requires..." at the end of chunk N, chunk
            # N+1 starting with the same context improves retrieval recall.
            overlap_buffer = current_chunk[-overlap:] if len(current_chunk) > overlap else current_chunk
            current_chunk = overlap_buffer + " " + sentence
        else:
            current_chunk = (current_chunk + " " + sentence).strip() if current_chunk else sentence

    # Don't forget the last chunk
    if current_chunk.strip():
        chunks.append(current_chunk.strip())

    return chunks
