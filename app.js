// Groq Chat — frontend with auth, voice input, and TTS
const API = "/api";
const $ = (s) => document.querySelector(s);

const els = {
  authScreen: $("#auth-screen"), app: $("#app"),
  loginForm: $("#login-form"), regForm: $("#register-form"),
  loginError: $("#login-error"), regError: $("#reg-error"),
  sidebar: $("#sidebar"), scrim: $("#scrim"), menu: $("#menu-btn"),
  convList: $("#conv-list"), newChat: $("#new-chat"),
  chat: $("#chat"), empty: $("#empty"), messages: $("#messages"),
  form: $("#composer"), input: $("#input"), send: $("#send"), stop: $("#stop"),
  model: $("#model"), title: $("#chat-title"), keyWarning: $("#key-warning"),
  settingsBtn: $("#settings-btn"), settings: $("#settings"),
  sysPrompt: $("#system-prompt"), temp: $("#temperature"), tempVal: $("#temp-val"),
  micBtn: $("#mic-btn"), ttsBtn: $("#tts-btn"), autoTts: $("#auto-tts"),
  userName: $("#user-name"), userAvatar: $("#user-avatar"), logoutBtn: $("#logout-btn"),
};

const state = {
  convId: null, streaming: false, controller: null,
  token: null, user: null, listening: false, lastReply: "",
};

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const TRASH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';

// ── Auth ─────────────────────────────────────────────────────

function authHeaders() {
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) };
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (res.status === 401 && path !== "/auth/login" && path !== "/auth/register") {
    logout();
    throw new Error("Session expired — please sign in again");
  }
  return res;
}

function showAuth() {
  els.authScreen.hidden = false;
  els.app.hidden = true;
}

function showApp() {
  els.authScreen.hidden = true;
  els.app.hidden = false;
  if (state.user) {
    els.userName.textContent = state.user.username;
    els.userAvatar.textContent = state.user.username[0].toUpperCase();
  }
}

function logout() {
  state.token = null;
  state.user = null;
  state.convId = null;
  store.del("token");
  store.del("user");
  showAuth();
}

async function tryRestoreSession() {
  const token = store.get("token", null);
  const user = store.get("user", null);
  if (!token || !user) { showAuth(); return false; }
  state.token = token;
  state.user = user;
  try {
    const res = await api("/auth/me");
    if (!res.ok) throw new Error("bad token");
    state.user = await res.json();
    store.set("user", state.user);
    showApp();
    return true;
  } catch {
    logout();
    return false;
  }
}

// Auth tabs
document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const isLogin = tab.dataset.tab === "login";
    els.loginForm.hidden = !isLogin;
    els.regForm.hidden = isLogin;
    els.loginError.hidden = true;
    els.regError.hidden = true;
  });
});

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.loginError.hidden = true;
  const btn = els.loginForm.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        login: $("#login-user").value.trim(),
        password: $("#login-pass").value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Login failed");
    state.token = data.token;
    state.user = data.user;
    store.set("token", data.token);
    store.set("user", data.user);
    showApp();
    await initApp();
  } catch (err) {
    els.loginError.textContent = typeof err.message === "string" ? err.message : "Login failed";
    els.loginError.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

els.regForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.regError.hidden = true;
  const btn = els.regForm.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    const res = await fetch(`${API}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("#reg-user").value.trim(),
        email: $("#reg-email").value.trim(),
        password: $("#reg-pass").value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = Array.isArray(data.detail)
        ? data.detail.map((d) => d.msg).join(", ")
        : (data.detail || "Registration failed");
      throw new Error(msg);
    }
    state.token = data.token;
    state.user = data.user;
    store.set("token", data.token);
    store.set("user", data.user);
    showApp();
    await initApp();
  } catch (err) {
    els.regError.textContent = err.message || "Registration failed";
    els.regError.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Create account";
  }
});

els.logoutBtn.addEventListener("click", logout);

// ── Markdown ─────────────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: true });
const md = (text) => DOMPurify.sanitize(marked.parse(text || ""));

function enhanceCode(root) {
  root.querySelectorAll("pre code").forEach((code) => {
    if (code.dataset.done) return;
    code.dataset.done = "1";
    hljs.highlightElement(code);
    const btn = document.createElement("button");
    btn.className = "copy";
    btn.type = "button";
    btn.textContent = "Copy";
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(code.innerText); btn.textContent = "Copied!"; }
      catch { btn.textContent = "Failed"; }
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    };
    code.parentElement.appendChild(btn);
  });
}

// ── Rendering ────────────────────────────────────────────────

function scrollDown() { els.chat.scrollTop = els.chat.scrollHeight; }

function clearMessages() {
  els.messages.innerHTML = "";
  els.empty.hidden = false;
  els.ttsBtn.hidden = true;
  state.lastReply = "";
}

function addMessage(role, content = "") {
  els.empty.hidden = true;
  const row = document.createElement("div");
  row.className = `msg ${role}`;

  if (role === "assistant") {
    const av = document.createElement("div");
    av.className = "msg-avatar";
    av.textContent = "⚡";
    row.appendChild(av);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "user") {
    bubble.textContent = content;
  } else {
    bubble.innerHTML = md(content);
    enhanceCode(bubble);
  }
  row.appendChild(bubble);
  els.messages.appendChild(row);
  scrollDown();
  return bubble;
}

function showError(bubble, message) {
  const div = document.createElement("div");
  div.className = "error";
  div.textContent = message;
  bubble.appendChild(div);
  scrollDown();
}

function setStreaming(on) {
  state.streaming = on;
  els.send.hidden = on;
  els.stop.hidden = !on;
  updateSendButton();
}

function updateSendButton() {
  els.send.disabled = !els.input.value.trim() || state.streaming;
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + "px";
}

// ── Sidebar ──────────────────────────────────────────────────

function openSidebar() { els.sidebar.classList.add("open"); els.scrim.classList.add("show"); }
function closeSidebar() { els.sidebar.classList.remove("open"); els.scrim.classList.remove("show"); }

async function loadConversations() {
  let list = [];
  try {
    const res = await api("/conversations");
    if (res.ok) list = await res.json();
  } catch { /* offline */ }
  els.convList.innerHTML = "";
  if (!list.length) {
    els.convList.innerHTML = '<p class="empty-list">No chats yet</p>';
    return;
  }
  for (const c of list) {
    const item = document.createElement("div");
    item.className = "conv" + (c.id === state.convId ? " active" : "");
    item.title = "Click to open · double-click to rename";

    const title = document.createElement("span");
    title.className = "conv-title";
    title.textContent = c.title;

    const del = document.createElement("button");
    del.className = "icon-btn del";
    del.title = "Delete chat";
    del.innerHTML = TRASH;
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${c.title}"?`)) return;
      await api(`/conversations/${c.id}`, { method: "DELETE" });
      if (c.id === state.convId) newChat();
      loadConversations();
    };

    item.onclick = () => openConversation(c.id);
    item.ondblclick = async () => {
      const name = prompt("Rename chat", c.title);
      if (!name || !name.trim()) return;
      await api(`/conversations/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: name.trim().slice(0, 100) }),
      });
      if (c.id === state.convId) els.title.textContent = name.trim();
      loadConversations();
    };

    item.append(title, del);
    els.convList.appendChild(item);
  }
}

async function openConversation(id) {
  if (state.streaming) return;
  const res = await api(`/conversations/${id}`);
  if (!res.ok) return loadConversations();
  const data = await res.json();
  state.convId = id;
  clearMessages();
  data.messages.forEach((m) => addMessage(m.role, m.content));
  const lastAsst = [...data.messages].reverse().find((m) => m.role === "assistant");
  if (lastAsst) {
    state.lastReply = lastAsst.content;
    els.ttsBtn.hidden = false;
  }
  els.title.textContent = data.title;
  if ([...els.model.options].some((o) => o.value === data.model)) els.model.value = data.model;
  loadConversations();
  closeSidebar();
}

function newChat() {
  if (state.streaming) state.controller?.abort();
  state.convId = null;
  els.title.textContent = "New chat";
  clearMessages();
  loadConversations();
  closeSidebar();
  els.input.focus();
}

// ── Voice input (Web Speech API) ─────────────────────────────

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  recognition.onstart = () => {
    state.listening = true;
    els.micBtn.classList.add("listening");
    els.micBtn.title = "Listening… click to stop";
  };
  recognition.onend = () => {
    state.listening = false;
    els.micBtn.classList.remove("listening");
    els.micBtn.title = "Voice input";
  };
  recognition.onerror = () => {
    state.listening = false;
    els.micBtn.classList.remove("listening");
  };
  recognition.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += t;
      else interim += t;
    }
    if (final) {
      els.input.value = (els.input.value + " " + final).trim();
      autoGrow();
      updateSendButton();
    } else if (interim) {
      // show interim in placeholder feel — just update value temporarily
      els.input.placeholder = interim + "…";
    }
  };
} else {
  els.micBtn.style.display = "none";
}

els.micBtn.addEventListener("click", () => {
  if (!recognition) return;
  if (state.listening) {
    recognition.stop();
  } else {
    els.input.placeholder = "Listening…";
    try { recognition.start(); } catch { /* already started */ }
  }
});

// ── Text-to-speech ──────────────────────────────────────────

function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  // Strip markdown-ish noise for cleaner speech
  const clean = text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`[^`]+`/g, "")
    .replace(/[#*_>~\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
  if (!clean) return;
  const utt = new SpeechSynthesisUtterance(clean);
  utt.rate = 1.05;
  window.speechSynthesis.speak(utt);
}

els.ttsBtn.addEventListener("click", () => {
  if (state.lastReply) speak(state.lastReply);
});

// ── Chat ─────────────────────────────────────────────────────

async function sendMessage(raw) {
  const text = raw.trim();
  if (!text || state.streaming) return;

  addMessage("user", text);
  els.input.value = "";
  els.input.placeholder = "Message Groq Chat…  (Shift+Enter for new line)";
  autoGrow();

  const bubble = addMessage("assistant");
  bubble.classList.add("typing");
  setStreaming(true);
  state.controller = new AbortController();
  let reply = "";

  try {
    const res = await fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      signal: state.controller.signal,
      body: JSON.stringify({
        message: text,
        conversation_id: state.convId,
        model: els.model.value,
        system_prompt: els.sysPrompt.value.trim() || null,
        temperature: parseFloat(els.temp.value),
      }),
    });
    if (res.status === 401) {
      logout();
      throw new Error("Session expired — please sign in again");
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.detail === "string" ? err.detail : `Server error (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!line.startsWith("data:")) continue;
        const ev = JSON.parse(line.slice(5));

        if (ev.type === "meta") {
          const isNew = !state.convId;
          state.convId = ev.conversation_id;
          els.title.textContent = ev.title;
          if (isNew) loadConversations();
        } else if (ev.type === "delta") {
          reply += ev.content;
          bubble.classList.remove("typing");
          bubble.innerHTML = md(reply);
          scrollDown();
        } else if (ev.type === "error") {
          bubble.classList.remove("typing");
          showError(bubble, ev.message);
        }
      }
    }
  } catch (e) {
    bubble.classList.remove("typing");
    if (e.name === "AbortError") {
      if (!reply) bubble.innerHTML = md("_Stopped._");
    } else {
      showError(bubble, e.message || "Network error — is the server running?");
    }
  } finally {
    bubble.classList.remove("typing");
    if (reply) {
      enhanceCode(bubble);
      state.lastReply = reply;
      els.ttsBtn.hidden = false;
      if (els.autoTts.checked) speak(reply);
    }
    setStreaming(false);
    state.controller = null;
    loadConversations();
  }
}

// ── Init ─────────────────────────────────────────────────────

async function initApp() {
  try {
    const { models, default: def } = await (await api("/models")).json();
    els.model.innerHTML = "";
    for (const m of models) els.model.add(new Option(m.label, m.id));
    const saved = store.get("model", def);
    els.model.value = models.some((m) => m.id === saved) ? saved : def;
  } catch {
    els.model.innerHTML = "";
    els.model.add(new Option("Server offline", ""));
  }

  try {
    const health = await (await fetch(`${API}/health`)).json();
    els.keyWarning.hidden = health.has_key;
  } catch {}

  els.sysPrompt.value = store.get("systemPrompt", "");
  els.temp.value = store.get("temperature", 0.7);
  els.tempVal.textContent = els.temp.value;
  els.autoTts.checked = store.get("autoTts", false);

  loadConversations();
  updateSendButton();
  els.input.focus();
}

els.form.addEventListener("submit", (e) => { e.preventDefault(); sendMessage(els.input.value); });
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage(els.input.value);
  }
});
els.input.addEventListener("input", () => { autoGrow(); updateSendButton(); });
els.stop.addEventListener("click", () => state.controller?.abort());
els.newChat.addEventListener("click", newChat);
els.menu.addEventListener("click", openSidebar);
els.scrim.addEventListener("click", closeSidebar);
els.model.addEventListener("change", () => store.set("model", els.model.value));
els.settingsBtn.addEventListener("click", () => els.settings.showModal());
els.sysPrompt.addEventListener("input", () => store.set("systemPrompt", els.sysPrompt.value));
els.temp.addEventListener("input", () => {
  els.tempVal.textContent = els.temp.value;
  store.set("temperature", parseFloat(els.temp.value));
});
els.autoTts.addEventListener("change", () => store.set("autoTts", els.autoTts.checked));
document.querySelectorAll(".chip").forEach((chip) =>
  chip.addEventListener("click", () => sendMessage(chip.dataset.prompt))
);

// Boot
(async () => {
  const ok = await tryRestoreSession();
  if (ok) await initApp();
})();
