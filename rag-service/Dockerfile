FROM python:3.11-slim

WORKDIR /app

# Install dependencies first for Docker layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose the RAG service port
EXPOSE 8000

# Run with uvicorn; host 0.0.0.0 so it's accessible from other containers
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
