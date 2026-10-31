#!/usr/bin/env python3
"""Prepare an isolated, CPU-only runtime. Large downloads stay outside Git."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
CONFIG = json.loads((ROOT / "scripts/local-model.json").read_text())
VENV = RUNTIME / "venv"
PYTHON = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def download(url, destination, expected_size=None, expected_sha256=None):
    if destination.exists():
        data = destination.read_bytes()
        if (expected_size is None or len(data) == expected_size) and (
            expected_sha256 is None or hashlib.sha256(data).hexdigest() == expected_sha256
        ):
            return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    request = urllib.request.Request(url, headers={
        "User-Agent": "llum-local-setup",
        "Accept": "application/vnd.github.raw+json",
    })
    digest = hashlib.sha256()
    size = 0
    try:
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        if expected_size is not None and size != expected_size:
            raise ValueError(f"Unexpected download size: {size} != {expected_size}")
        if expected_sha256 is not None and digest.hexdigest() != expected_sha256:
            raise ValueError("SHA-256 mismatch; refusing to use the downloaded model")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Downloaded and verified {destination.name} ({size:,} bytes)", flush=True)


def main():
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise SystemExit("This pinned setup targets Linux x86_64. See LOCAL_MODEL.md for other platforms.")
    if sys.version_info < (3, 10):
        raise SystemExit("Python 3.10+ is required")
    RUNTIME.mkdir(exist_ok=True)
    if not PYTHON.exists():
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    env = os.environ.copy()
    env.update({
        "CMAKE_ARGS": "-DGGML_NATIVE=ON -DGGML_CUDA=OFF -DGGML_OPENMP=ON -DBUILD_SHARED_LIBS=OFF -DLLAMA_CURL=OFF",
        "CMAKE_BUILD_PARALLEL_LEVEL": "2",
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
    })
    subprocess.run([
        str(PYTHON), "-m", "pip", "install", "--no-binary", "llama-cpp-python",
        "-r", str(ROOT / "scripts/requirements-local.txt"),
    ], check=True, env=env)
    model = RUNTIME / "models" / CONFIG["file"]
    download(CONFIG["url"], model, CONFIG["size"], CONFIG["sha256"])
    download(
        f"https://api.github.com/repos/simonw/llm-smollm2/contents/LICENSE?ref={CONFIG['sourceCommit']}",
        RUNTIME / "models/LICENSE.Apache-2.0.txt",
    )
    (RUNTIME / "models/manifest.json").write_text(json.dumps(CONFIG, indent=2) + "\n")
    print("Local runtime ready. Run: npm run local", flush=True)


if __name__ == "__main__":
    main()
