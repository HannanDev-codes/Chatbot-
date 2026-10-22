"""
Groq Chat — FastAPI backend with auth, streaming, and multi-user support.

Run from the project root:
    uvicorn backend.main:app --reload
Then open http://localhost:8000
"""

import json
import os
import time
from pathlib import Path

import jwt
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from groq import (
    APIConnectionError,
    APIStatusError,
    AsyncGroq,
    AuthenticationError,
    RateLimitError,
)
from pydantic import BaseModel, EmailStr, Field

from backend import db

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

JWT_SECRET = os.getenv("JWT_SECRET", "change-me-in-production-please-use-a-long-random-string")
JWT_EXPIRE_HOURS = 72

MODELS = {
    "llama-3.3-70b-versatile": "Llama 3.3 70B · smartest",
    "llama-3.1-8b-instant": "Llama 3.1 8B · fastest",
    "openai/gpt-oss-120b": "GPT-OSS 120B · reasoning",
    "openai/gpt-oss-20b": "GPT-OSS 20B · balanced",
}
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "llama-3.3-70b-versatile")
DEFAULT_SYSTEM_PROMPT = (
    "You are a friendly, knowledgeable assistant. Answer clearly and concisely. "
    "Use markdown formatting and fenced code blocks (with the language name) when helpful."
)
HISTORY_LIMIT = 20
MAX_REPLY_TOKENS = 2048

app = FastAPI(title="Groq Chat")
db.init_db()
security = HTTPBearer(auto_error=False)

_client: AsyncGroq | None = None


def get_client() -> AsyncGroq | None:
    global _client
    key = os.getenv("GROQ_API_KEY", "").strip()
    if not key or key == "your-groq-api-key-here":
        return None
    if _client is None:
        _client = AsyncGroq(api_key=key)
    return _client


# ── Auth helpers ──────────────────────────────────────────────

def make_token(user: dict) -> str:
    payload = {
        "sub": user["id"],
        "username": user["username"],
        "exp": int(time.time()) + JWT_EXPIRE_HOURS * 3600,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(security),
) -> dict:
    if not creds:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"])
        user = db.get_user(payload["sub"])
        if not user:
            raise HTTPException(401, "User not found")
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired — please log in again")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")


# ── Schemas ───────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_]+$")
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)


class LoginRequest(BaseModel):
    login: str = Field(min_length=1, max_length=128)  # username or email
    password: str = Field(min_length=1, max_length=128)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    conversation_id: str | None = None
    model: str = DEFAULT_MODEL
    system_prompt: str | None = Field(default=None, max_length=4000)
    temperature: float = Field(default=0.7, ge=0, le=2)


class RenameRequest(BaseModel):
    title: str = Field(min_length=1, max_length=100)


def sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def make_title(text: str) -> str:
    title = " ".join(text.split())
    return title[:48] + "…" if len(title) > 48 else title


# ── Public routes ─────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"ok": True, "has_key": get_client() is not None}


@app.get("/api/models")
def models():
    return {
        "models": [{"id": k, "label": v} for k, v in MODELS.items()],
        "default": DEFAULT_MODEL if DEFAULT_MODEL in MODELS else next(iter(MODELS)),
    }


@app.post("/api/auth/register")
def register(body: RegisterRequest):
    user = db.create_user(body.username, body.email, body.password)
    if not user:
        raise HTTPException(409, "Username or email already taken")
    token = make_token(user)
    return {"token": token, "user": user}


@app.post("/api/auth/login")
def login(body: LoginRequest):
    user = db.authenticate(body.login, body.password)
    if not user:
        raise HTTPException(401, "Invalid username/email or password")
    token = make_token(user)
    return {"token": token, "user": user}


@app.get("/api/auth/me")
def me(user: dict = Depends(current_user)):
    return user


# ── Protected conversation routes ─────────────────────────────

@app.get("/api/conversations")
def list_conversations(user: dict = Depends(current_user)):
    return db.list_conversations(user["id"])


@app.get("/api/conversations/{cid}")
def get_conversation(cid: str, user: dict = Depends(current_user)):
    conv = db.get_conversation(cid, user["id"])
    if not conv:
        raise HTTPException(404, "Conversation not found")
    return {**conv, "messages": db.get_messages(cid)}


@app.patch("/api/conversations/{cid}")
def rename_conversation(cid: str, body: RenameRequest, user: dict = Depends(current_user)):
    if not db.rename_conversation(cid, body.title.strip(), user["id"]):
        raise HTTPException(404, "Conversation not found")
    return {"ok": True}


@app.delete("/api/conversations/{cid}")
def delete_conversation(cid: str, user: dict = Depends(current_user)):
    if not db.delete_conversation(cid, user["id"]):
        raise HTTPException(404, "Conversation not found")
    return {"ok": True}


@app.post("/api/chat")
async def chat(req: ChatRequest, user: dict = Depends(current_user)):
    if req.model not in MODELS:
        raise HTTPException(400, f"Unknown model: {req.model}")
    text = req.message.strip()
    if not text:
        raise HTTPException(400, "Message is empty")

    if req.conversation_id:
        conv = db.get_conversation(req.conversation_id, user["id"])
        if not conv:
            raise HTTPException(404, "Conversation not found")
    else:
        conv = db.create_conversation(user["id"], make_title(text), req.model)
    cid = conv["id"]

    db.add_message(cid, "user", text)
    history = db.get_messages(cid, limit=HISTORY_LIMIT)
    messages = [
        {
            "role": "system",
            "content": (req.system_prompt or "").strip() or DEFAULT_SYSTEM_PROMPT,
        }
    ]
    messages += [{"role": m["role"], "content": m["content"]} for m in history]

    async def event_stream():
        yield sse({"type": "meta", "conversation_id": cid, "title": conv["title"]})

        client = get_client()
        if client is None:
            yield sse({
                "type": "error",
                "message": "GROQ_API_KEY is not set. Add it to the .env file and restart the server.",
            })
            db.touch(cid, req.model)
            return

        reply: list[str] = []
        try:
            stream = await client.chat.completions.create(
                model=req.model,
                messages=messages,
                temperature=req.temperature,
                max_completion_tokens=MAX_REPLY_TOKENS,
                stream=True,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    reply.append(delta)
                    yield sse({"type": "delta", "content": delta})
            yield sse({"type": "done"})
        except AuthenticationError:
            yield sse({"type": "error", "message": "Invalid Groq API key. Check GROQ_API_KEY in your .env file."})
        except RateLimitError:
            yield sse({
                "type": "error",
                "message": "Free-tier rate limit reached. Wait a minute, or switch to Llama 3.1 8B (higher limits).",
            })
        except APIConnectionError:
            yield sse({"type": "error", "message": "Could not reach Groq. Check your internet connection."})
        except APIStatusError as e:
            yield sse({"type": "error", "message": f"Groq error {e.status_code}: {e.message}"})
        finally:
            if reply:
                db.add_message(cid, "assistant", "".join(reply))
            db.touch(cid, req.model)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Mount frontend last so /api/* takes priority
app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
