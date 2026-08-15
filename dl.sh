#!/bin/bash
set -eo pipefail

export GIT_TERMINAL_PROMPT=0

echo "===================================================="
echo "[Startup] Initializing LTX 2.5 Model Downloader"
echo "===================================================="

STORAGE_DIR="/workspace/models"

# 1. Ensure network storage directories exist
mkdir -p "${STORAGE_DIR}/diffusion_models" \
         "${STORAGE_DIR}/text_encoders" \
         "${STORAGE_DIR}/vae" \
         "${STORAGE_DIR}/latent_upscale_models" \
         "/workspace/output"

# 2. Symlink persistent storage into baked ComfyUI instance
mkdir -p /app/ComfyUI/models
ln -sfn /workspace/output /app/ComfyUI/output
ln -sfn "${STORAGE_DIR}/diffusion_models" /app/ComfyUI/models/diffusion_models
ln -sfn "${STORAGE_DIR}/text_encoders" /app/ComfyUI/models/text_encoders
ln -sfn "${STORAGE_DIR}/vae" /app/ComfyUI/models/vae
ln -sfn "${STORAGE_DIR}/latent_upscale_models" /app/ComfyUI/models/latent_upscale_models

# ==============================================================================
# 3. Model Fetcher
# ==============================================================================

R2_CDN="https://cdn.runltx.com/models"

fetch_weight() {
    local target_path=$1
    local url=$2
    local label=$3
    local step_name=$4

    if [ ! -s "$target_path" ]; then
        echo "[Download] Fetching $label..."
        [ -f /app/test-r2.js ] && node /app/test-r2.js "step-${step_name}-start.txt" "Starting download: ${label}" || true
        rm -f "$target_path" "${target_path}.tmp"

        if command -v aria2c &> /dev/null; then
            aria2c -x 8 -s 8 -k 1M --console-log-level=warn -d "$(dirname "$target_path")" -o "$(basename "$target_path").tmp" "$url"
        else
            curl -fL --retry 5 --retry-delay 2 -o "${target_path}.tmp" "$url"
        fi

        mv "${target_path}.tmp" "$target_path"
        echo "[Download] $label completed."
        [ -f /app/test-r2.js ] && node /app/test-r2.js "step-${step_name}-done.txt" "Completed download: ${label}" || true
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

echo "===================================================="
echo "✅ All models downloaded and cached successfully!"
echo "===================================================="

# Keep the pod alive so you can inspect files or attach later
exec sleep infinity
