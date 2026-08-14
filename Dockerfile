FROM nvidia/cuda:12.2.2-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install system dependencies, Python 3.10, and Node.js v20
RUN apt-get update && apt-get install -y \
    git wget curl python3-pip python3-dev ffmpeg libgl1-mesa-glx libglib2.0-0 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Work in /app so /workspace can be mounted cleanly
WORKDIR /app

# Install PyTorch 2.5.1 with CUDA 12.4 support
RUN pip3 install --no-cache-dir \
    torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 \
    --extra-index-url https://download.pytorch.org/whl/cu124

# Clone ComfyUI Core and install dependencies
RUN git clone https://github.com/comfyanonymous/ComfyUI.git /app/ComfyUI \
    && cd /app/ComfyUI \
    && pip3 install --no-cache-dir -r requirements.txt

# Clone required LTX-Video custom nodes
RUN git clone https://github.com/Lightricks/ComfyUI-LTXVideo.git /app/ComfyUI/custom_nodes/ComfyUI-LTXVideo \
    && if [ -f /app/ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt ]; then \
         pip3 install --no-cache-dir -r /app/ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt; \
       fi

# Setup Node dependencies and application files
COPY package*.json ./
RUN npm install

COPY video_ltx2_5_i2v.json /app/video_ltx2_5_i2v.json
COPY test-runner.js /app/test-runner.js
COPY test-r2.js /app/test-r2.js
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create /workspace directory for RunPod mount point
RUN mkdir -p /workspace

EXPOSE 8188

ENTRYPOINT ["/bin/bash", "/app/entrypoint.sh"]
