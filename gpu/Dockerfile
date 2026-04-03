# APoW GPU Nonce Grinder — RunPod Serverless
#
# Builds grinder-cuda from source inside a CUDA devel image.
# Using CUDA 12.2 for broad driver compatibility (requires driver >= 525.60).
# CUDA 12.6 required driver >= 560.28 which many RunPod GPUs don't have.
#
# Build:  docker build --platform linux/amd64 -t grind-proxy-gpu .
# Deploy: Push to GHCR, then create RunPod serverless endpoint.

FROM nvidia/cuda:12.2.2-devel-ubuntu22.04

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    pip3 install runpod && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy CUDA grinder source and compile for all modern GPUs (sm_80+)
# sm_80 = A100, sm_86 = RTX 3090/A5000, sm_89 = RTX 4090/L4
COPY grinder-cuda.cu /app/grinder-cuda.cu
RUN nvcc /app/grinder-cuda.cu -o /app/grinder-cuda -std=c++17 -O3 \
    -gencode arch=compute_80,code=sm_80 \
    -gencode arch=compute_86,code=sm_86 \
    -gencode arch=compute_89,code=sm_89

COPY handler.py /app/handler.py

CMD ["python3", "handler.py"]
