#!/bin/bash
set -e

echo "===================================================="
echo "[Startup] Initializing LTX 2.5 Runner Environment"
echo "===================================================="

# Ensure target directories exist
mkdir -p /workspace/ComfyUI/models/diffusion_models \
         /workspace/ComfyUI/models/text_encoders \
         /workspace/ComfyUI/models/vae \
         /workspace/ComfyUI/models/latent_upscale_models

# Helper function to download weights dynamically
fetch_weight() {
    local target_path=$1
    local url=$2
    local label=$3

    if [ ! -f "$target_path" ]; then
        echo "[Download] Fetching $label..."
        if [ -n "$HF_TOKEN" ]; then
            curl -fL --retry 5 -H "Authorization: Bearer ${HF_TOKEN}" -o "$target_path" "$url"
        else
            curl -fL --retry 5 -o "$target_path" "$url"
        fi
        echo "[Download] $label completed."
    else
        echo "[Check] $label already exists locally."
    fi
}

# 1. Diffusion Model
fetch_weight "/workspace/ComfyUI/models/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" \
             "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" \
             "Diffusion Model (22B Distilled INT8)"

# 2. Text Encoder A
fetch_weight "/workspace/ComfyUI/models/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" \
             "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" \
             "Text Encoder A (Gemma 4 12B INT8)"

# 3. Text Encoder B
fetch_weight "/workspace/ComfyUI/models/text_encoders/gemma4_e2b_it_bf16.safetensors" \
             "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors" \
             "Text Encoder B (Gemma 4 12B BF16)"

# 4. Video VAE
fetch_weight "/workspace/ComfyUI/models/vae/ltx-2.5-video-vae-bf16.safetensors" \
             "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-bf16.safetensors" \
             "Video VAE"

# 5. Audio VAE
fetch_weight "/workspace/ComfyUI/models/vae/ltx-2.5-audio-vae-bf16.safetensors" \
             "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors" \
             "Audio VAE"

# 6. Latent Spatial Upscaler
fetch_weight "/workspace/ComfyUI/models/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" \
             "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors" \
             "Latent Spatial Upscaler"

echo "===================================================="
echo "[Startup] All model weights verified. Starting test-runner..."
echo "===================================================="

exec node test-runner.js
