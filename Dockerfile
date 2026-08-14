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

# Install PyTorch 2.5.1 with CUDA 12.4 support (fixes custom_op / comfy_kitchen)
RUN pip3 install --no-cache-dir \
    torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 \
    --extra-index-url https://download.pytorch.org/whl/cu124

# Clone ComfyUI Core and install dependencies
RUN git clone https://github.com/comfyanonymous/ComfyUI.git /workspace/ComfyUI \
    && cd /workspace/ComfyUI \
    && pip3 install --no-cache-dir -r requirements.txt

# Clone required LTX-Video custom nodes and install dependencies
RUN git clone https://github.com/Lightricks/ComfyUI-LTXVideo.git /workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo \
    && if [ -f /workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt ]; then \
         pip3 install --no-cache-dir -r /workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt; \
       fi

# Set up Node dependencies and application files
COPY package*.json ./
RUN npm install

# Application & Helper Scripts
COPY video_ltx2_5_i2v.json /workspace/video_ltx2_5_i2v.json
COPY test-runner.js /workspace/test-runner.js
COPY test-r2.js /workspace/test-r2.js
COPY entrypoint.sh /workspace/entrypoint.sh
RUN chmod +x /workspace/entrypoint.sh

EXPOSE 8188

ENTRYPOINT ["/bin/bash", "/workspace/entrypoint.sh"]
