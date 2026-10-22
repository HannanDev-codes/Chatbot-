# ⚡ Groq Chat — Full-Stack AI Chatbot

A polished ChatGPT-style chatbot powered by **Groq’s free API**.  
Backend: FastAPI + SQLite · Frontend: vanilla HTML/CSS/JS (no build step).

## What’s new (enhanced edition)

- **Login & Register** — multi-user accounts with JWT auth; each user only sees their own chats
- **Voice input** — click the mic button to dictate messages (browser Web Speech API)
- **Text-to-speech** — read the last reply aloud; optional auto-read in Settings
- **Refined UI** — cleaner typography, soft shadows, accent focus rings, message avatars, smoother animations
- **Dark / light mode** — follows system preference automatically
- **Mobile-ready** — collapsible sidebar, touch-friendly controls

## Features
- Streaming replies (Server-Sent Events)
- Chat history in SQLite (create, open, rename, delete)
- Multi-turn memory (last 20 messages)
- Model switcher (Llama 3.3 70B, Llama 3.1 8B, GPT-OSS 120B / 20B)
- Stop button (partial replies are saved)
- Markdown + syntax highlighting + copy button on code blocks
- Custom system prompt & temperature
- Friendly error messages (missing key, rate limit, network)

## Project structure
```
groq-chatbot/
├── backend/
│   ├── __init__.py
│   ├── main.py          # FastAPI app + auth + streaming
│   └── db.py            # SQLite: users, conversations, messages
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── requirements.txt
├── .env.example
└── .gitignore
```

## Setup

1. **Get a free Groq API key**  
   https://console.groq.com/keys → Create API Key (no credit card).

2. **Install dependencies**
   ```bash
   python -m venv venv
   # Windows:
   venv\Scripts\activate
   # Mac/Linux:
   source venv/bin/activate

   pip install -r requirements.txt
   ```

3. **Configure environment**  
   Copy `.env.example` to `.env` and fill in:
   ```
   GROQ_API_KEY=gsk_...
   JWT_SECRET=any-long-random-string-you-like
   ```

4. **Run**
   ```bash
   uvicorn backend.main:app --reload
   ```
   Open **http://localhost:8000**

## How to use

1. **Create an account** (or sign in) on the auth screen.
2. Start chatting — type or click the **mic** for voice input.
3. Use the speaker icon (or enable “Auto-read replies” in Settings) for TTS.
4. Switch models from the top-right dropdown.
5. Double-click a chat title in the sidebar to rename; trash icon to delete.

## API overview

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Sign in → JWT |
| GET | `/api/auth/me` | ✓ | Current user |
| GET | `/api/health` | — | Server + key status |
| GET | `/api/models` | — | Available models |
| GET/PATCH/DELETE | `/api/conversations…` | ✓ | Chat CRUD |
| POST | `/api/chat` | ✓ | Send message (SSE stream) |

## Notes

- **Voice** works best in Chrome / Edge (Web Speech API). Safari has partial support; Firefox limited.
- **JWT** expires after 72 hours (configurable via `JWT_EXPIRE_HOURS` in code).
- Free-tier rate limits apply. Switch to **Llama 3.1 8B** if you hit limits.
- Never commit `.env`. It is already in `.gitignore`.

## Ideas to extend further
- Password reset / email verification
- PDF upload + RAG (embeddings + ChromaDB)
- Deploy on Render / Railway with PostgreSQL
- React or Next.js frontend rewrite
