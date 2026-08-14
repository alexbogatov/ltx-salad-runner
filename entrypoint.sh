#!/bin/bash
set -eo pipefail

echo "===================================================="
echo "[Startup] Initializing LTX 2.5 Runner Environment"
echo "===================================================="

R2_CDN="https://cdn.runltx.com/models"
STORAGE_DIR="/workspace/models"

# 1. Setup Persistent Directories on Network Storage
mkdir -p "${STORAGE_DIR}/diffusion_models" \
         "${STORAGE_DIR}/text_encoders" \
         "${STORAGE_DIR}/vae" \
         "${STORAGE_DIR}/latent_upscale_models" \
         "/workspace/output"

# 2. Symlink ComfyUI Folders to Persistent Storage
mkdir -p /app/ComfyUI/models
rm -rf /app/ComfyUI/models/diffusion_models && ln -sfn "${STORAGE_DIR}/diffusion_models" /app/ComfyUI/models/diffusion_models
rm -rf /app/ComfyUI/models/text_encoders && ln -sfn "${STORAGE_DIR}/text_encoders" /app/ComfyUI/models/text_encoders
rm -rf /app/ComfyUI/models/vae && ln -sfn "${STORAGE_DIR}/vae" /app/ComfyUI/models/vae
rm -rf /app/ComfyUI/models/latent_upscale_models && ln -sfn "${STORAGE_DIR}/latent_upscale_models" /app/ComfyUI/models/latent_upscale_models
rm -rf /app/ComfyUI/output && ln -sfn /workspace/output /app/ComfyUI/output

# Signal 0: Container started
node /app/test-r2.js "step-0-container-started.txt" "Container environment loaded successfully" || true

# 3. Fast, Atomic File Downloader (Supports aria2c multi-connection + curl fallback)
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
            aria2c -x 8 -s 8 -k 1M --console-log-level=warn \
                   -d "$(dirname "$target_path")" \
                   -o "$(basename "$target_path").tmp" "$url"
        else
            curl -fL --retry 5 --retry-delay 2 -o "${target_path}.tmp" "$url"
        fi

        if [ ! -s "${target_path}.tmp" ]; then
            echo "[ERROR] Failed to download $label from $url"
            node /app/test-r2.js "error-${step_name}-failed.txt" "Download failed for: ${label}" || true
            rm -f "${target_path}.tmp"
            exit 1
        fi

        mv "${target_path}.tmp" "$target_path"
        echo "[Download] $label completed."
        node /app/test-r2.js "step-${step_name}-done.txt" "Completed download: ${label}" || true
    else
        echo "[Check] $label already cached on persistent disk."
        node /app/test-r2.js "step-${step_name}-cached.txt" "Weight already exists locally: ${label}" || true
    fi
}

# 4. Fetch All Required Weights
fetch_weight "${STORAGE_DIR}/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" \
             "${R2_CDN}/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" \
             "Diffusion Model (22B Distilled INT8)" \
             "1-diffusion"

fetch_weight "${STORAGE_DIR}/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" \
             "${R2_CDN}/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" \
             "Text Encoder A (Gemma 4 12B INT8)" \
             "2-text-encoder-a"

fetch_weight "${STORAGE_DIR}/text_encoders/gemma4_e2b_it_bf16.safetensors" \
             "${R2_CDN}/text_encoders/gemma4_e2b_it_bf16.safetensors" \
             "Text Encoder B (Gemma 4 12B BF16)" \
             "3-text-encoder-b"

fetch_weight "${STORAGE_DIR}/vae/ltx-2.5-video-vae-bf16.safetensors" \
             "${R2_CDN}/vae/ltx-2.5-video-vae-bf16.safetensors" \
             "Video VAE" \
             "4-video-vae"

fetch_weight "${STORAGE_DIR}/vae/ltx-2.5-audio-vae-bf16.safetensors" \
             "${R2_CDN}/vae/ltx-2.5-audio-vae-bf16.safetensors" \
             "Audio VAE" \
             "5-audio-vae"

fetch_weight "${STORAGE_DIR}/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" \
             "${R2_CDN}/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" \
             "Latent Spatial Upscaler" \
             "6-upscaler"

echo "===================================================="
echo "[Startup] All model weights verified. Starting ComfyUI..."
echo "===================================================="

node /app/test-r2.js "step-7-downloads-complete.txt" "All weights downloaded successfully." || true

# 5. Launch Application
cd /app
if [ "$1" = "idle" ] || [ "$1" = "sleep" ]; then
    echo "[Idle Mode] Keeping pod alive for manual maintenance..."
    exec sleep infinity
else
    # Launch ComfyUI in the background
    python3 /app/ComfyUI/main.py --listen 0.0.0.0 --port 8188 &

    # Wait for ComfyUI HTTP server to be ready before calling test runner
    echo "[Startup] Waiting for ComfyUI port 8188..."
    until curl -s http://127.0.0.1:8188/system_stats > /dev/null 2>&1; do
        sleep 1
    done
    echo "[Startup] ComfyUI is up. Launching test-runner.js..."

    # Execute runner as the primary PID
    exec node test-runner.js
fi
