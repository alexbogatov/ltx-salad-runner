#!/bin/bash
set -e

echo "===================================================="
echo "[Startup] Initializing LTX 2.5 Runner Environment"
echo "===================================================="

R2_CDN="https://cdn.runltx.com/models"

# Storage target on network drive
STORAGE_DIR="/workspace/models"
mkdir -p "${STORAGE_DIR}/diffusion_models" \
         "${STORAGE_DIR}/text_encoders" \
         "${STORAGE_DIR}/vae" \
         "${STORAGE_DIR}/latent_upscale_models"

# Symlink ComfyUI models folder to the persistent volume
rm -rf /app/ComfyUI/models/diffusion_models && ln -s "${STORAGE_DIR}/diffusion_models" /app/ComfyUI/models/diffusion_models
rm -rf /app/ComfyUI/models/text_encoders && ln -s "${STORAGE_DIR}/text_encoders" /app/ComfyUI/models/text_encoders
rm -rf /app/ComfyUI/models/vae && ln -s "${STORAGE_DIR}/vae" /app/ComfyUI/models/vae
rm -rf /app/ComfyUI/models/latent_upscale_models && ln -s "${STORAGE_DIR}/latent_upscale_models" /app/ComfyUI/models/latent_upscale_models

# Signal 0: Container started
node /app/test-r2.js "step-0-container-started.txt" "Container environment loaded successfully" || true

fetch_weight() {
    local target_path=$1
    local url=$2
    local label=$3
    local step_name=$4

    if [ ! -f "$target_path" ]; then
        echo "[Download] Fetching $label..."
        node /app/test-r2.js "step-${step_name}-start.txt" "Starting download: ${label}" || true

        if ! curl -fL --retry 10 --retry-delay 2 --retry-all-errors -C - -o "$target_path" "$url"; then
            echo "[ERROR] Failed to download $label from $url"
            node /app/test-r2.js "error-${step_name}-failed.txt" "Download failed for: ${label}" || true
            exit 1
        fi
        
        echo "[Download] $label completed."
        node /app/test-r2.js "step-${step_name}-done.txt" "Completed download: ${label}" || true
    else
        echo "[Check] $label already exists locally."
        node /app/test-r2.js "step-${step_name}-cached.txt" "Weight already exists locally: ${label}" || true
    fi
}

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
echo "[Startup] All model weights verified. Starting test-runner..."
echo "===================================================="

node /app/test-r2.js "step-7-downloads-complete.txt" "All weights downloaded successfully. Executing test-runner.js" || true

cd /app
exec node test-runner.js
