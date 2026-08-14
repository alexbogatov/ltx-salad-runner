#!/bin/bash
set -e

echo "===================================================="
echo "[Startup] Initializing LTX 2.5 Runner Environment"
echo "===================================================="

# Base CDN URL for models hosted on Cloudflare R2
R2_CDN="https://cdn.runltx.com/models"

# Ensure target directories exist
mkdir -p /workspace/ComfyUI/models/diffusion_models \
         /workspace/ComfyUI/models/text_encoders \
         /workspace/ComfyUI/models/vae \
         /workspace/ComfyUI/models/latent_upscale_models

# Signal 0: Container started
node test-r2.js "step-0-container-started.txt" "Container environment loaded successfully" || true

# Helper function to download weights dynamically
fetch_weight() {
    local target_path=$1
    local url=$2
    local label=$3
    local step_name=$4

    if [ ! -f "$target_path" ]; then
        echo "[Download] Fetching $label..."
        node test-r2.js "step-${step_name}-start.txt" "Starting download: ${label}" || true

        # -C - enables auto-resume from byte offset if connection drops
        # --retry-all-errors ensures retries on 5xx, 429, timeouts, and network drops
        if ! curl -fL --retry 10 --retry-delay 2 --retry-all-errors -C - -o "$target_path" "$url"; then
            echo "[ERROR] Failed to download $label from $url"
            node test-r2.js "error-${step_name}-failed.txt" "Download failed for: ${label}" || true
            exit 1
        fi
        
        echo "[Download] $label completed."
        node test-r2.js "step-${step_name}-done.txt" "Completed download: ${label}" || true
    else
        echo "[Check] $label already exists locally."
        node test-r2.js "step-${step_name}-cached.txt" "Weight already exists locally: ${label}" || true
    fi
}

# 1. Diffusion Model (22B Distilled INT8)
fetch_weight "/workspace/ComfyUI/models/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" \
             "${R2_CDN}/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" \
             "Diffusion Model (22B Distilled INT8)" \
             "1-diffusion"

# 2. Text Encoder A (Gemma 4 12B INT8)
fetch_weight "/workspace/ComfyUI/models/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" \
             "${R2_CDN}/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" \
             "Text Encoder A (Gemma 4 12B INT8)" \
             "2-text-encoder-a"

# 3. Text Encoder B (Gemma 4 12B BF16)
fetch_weight "/workspace/ComfyUI/models/text_encoders/gemma4_e2b_it_bf16.safetensors" \
             "${R2_CDN}/text_encoders/gemma4_e2b_it_bf16.safetensors" \
             "Text Encoder B (Gemma 4 12B BF16)" \
             "3-text-encoder-b"

# 4. Video VAE
fetch_weight "/workspace/ComfyUI/models/vae/ltx-2.5-video-vae-bf16.safetensors" \
             "${R2_CDN}/vae/ltx-2.5-video-vae-bf16.safetensors" \
             "Video VAE" \
             "4-video-vae"

# 5. Audio VAE
fetch_weight "/workspace/ComfyUI/models/vae/ltx-2.5-audio-vae-bf16.safetensors" \
             "${R2_CDN}/vae/ltx-2.5-audio-vae-bf16.safetensors" \
             "Audio VAE" \
             "5-audio-vae"

# 6. Latent Spatial Upscaler
fetch_weight "/workspace/ComfyUI/models/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" \
             "${R2_CDN}/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" \
             "Latent Spatial Upscaler" \
             "6-upscaler"

echo "===================================================="
echo "[Startup] All model weights verified. Starting test-runner..."
echo "===================================================="

node test-r2.js "step-7-downloads-complete.txt" "All weights downloaded successfully. Executing test-runner.js" || true

exec node test-runner.js
