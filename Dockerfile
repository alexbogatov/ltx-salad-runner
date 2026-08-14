FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production

WORKDIR /app

# 1. Install system utilities, Python 3.10, Node.js (v20 LTS), FFmpeg, and aria2
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    wget \
    aria2 \
    ffmpeg \
    ca-certificates \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 2. Upgrade pip and install PyTorch with CUDA 12.4
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
    torch \
    torchvision \
    torchaudio \
    --index-url https://download.pytorch.org/whl/cu124

# 3. Clone ComfyUI and install base dependencies
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git /app/ComfyUI && \
    pip install --no-cache-dir -r /app/ComfyUI/requirements.txt && \
    pip install --no-cache-dir comfy-kitchen alembic

# 4. Clone custom nodes (LTX-Video support, etc.)
RUN git clone --depth 1 https://github.com/City96/ComfyUI-LTXVideo.git /app/ComfyUI/custom_nodes/ComfyUI-LTXVideo

# 5. Patch comfy_kitchen type hinting for torch._library.infer_schema compatibility
RUN python3 -c "
path = '/usr/local/lib/python3.10/dist-packages/comfy_kitchen/backends/eager/na.py'
try:
    with open(path, 'r') as f:
        code = f.read()
    if 'from typing import' not in code:
        code = 'from typing import Sequence, Optional, List\n' + code
    else:
        code = code.replace('from typing import', 'from typing import Sequence, Optional, List,')
    code = code.replace('list[int]', 'Sequence[int]')
    code = code.replace('list[bool]', 'Sequence[bool]')
    code = code.replace('float | None', 'Optional[float]')
    with open(path, 'w') as f:
        f.write(code)
    print('[Build] Successfully applied typing patch to comfy_kitchen')
except Exception as e:
    print(f'[Build Warning] na.py patch skipped/failed: {e}')
"

# 6. Install Node.js Runner dependencies and copy runner scripts
COPY package*.json /app/
RUN if [ -f /app/package.json ]; then npm install --omit=dev; fi

COPY test-runner.js /app/test-runner.js
COPY test-r2.js /app/test-r2.js
COPY entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

EXPOSE 8188 8888

ENTRYPOINT ["/app/entrypoint.sh"]
