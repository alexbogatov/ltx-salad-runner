FROM nvidia/cuda:13.0.0-base-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    GIT_TERMINAL_PROMPT=0 \
    PATH="/opt/venv/bin:$PATH" \
    TRITON_KNOBS_BUILD_IMPL=torch \
    CC=/usr/bin/gcc \
    CXX=/usr/bin/g++ \
    TORCH_CUDA_ARCH_LIST="8.6;8.9;9.0" \
    MAX_JOBS=4

WORKDIR /app

# 1. Install system utilities, Python 3, Node.js 20, and build tools
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
    python3-dev \
    build-essential \
    gcc \
    g++ \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

# 2. Build local Python virtual environment & bake PyTorch cu130 + CUDA backends
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/venv/bin/pip install --no-cache-dir \
       torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130 \
    && /opt/venv/bin/pip install --no-cache-dir \
       comfy-kitchen alembic sqlalchemy

# 3. Clone ComfyUI and LTX custom nodes directly into container image
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git /app/ComfyUI \
    && /opt/venv/bin/pip install --no-cache-dir -r /app/ComfyUI/requirements.txt \
    && mkdir -p /app/ComfyUI/custom_nodes \
    && git clone --depth 1 https://github.com/Lightricks/ComfyUI-LTXVideo.git /app/ComfyUI/custom_nodes/ComfyUI-LTXVideo \
    && /opt/venv/bin/pip install --no-cache-dir -r /app/ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt \
    && rm -rf /root/.cache /tmp/*

# 4. Patch comfy_kitchen na.py directly inside the baked venv
RUN /opt/venv/bin/python3 -c "\
import importlib.util, os;\
spec = importlib.util.find_spec('comfy_kitchen');\
path = os.path.join(spec.submodule_search_locations[0], 'backends', 'eager', 'na.py');\
code = open(path).read();\
code = code.replace('from typing import', 'from typing import Sequence, Optional, List,') if 'from typing import' in code else 'from typing import Sequence, Optional, List\n' + code;\
code = code.replace('list[int]', 'Sequence[int]').replace('list[bool]', 'Sequence[bool]').replace('float | None', 'Optional[float]');\
open(path, 'w').write(code);\
print('[Build] comfy_kitchen na.py patched successfully')"

# 5. Copy warmup script and run it (will skip GPU if not available)
COPY warmup.py /app/
RUN /opt/venv/bin/python3 /app/warmup.py || echo "Warmup skipped (no GPU available during build)"

# 6. Copy package configs and install Node orchestration dependencies
COPY package*.json /app/
RUN if [ -f /app/package.json ]; then npm install --omit=dev; fi

# 7. Copy all runner orchestration files
COPY . /app/
RUN chmod +x /app/entrypoint.sh /app/dl.sh

EXPOSE 8188 8888

ENTRYPOINT ["/app/entrypoint.sh"]
