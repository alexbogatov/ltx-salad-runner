FROM nvidia/cuda:12.2.2-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install system dependencies, Python 3.10, and Node.js v20
RUN apt-get update && apt-get install -y \
    git wget curl python3-pip python3-dev ffmpeg libgl1-mesa-glx libglib2.0-0 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Install PyTorch with CUDA support
RUN pip3 install --no-cache-dir torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

# Clone ComfyUI Core
RUN git clone https://github.com/comfyanonymous/ComfyUI.git /workspace/ComfyUI \
    && cd /workspace/ComfyUI \
    && pip3 install --no-cache-dir -r requirements.txt

# Clone required LTX-Video custom nodes
RUN git clone https://github.com/Lightricks/ComfyUI-LTXVideo.git /workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo \
    && if [ -f /workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt ]; then \
         pip3 install --no-cache-dir -r /workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt; \
       fi

# Create target directories for model weights
RUN mkdir -p /workspace/ComfyUI/models/diffusion_models \
             /workspace/ComfyUI/models/text_encoders \
             /workspace/ComfyUI/models/vae \
             /workspace/ComfyUI/models/latent_upscale_models

# 1. Diffusion Model (22B Distilled INT8)
RUN --mount=type=secret,id=HF_TOKEN,env=HF_TOKEN \
    curl -fL --retry 5 -H "Authorization: Bearer ${HF_TOKEN}" \
      -o /workspace/ComfyUI/models/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors \
      "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"

# 2. Text Encoder A (Gemma 4 12B INT8)
RUN --mount=type=secret,id=HF_TOKEN,env=HF_TOKEN \
    curl -fL --retry 5 -H "Authorization: Bearer ${HF_TOKEN}" \
      -o /workspace/ComfyUI/models/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors \
      "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"

# 3. Text Encoder B (Gemma 4 E2B - Root Directory Path)
RUN --mount=type=secret,id=HF_TOKEN,env=HF_TOKEN \
    curl -fL --retry 5 -H "Authorization: Bearer ${HF_TOKEN}" \
      -o /workspace/ComfyUI/models/text_encoders/gemma4_e2b_it_bf16.safetensors \
      "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/gemma4_e2b_it_bf16.safetensors"

# 4. Video VAE
RUN --mount=type=secret,id=HF_TOKEN,env=HF_TOKEN \
    curl -fL --retry 5 -H "Authorization: Bearer ${HF_TOKEN}" \
      -o /workspace/ComfyUI/models/vae/ltx-2.5-video-vae-bf16.safetensors \
      "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-bf16.safetensors"

# 5. Audio VAE
RUN --mount=type=secret,id=HF_TOKEN,env=HF_TOKEN \
    curl -fL --retry 5 -H "Authorization: Bearer ${HF_TOKEN}" \
      -o /workspace/ComfyUI/models/vae/ltx-2.5-audio-vae-bf16.safetensors \
      "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors"

# 6. Latent Spatial Upscaler (LTX-2.3 Repository)
RUN --mount=type=secret,id=HF_TOKEN,env=HF_TOKEN \
    curl -fL --retry 5 -H "Authorization: Bearer ${HF_TOKEN}" \
      -o /workspace/ComfyUI/models/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors \
      "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
      
# Set up Node dependencies and application files
COPY package*.json ./
RUN npm install

COPY video_ltx2_5_i2v.json /workspace/video_ltx2_5_i2v.json
COPY test-runner.js /workspace/test-runner.js

EXPOSE 8188

CMD ["node", "test-runner.js"]
