#!/usr/bin/env python3
"""Authenticated loopback inference API, backed by the actual llama.cpp engine."""
import json
import os
from pathlib import Path
import secrets

import uvicorn
from fastapi import Request
from fastapi.responses import JSONResponse
from llama_cpp.server.app import create_app
from llama_cpp.server.settings import ModelSettings, ServerSettings

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "scripts/local-model.json").read_text())
MODEL_PATH = ROOT / ".runtime/models" / CONFIG["file"]
MAX_BODY_BYTES = 32 * 1024
ALLOWED_PATHS = {"/health", "/v1/models", "/v1/chat/completions"}
ALLOWED_FIELDS = {
    "model", "messages", "stream", "temperature", "max_tokens", "top_p", "stop", "seed",
    "top_k", "repeat_penalty", "frequency_penalty",
}
SAMPLING_DEFAULTS = CONFIG["sampling"]
SAMPLING_LIMITS = CONFIG["samplingLimits"]
ANTI_REPETITION_INSTRUCTION = (
    "Answer the user's latest request once, directly, and then stop. "
    "Do not repeat sentences, phrases, or dialogue lines. "
    "Do not continue the user's turn or invent extra conversation turns. "
    "If the answer is complete, end the response."
)
SYSTEM_MESSAGE = {
    "role": "system",
    "content": "You are a helpful, concise assistant running locally. Answer the question directly. "
    "Use the user's language when you can. Do not invent facts. Keep answers short. "
    + ANTI_REPETITION_INSTRUCTION,
}


def apply_hard_instructions(messages):
    """Keep the user's system prompt, but append the local anti-loop rule to the first system turn."""
    for message in messages:
        if message["role"] == "system":
            if ANTI_REPETITION_INSTRUCTION not in message["content"]:
                message["content"] = (message["content"].rstrip() + "\n\n" + ANTI_REPETITION_INSTRUCTION).strip()
            return messages
    messages.insert(0, SYSTEM_MESSAGE.copy())
    return messages


def validation_error(message):
    return JSONResponse({"error": {"message": message, "type": "invalid_request_error"}}, status_code=400)


def create_local_app():
    if not MODEL_PATH.is_file():
        raise RuntimeError("Model weights are missing. Run python3 scripts/setup-local.py first.")
    api_key = os.environ.get("LOCAL_MODEL_TOKEN")
    if not api_key:
        raise RuntimeError("LOCAL_MODEL_TOKEN must be supplied by the local gateway")
    model_settings = ModelSettings(
        model=str(MODEL_PATH),
        model_alias=CONFIG["id"],
        n_gpu_layers=0,
        n_ctx=CONFIG["contextTokens"],
        n_batch=256,
        n_ubatch=256,
        n_threads=CONFIG["threads"],
        n_threads_batch=CONFIG["threads"],
        last_n_tokens_size=CONFIG["penaltyLastN"],
        chat_format="chatml",
        use_mlock=False,
        verbose=False,
        seed=42,
    )
    app = create_app(
        server_settings=ServerSettings(
            api_key=api_key, interrupt_requests=False, disable_ping_events=True,
        ),
        model_settings=[model_settings],
    )
    # Do not expose prompt-bearing server utilities, docs, or completion endpoints.
    app.openapi_url = app.docs_url = app.redoc_url = None

    @app.middleware("http")
    async def restrict_api(request: Request, call_next):
        if request.url.path not in ALLOWED_PATHS:
            return JSONResponse({"error": {"message": "Endpoint not available"}}, status_code=404)
        if request.url.path == "/health":
            return JSONResponse({
                "status": "ready", "model": CONFIG["id"], "engine": "llama.cpp",
                "device": "cpu", "quantization": "Q4_1", "parameters": "135M",
                "contextTokens": CONFIG["contextTokens"], "license": CONFIG["license"],
                "weightBytes": CONFIG["size"], "threads": CONFIG["threads"],
                "penaltyLastN": CONFIG["penaltyLastN"],
                "sampling": SAMPLING_DEFAULTS, "samplingLimits": SAMPLING_LIMITS,
                "antiRepetition": True,
            })
        authorization = request.headers.get("authorization", "")
        expected = "Bearer " + api_key
        if not secrets.compare_digest(authorization, expected):
            return JSONResponse({"error": {"message": "Unauthorized"}}, status_code=401)
        if request.url.path == "/v1/models":
            if request.method != "GET":
                return JSONResponse({"error": {"message": "Use GET"}}, status_code=405)
            return await call_next(request)
        if request.method != "POST":
            return JSONResponse({"error": {"message": "Use POST"}}, status_code=405)
        try:
            if int(request.headers.get("content-length", "0")) > MAX_BODY_BYTES:
                return validation_error("Prompt is too large; maximum request size is 32 KiB")
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > MAX_BODY_BYTES:
                    return validation_error("Prompt is too large; maximum request size is 32 KiB")
            payload = json.loads(body)
            if not isinstance(payload, dict) or set(payload) - ALLOWED_FIELDS:
                return validation_error("Only text chat parameters are supported by this local model")
            messages = payload.get("messages")
            if not isinstance(messages, list) or not 1 <= len(messages) <= 64:
                return validation_error("Provide between 1 and 64 text messages")
            for message in messages:
                if not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant"}:
                    return validation_error("Unsupported message role")
                if not isinstance(message.get("content"), str) or set(message) - {"role", "content"}:
                    return validation_error("This model supports text only, without tools or images")
            if sum(len(m["content"]) for m in messages) > 24000:
                return validation_error("Prompt exceeds the local text limit; start a new chat")
            if messages[-1]["role"] != "user" or not messages[-1]["content"].strip():
                return validation_error("The final message must be a non-empty user message")
            if not isinstance(payload.get("stream", False), bool):
                return validation_error("stream must be a boolean")
            for field, (minimum, maximum) in SAMPLING_LIMITS.items():
                default = SAMPLING_DEFAULTS[field]
                value = payload.get(field, default)
                if field == "top_k":
                    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
                        return validation_error(f"top_k must be an integer between {minimum} and {maximum}")
                else:
                    if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
                        return validation_error(f"{field} must be between {minimum} and {maximum}")
                payload[field] = value
            tokens = payload.get("max_tokens", CONFIG["defaultOutputTokens"])
            if isinstance(tokens, bool) or not isinstance(tokens, int) or not 1 <= tokens <= CONFIG["maxOutputTokens"]:
                return validation_error(f"max_tokens must be between 1 and {CONFIG['maxOutputTokens']}")
            payload["messages"] = apply_hard_instructions(messages)
            payload.update(model=CONFIG["id"], max_tokens=tokens)
            # Starlette reuses this cached body in the downstream Pydantic parser.
            request._body = json.dumps(payload).encode()
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            return validation_error("Invalid JSON request")
        return await call_next(request)

    return app


if __name__ == "__main__":
    uvicorn.run(
        create_local_app(), host="127.0.0.1",
        port=int(os.environ.get("LOCAL_MODEL_PORT", "8080")),
        access_log=False, log_level="warning", timeout_keep_alive=5,
    )
