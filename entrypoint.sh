#!/bin/bash
set -eo pipefail

export GIT_TERMINAL_PROMPT=0
export COMFY_KITCHEN_BACKEND="triton,cuda"
export COMFY_KITCHEN_ALLOW_TRITON=1
export CUDA_MODULE_LOADING=LAZY

echo "===================================================="
echo "[Startup] Initializing LTX 2.5 Runner Environment"
echo "===================================================="

STORAGE_DIR="/workspace/models"

# Clean up stale processes and database locks
pkill -f "main.py" || true
rm -f /app/ComfyUI/user/comfyui.db.lock || true

# 1. Ensure persistent workspace directories exist
mkdir -p "${STORAGE_DIR}/diffusion_models" \
         "${STORAGE_DIR}/text_encoders" \
         "${STORAGE_DIR}/vae" \
         "${STORAGE_DIR}/latent_upscale_models" \
         "/workspace/output"

# 2. Reset ComfyUI directory targets and symlink persistent storage cleanly
mkdir -p /app/ComfyUI/models
rm -rf /app/ComfyUI/output \
       /app/ComfyUI/models/diffusion_models \
       /app/ComfyUI/models/text_encoders \
       /app/ComfyUI/models/vae \
       /app/ComfyUI/models/latent_upscale_models

ln -sfn /workspace/output /app/ComfyUI/output
ln -sfn "${STORAGE_DIR}/diffusion_models" /app/ComfyUI/models/diffusion_models
ln -sfn "${STORAGE_DIR}/text_encoders" /app/ComfyUI/models/text_encoders
ln -sfn "${STORAGE_DIR}/vae" /app/ComfyUI/models/vae
ln -sfn "${STORAGE_DIR}/latent_upscale_models" /app/ComfyUI/models/latent_upscale_models

# 3. Start ComfyUI & Worker
cd /app
if [ "$1" = "idle" ] || [ "$1" = "sleep" ]; then
    echo "[Idle Mode] Keeping pod alive for debugging..."
    exec sleep infinity
else
    # Launch ComfyUI with full GPU residency, fast math, and Triton
    /opt/venv/bin/python3 /app/ComfyUI/main.py \
        --listen 0.0.0.0 \
        --port 8188 \
        --gpu-only \
        --fast \
        --enable-triton-backend \
        --use-sage-attention \
        --disable-auto-launch &

    echo "[Startup] Waiting for ComfyUI on port 8188..."
    until curl -s http://127.0.0.1:8188/system_stats > /dev/null 2>&1; do
        sleep 1
    done
    echo "[Startup] ComfyUI ready. Executing worker.js..."

    exec node worker.js
fi
