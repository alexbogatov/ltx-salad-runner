#!/bin/bash
set -eo pipefail

export GIT_TERMINAL_PROMPT=0

echo "===================================================="
echo "[Startup] Initializing LTX 2.5 Runner Environment"
echo "===================================================="

R2_CDN="https://cdn.runltx.com/models"
STORAGE_DIR="/workspace/models"

# 1. Ensure network disk directories exist
mkdir -p "${STORAGE_DIR}/diffusion_models" \
         "${STORAGE_DIR}/text_encoders" \
         "${STORAGE_DIR}/vae" \
         "${STORAGE_DIR}/latent_upscale_models" \
         "/workspace/output"

# 2. Check or Create Persistent Python Virtual Environment
if [ ! -f "/workspace/venv/bin/activate" ]; then
    echo "[Setup] First boot: Creating persistent venv on network drive..."
    python3 -m venv /workspace/venv
    /workspace/venv/bin/pip install --upgrade pip setuptools wheel
    
    echo "[Setup] Installing PyTorch 2.5.1 with CUDA 12.4..."
    /workspace/venv/bin/pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu124
else
    echo "[Setup] Persistent venv found on network drive. Skipping base PyTorch install."
fi

source /workspace/venv/bin/activate

# 3. Check or Clone ComfyUI & Ensure Dependencies are Synchronized
if [ ! -f "/workspace/ComfyUI/main.py" ]; then
    echo "[Setup] Cloning ComfyUI onto persistent drive..."
    git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git /workspace/ComfyUI
else
    echo "[Setup] ComfyUI already present."
fi

echo "[Setup] Verifying and synchronizing Python requirements..."
# Install ComfyUI requirements without touching PyTorch
/workspace/venv/bin/pip install --no-cache-dir -r <(grep -vE '^(torch|torchvision|torchaudio)($|[<>=~])' /workspace/ComfyUI/requirements.txt)
/workspace/venv/bin/pip install --no-cache-dir sqlalchemy alembic comfy-kitchen

# Install Custom Nodes if missing
mkdir -p /workspace/ComfyUI/custom_nodes
if [ ! -d "/workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo" ]; then
    echo "[Setup] Cloning ComfyUI-LTXVideo custom node..."
    git clone --depth 1 https://github.com/Lightricks/ComfyUI-LTXVideo.git /workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo || true
fi

# Patch comfy_kitchen na.py dynamically inside venv
/workspace/venv/bin/python3 -c "
import importlib.util, os
spec = importlib.util.find_spec('comfy_kitchen')
if spec and spec.submodule_search_locations:
    path = os.path.join(spec.submodule_search_locations[0], 'backends', 'eager', 'na.py')
    if os.path.exists(path):
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
        print('[Setup] Patched comfy_kitchen na.py successfully')
" || true

# 4. Link directories so ComfyUI sees models & saves to /workspace/output
mkdir -p /workspace/ComfyUI/models
ln -sfn /workspace/ComfyUI /app/ComfyUI
ln -sfn /workspace/output /workspace/ComfyUI/output
ln -sfn /workspace/output /app/ComfyUI/output
ln -sfn "${STORAGE_DIR}/diffusion_models" /workspace/ComfyUI/models/diffusion_models
ln -sfn "${STORAGE_DIR}/text_encoders" /workspace/ComfyUI/models/text_encoders
ln -sfn "${STORAGE_DIR}/vae" /workspace/ComfyUI/models/vae
ln -sfn "${STORAGE_DIR}/latent_upscale_models" /workspace/ComfyUI/models/latent_upscale_models

# 5. Fetch Models (Atomic + Skips if already on persistent disk)
fetch_weight() {
    local target_path=$1
    local url=$2
    local label=$3
    local step_name=$4

    if [ ! -s "$target_path" ]; then
        echo "[Download] Fetching $label..."
        node /app/test-r2.js "step-${step_name}-start.txt" "Starting download: ${label}" || true
        rm -f "$target_path" "${target_path}.tmp"

        if command -v aria2c &> /dev/null; then
            aria2c -x 8 -s 8 -k 1M --console-log-level=warn -d "$(dirname "$target_path")" -o "$(basename "$target_path").tmp" "$url"
        else
            curl -fL --retry 5 --retry-delay 2 -o "${target_path}.tmp" "$url"
        fi

        mv "${target_path}.tmp" "$target_path"
        echo "[Download] $label completed."
        node /app/test-r2.js "step-${step_name}-done.txt" "Completed download: ${label}" || true
    else
        echo "[Check] $label already cached on persistent disk."
    fi
}

fetch_weight "${STORAGE_DIR}/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" \
             "${R2_CDN}/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" \
             "Diffusion Model (22B Distilled INT8)" "1-diffusion"

fetch_weight "${STORAGE_DIR}/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" \
             "${R2_CDN}/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" \
             "Text Encoder A (Gemma 4 12B INT8)" "2-text-encoder-a"

fetch_weight "${STORAGE_DIR}/text_encoders/gemma4_e2b_it_bf16.safetensors" \
             "${R2_CDN}/text_encoders/gemma4_e2b_it_bf16.safetensors" \
             "Text Encoder B (Gemma 4 12B BF16)" "3-text-encoder-b"

fetch_weight "${STORAGE_DIR}/vae/ltx-2.5-video-vae-bf16.safetensors" \
             "${R2_CDN}/vae/ltx-2.5-video-vae-bf16.safetensors" \
             "Video VAE" "4-video-vae"

fetch_weight "${STORAGE_DIR}/vae/ltx-2.5-audio-vae-bf16.safetensors" \
             "${R2_CDN}/vae/ltx-2.5-audio-vae-bf16.safetensors" \
             "Audio VAE" "5-audio-vae"

fetch_weight "${STORAGE_DIR}/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" \
             "${R2_CDN}/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" \
             "Latent Spatial Upscaler" "6-upscaler"

# 6. Start ComfyUI & Runner
cd /app
if [ "$1" = "idle" ] || [ "$1" = "sleep" ]; then
    echo "[Idle Mode] Keeping pod alive for debugging..."
    exec sleep infinity
else
    /workspace/venv/bin/python3 /workspace/ComfyUI/main.py --listen 0.0.0.0 --port 8188 &

    echo "[Startup] Waiting for ComfyUI on port 8188..."
    until curl -s http://127.0.0.1:8188/system_stats > /dev/null 2>&1; do
        sleep 1
    done
    echo "[Startup] ComfyUI ready. Executing test-runner.js..."

    exec node test-runner.js
fi
