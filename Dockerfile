FROM nvidia/cuda:12.4.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    GIT_TERMINAL_PROMPT=0 \
    PATH="/opt/venv/bin:$PATH" \
    TRITON_KNOBS_BUILD_IMPL=torch \
    CC=/usr/bin/gcc \
    CXX=/usr/bin/g++ \
    TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9;9.0" \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=all \
    COMFY_KITCHEN_BACKEND=triton,cuda \
    COMFY_KITCHEN_ALLOW_TRITON=1 \
    CUDA_MODULE_LOADING=LAZY \
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
    ninja-build \
    gcc \
    g++ \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

# 2. Build local Python virtual environment & bake PyTorch cu124 + backends
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/venv/bin/pip install --no-cache-dir \
        torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124 \
    && /opt/venv/bin/pip install --no-cache-dir \
        comfy-kitchen alembic sqlalchemy triton \
    && /opt/venv/bin/pip install --no-cache-dir sageattention --no-build-isolation || true

# 3. Clone ComfyUI and LTX custom nodes without overriding PyTorch cu124
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git /app/ComfyUI \
    && /opt/venv/bin/pip install --no-cache-dir -r /app/ComfyUI/requirements.txt --extra-index-url https://download.pytorch.org/whl/cu124 \
    && mkdir -p /app/ComfyUI/custom_nodes \
    && git clone --depth 1 https://github.com/Lightricks/ComfyUI-LTXVideo.git /app/ComfyUI/custom_nodes/ComfyUI-LTXVideo \
    && /opt/venv/bin/pip install --no-cache-dir -r /app/ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt --extra-index-url https://download.pytorch.org/whl/cu124 \
    && rm -rf /root/.cache /tmp/*

# 4. Patch comfy_kitchen (na.py typing and bypass broken Triton rms_rope kernel)
RUN /opt/venv/bin/python3 - <<'EOF'
import importlib.util
import os

spec = importlib.util.find_spec('comfy_kitchen')
pkg_dir = spec.submodule_search_locations[0]

# Patch na.py typing
path_na = os.path.join(pkg_dir, 'backends', 'eager', 'na.py')
with open(path_na, 'r') as f:
    code_na = f.read()

if 'from typing import' in code_na:
    code_na = code_na.replace('from typing import', 'from typing import Sequence, Optional, List,')
else:
    code_na = 'from typing import Sequence, Optional, List\n' + code_na

code_na = code_na.replace('list[int]', 'Sequence[int]').replace('list[bool]', 'Sequence[bool]').replace('float | None', 'Optional[float]')

with open(path_na, 'w') as f:
    f.write(code_na)

# Patch triton init to remove broken rms_rope registration so it uses eager/cuda
init_triton = os.path.join(pkg_dir, 'backends', 'triton', '__init__.py')
if os.path.exists(init_triton):
    with open(init_triton, 'r') as f:
        code_init = f.read()
    code_init = code_init.replace('rms_rope', '# rms_rope')
    with open(init_triton, 'w') as f:
        f.write(code_init)

print('[Build] comfy_kitchen patched successfully for all kernels')
EOF

# 5. Copy warmup script
COPY warmup.py /app/
RUN /opt/venv/bin/python3 /app/warmup.py || echo "Warmup skipped (no GPU available during build)"

# 6. Copy package configs and install Node dependencies
COPY package*.json /app/
RUN if [ -f /app/package.json ]; then \
      npm install --omit=dev && npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner dotenv ws; \
    else \
      npm init -y && npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner dotenv ws; \
    fi

# 7. Copy all runner orchestration files
COPY . /app/
RUN chmod +x /app/entrypoint.sh

EXPOSE 8188 8888

ENTRYPOINT ["/app/entrypoint.sh"]
