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

# Declare the Hugging Face token build argument
ARG HF_TOKEN

# Download LTX 2.5 FP8 Model Weights using the auth header
RUN mkdir -p /workspace/ComfyUI/models/checkpoints && \
    curl -fL --retry 5 --retry-delay 5 \
    -H "Authorization: Bearer ${HF_TOKEN}" \
    -o /workspace/ComfyUI/models/checkpoints/ltx-video-2.5-v2-fp8.safetensors \
    "https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2.5-v2-fp8.safetensors"

# Set up Node dependencies and application files
COPY package*.json ./
RUN npm install

COPY video_ltx2_5_i2v.json /workspace/video_ltx2_5_i2v.json
COPY test-runner.js /workspace/test-runner.js

EXPOSE 8188

CMD ["node", "test-runner.js"]
