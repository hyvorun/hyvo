# The Hyvo runner: the engine and anvil in one image. Each job starts its own anvil (SPEC §3), so anvil is not a
# service of its own. The build context is the repo root, which compose.yaml sets, and .dockerignore keeps
# everything out of it but what is copied below.
FROM python:3.11-slim-bookworm

# Foundry's Linux builds need glibc 2.35 and bookworm has 2.36. The checksums are the release's own.
ARG FOUNDRY_VERSION=v1.7.1
ARG FOUNDRY_SHA256_AMD64=cf7e688ed0c4c48adffca788b496076e31060b67ac5afe1e43dbb5499c20c88b
ARG FOUNDRY_SHA256_ARM64=c8fe8fa09ae3aba2c81b510c6f9da3a9d468029b9580e690b245b3f0aea687ae
ARG UV_VERSION=0.11.24

# libcairo2: OASIS imports igraph, and igraph imports cairocffi, which loads it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libcairo2 \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sha="$FOUNDRY_SHA256_AMD64" ;; \
      arm64) sha="$FOUNDRY_SHA256_ARM64" ;; \
      *) echo "Foundry has no Linux build for $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/foundry.tar.gz \
      "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${arch}.tar.gz"; \
    echo "$sha  /tmp/foundry.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin anvil; \
    rm /tmp/foundry.tar.gz; \
    anvil --version

RUN pip install --no-cache-dir "uv==${UV_VERSION}"

RUN useradd --uid 10001 --create-home hyvo \
    && mkdir -p /app/engine /data \
    && chown -R hyvo:hyvo /app /data

USER hyvo
WORKDIR /app/engine

COPY --chown=hyvo:hyvo engine/pyproject.toml engine/uv.lock ./

# OASIS's recommender needs torch, and Hyvo replaces that recommender with a stand-in (hyvo/sim/oasis_boot.py), so about
# 4 GB of wheels on Linux are left out. tests/test_deploy_files.py plays a run with these packages out of reach.
RUN UV_PYTHON_DOWNLOADS=never UV_NO_CACHE=1 uv sync --frozen --no-dev --no-install-project \
    --no-install-package torch \
    --no-install-package triton \
    --no-install-package sentence-transformers \
    --no-install-package transformers \
    --no-install-package tokenizers \
    --no-install-package safetensors \
    --no-install-package nvidia-cublas-cu12 \
    --no-install-package nvidia-cuda-cupti-cu12 \
    --no-install-package nvidia-cuda-nvrtc-cu12 \
    --no-install-package nvidia-cuda-runtime-cu12 \
    --no-install-package nvidia-cudnn-cu12 \
    --no-install-package nvidia-cufft-cu12 \
    --no-install-package nvidia-cufile-cu12 \
    --no-install-package nvidia-curand-cu12 \
    --no-install-package nvidia-cusolver-cu12 \
    --no-install-package nvidia-cusparse-cu12 \
    --no-install-package nvidia-cusparselt-cu12 \
    --no-install-package nvidia-nccl-cu12 \
    --no-install-package nvidia-nvjitlink-cu12 \
    --no-install-package nvidia-nvshmem-cu12 \
    --no-install-package nvidia-nvtx-cu12

COPY --chown=hyvo:hyvo engine/LICENSE ./LICENSE
COPY --chown=hyvo:hyvo engine/hyvo ./hyvo
COPY --chown=hyvo:hyvo engine/examples ./examples
COPY --chown=hyvo:hyvo chain/artifacts /app/chain/artifacts

ENV PATH="/app/engine/.venv/bin:${PATH}" \
    PYTHONPATH=/app/engine \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    HYVO_NO_DOTENV=1 \
    HYVO_RUNS_DIR=/data/runs

CMD ["python", "-m", "hyvo", "--help"]
