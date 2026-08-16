docker run -d \
  --name ltx-worker \
  --restart unless-stopped \
  --gpus all \
  --uts host \
  --env-file /root/.env \
  -v /workspace:/workspace \
  ghcr.io/alexbogatov/ltx-salad-runner:sha-5ed59d0
