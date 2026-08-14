FROM nvidia/cuda:12.4.1-base-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    PATH="/workspace/venv/bin:$PATH"

WORKDIR /app

# Install minimal OS utilities + Python base + Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    wget \
    aria2 \
    ffmpeg \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

# Copy runner orchestration scripts
COPY package*.json /app/
RUN if [ -f /app/package.json ]; then npm install --omit=dev; fi

COPY test-runner.js /app/test-runner.js
COPY test-r2.js /app/test-r2.js
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 8188 8888

ENTRYPOINT ["/app/entrypoint.sh"]
