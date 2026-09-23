/* ===========================================================
   SALTZY — app.js
   Tabs, game loading, chat (Firebase-ready with local fallback)
   =========================================================== */

/* -----------------------------------------------------------
   0. GLOBAL CHAT BACKEND — ntfy.sh
   -----------------------------------------------------------
   ntfy.sh is a free, public, no-signup pub/sub service — perfect
   for a lightweight global chat with zero setup. A "topic" is
   just a room name; anyone who knows it can read/post to it, so
   it's picked to be unique. Messages are cached there for ~12h
   so late joiners see recent history.

   Want your OWN private room instead of the shared default one?
   Change CHAT_TOPIC to any string only your people know — that's
   the entire setup, no account needed. See README.md for details,
   including how to self-host ntfy or swap in Firebase instead.
----------------------------------------------------------- */
const NTFY_BASE = "https://ntfy.sh";
const CHAT_TOPIC = "9rYuTBZN0evM2phm";

/* -----------------------------------------------------------
   1. TABS
----------------------------------------------------------- */
const tabButtons = document.querySelectorAll(".tab-btn");
const views = {
  games: document.getElementById("view-games"),
  chat: document.getElementById("view-chat"),
  updates: document.getElementById("view-updates")
};

let currentTab = "games"; // tracks which tab was open, so we can detect *leaving* Games

function activateTab(name) {
  // Leaving Games while a round is open? Tear the game down first so it
  // stops capturing keyboard input (that's what was blocking chat typing).
  if (currentTab === "games" && name !== "games" && stageView.classList.contains("active")) {
    stopGame();
  }
  currentTab = name;

  tabButtons.forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  Object.entries(views).forEach(([key, el]) => el.classList.toggle("active", key === name));

  if (name === "chat") {
    onChatTabOpened();
    setTimeout(() => chatInput.focus(), 50); // belt-and-suspenders: reclaim focus
  }
}

tabButtons.forEach(btn => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

activateTab("games");

/* -----------------------------------------------------------
   2. GAME STAGE — load the Unity build on demand
----------------------------------------------------------- */
const gameGridView = document.getElementById("game-grid-view");
const stageView = document.getElementById("stage-view");
const stageFrame = document.getElementById("stage-frame");
const gameFrameHolder = document.getElementById("gameFrameHolder");
const splash = document.getElementById("unity-splash");
const splashFill = document.getElementById("splash-fill");
const splashLabel = document.getElementById("splash-label");

// Every game lives in its own small HTML file (play-slope.html,
// play-newgame.html, etc.) loaded here inside an iframe. That's what makes
// teardown reliable: removing an iframe from the DOM immediately and
// guaranteedly kills everything running inside it — JS, WASM, audio
// context, animation loop — with no cooperation needed from the game's
// own code. Progress/ready state is relayed back up via postMessage.
//
// To add another game: add a new .game-card in index.html with a
// .play-game-btn button carrying data-entry="your-file.html" and
// data-label="Your Game Name" — no changes needed here.
let gameFrame = null;
let gameLoaded = false;
let activeLabel = "";

function openGame(entryUrl, label) {
  activeLabel = label || "Game";
  gameGridView.style.display = "none";
  stageView.classList.add("active");

  if (gameLoaded) return; // already running — just re-show

  splash.classList.remove("hidden");
  splashFill.style.width = "0%";
  splashLabel.textContent = "Loading " + activeLabel + "\u2026";

  gameFrame = document.createElement("iframe");
  gameFrame.title = activeLabel;
  gameFrame.src = entryUrl;
  gameFrame.setAttribute("allow", "autoplay");
  gameFrame.style.cssText = "width:100%; height:100%; border:0; display:block;";
  gameFrameHolder.appendChild(gameFrame);

  gameLoaded = true;
}

window.addEventListener("message", event => {
  if (event.origin !== window.location.origin) return;
  if (!gameFrame || event.source !== gameFrame.contentWindow) return;
  const data = event.data || {};

  if (data.type === "progress") {
    const pct = Math.round((data.progress || 0) * 100);
    splashFill.style.width = pct + "%";
    splashLabel.textContent = pct < 100 ? "Loading " + activeLabel + "\u2026 " + pct + "%" : "Starting\u2026";
  } else if (data.type === "ready") {
    splash.classList.add("hidden");
  }
});

// Fully tears the game down — used by Back to Games AND by activateTab()
// whenever someone switches to Chat/Updates while a round is still open.
// Removing the iframe (rather than just hiding the stage) is what fixes
// both bugs at once: it stops the music/audio immediately, and it releases
// whatever kept swallowing keyboard input so chat can be typed into again.
function stopGame() {
  stageView.classList.remove("active");
  gameGridView.style.display = "";

  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }

  if (gameFrame) {
    gameFrame.remove();
    gameFrame = null;
  }

  gameLoaded = false; // force a fresh load next time Play is pressed
}

document.querySelectorAll(".play-game-btn").forEach(btn => {
  btn.addEventListener("click", () => openGame(btn.dataset.entry, btn.dataset.label));
});
document.getElementById("back-to-games").addEventListener("click", stopGame);

document.getElementById("fullscreen-btn").addEventListener("click", () => {
  if (stageFrame.requestFullscreen) stageFrame.requestFullscreen();
  else if (stageFrame.webkitRequestFullscreen) stageFrame.webkitRequestFullscreen();
});

/* -----------------------------------------------------------
   3. CHAT
----------------------------------------------------------- */
const NAME_KEY = "saltzy_display_name";

const nameModal = document.getElementById("name-modal");
const nameInput = document.getElementById("name-input");
const nameJoinBtn = document.getElementById("name-join-btn");
const nameError = document.getElementById("name-error");

const chatMessagesEl = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const chatWhoamiName = document.getElementById("chat-whoami-name");
const chatChangeNameBtn = document.getElementById("chat-change-name");
const chatModeBadge = document.getElementById("chat-mode-badge");

let displayName = localStorage.getItem(NAME_KEY) || "";
let chatInitialized = false;
let sseSource = null;

chatModeBadge.textContent = "Live";

function onChatTabOpened() {
  if (!displayName) {
    nameModal.classList.add("active");
    nameInput.value = "";
    nameError.textContent = "";
    setTimeout(() => nameInput.focus(), 50);
  } else {
    initChatUI();
  }
}

function sanitizeName(raw) {
  return raw.replace(/\s+/g, " ").trim().slice(0, 20);
}

function joinChat() {
  const clean = sanitizeName(nameInput.value);
  if (!clean) {
    nameError.textContent = "Enter a display name to continue.";
    return;
  }
  if (clean.length < 2) {
    nameError.textContent = "That name's a little short \u2014 try 2+ characters.";
    return;
  }
  displayName = clean;
  localStorage.setItem(NAME_KEY, displayName);
  nameModal.classList.remove("active");
  initChatUI();
}

nameJoinBtn.addEventListener("click", joinChat);
nameInput.addEventListener("keydown", e => { if (e.key === "Enter") joinChat(); });

chatChangeNameBtn.addEventListener("click", () => {
  nameModal.classList.add("active");
  nameInput.value = displayName;
  nameError.textContent = "";
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
});

function initChatUI() {
  chatWhoamiName.textContent = displayName;

  if (!chatInitialized) {
    chatInitialized = true;
    initNtfyChat();

    chatSendBtn.addEventListener("click", sendMessage);
    chatInput.addEventListener("keydown", e => {
      if (e.key === "Enter") sendMessage();
    });
  }
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";

  const msg = { name: displayName, text: text.slice(0, 500), ts: Date.now() };

  try {
    await fetch(`${NTFY_BASE}/${CHAT_TOPIC}`, {
      method: "POST",
      body: JSON.stringify(msg)
    });
    // No local render here — the live SSE subscription below echoes our
    // own message back, so every client (including us) renders once.
  } catch (err) {
    console.error("Saltzy chat: failed to send", err);
    renderSystemNote("Couldn't send that \u2014 check your connection and try again.");
  }
}

function renderMessage(msg) {
  const mine = msg.name === displayName;
  const wrap = document.createElement("div");
  wrap.className = "msg" + (mine ? " me" : "");

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const time = new Date(msg.ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.innerHTML = (mine ? "" : `<b>${escapeHtml(msg.name)}</b>`) + `<span>${time}</span>`;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = msg.text;

  wrap.appendChild(meta);
  wrap.appendChild(bubble);

  const wasNearBottom = chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < 120;
  const emptyState = chatMessagesEl.querySelector(".chat-empty");
  if (emptyState) emptyState.remove();

  chatMessagesEl.appendChild(wrap);
  if (wasNearBottom) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* --- Live global chat via ntfy.sh (https://ntfy.sh/CHAT_TOPIC) ---
   1. On open: pull recent cached history (poll=1) and render it.
   2. Then: open a live SSE stream so every new message from anyone,
      anywhere, appears immediately — including our own sends. */
function renderSystemNote(text) {
  const note = document.createElement("div");
  note.className = "chat-empty";
  note.textContent = text;
  chatMessagesEl.appendChild(note);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function clearEmptyState() {
  const emptyState = chatMessagesEl.querySelector(".chat-empty");
  if (emptyState) emptyState.remove();
}

async function loadChatHistory() {
  try {
    const res = await fetch(`${NTFY_BASE}/${CHAT_TOPIC}/json?poll=1&since=12h`);
    if (!res.ok) throw new Error("bad response " + res.status);
    const text = await res.text();
    const lines = text.trim().split("\n").filter(Boolean);
    const msgs = [];

    lines.forEach(line => {
      try {
        const envelope = JSON.parse(line);
        if (envelope.event === "message" && envelope.message) {
          msgs.push(JSON.parse(envelope.message));
        }
      } catch (e) { /* skip malformed line */ }
    });

    if (msgs.length === 0) {
      chatMessagesEl.innerHTML = "";
      renderSystemNote("No messages yet. Say hi \u2014 you're the first one here.");
    } else {
      chatMessagesEl.innerHTML = "";
      msgs.slice(-100).forEach(renderMessage);
    }
  } catch (err) {
    console.error("Saltzy chat: failed to load history", err);
    chatMessagesEl.innerHTML = "";
    renderSystemNote("Couldn't load chat history, but you can still send messages.");
  }
}

function subscribeChatLive() {
  if (sseSource) return;

  sseSource = new EventSource(`${NTFY_BASE}/${CHAT_TOPIC}/sse`);

  sseSource.onmessage = ev => {
    try {
      const envelope = JSON.parse(ev.data);
      if (envelope.event === "message" && envelope.message) {
        clearEmptyState();
        renderMessage(JSON.parse(envelope.message));
      }
    } catch (e) { /* ignore malformed event */ }
  };

  sseSource.onerror = () => {
    chatModeBadge.textContent = "Reconnecting\u2026";
    chatModeBadge.style.color = "var(--danger)";
  };

  sseSource.addEventListener("open", () => {
    chatModeBadge.textContent = "Live";
    chatModeBadge.style.color = "";
  });
}

async function initNtfyChat() {
  await loadChatHistory();
  subscribeChatLive();
}

/* -----------------------------------------------------------
   4. UPDATES FEED
----------------------------------------------------------- */
const UPDATES = [
   {
    date: "September 19, 2026",
    tag: "new",
    title: "Bug Fix #1",
    desc: "Minor bug on connection with the chat, now it works smoothly and you can actually see messages."
  },
  {
    date: "September 18, 2026",
    tag: "info",
    title: "Saltzy is born.",
    desc: "Welcome, Saltzy is a game platform made by ONE person aka tiramisu."
  },
  {
    date: "September 18, 2026",
    tag: "BETA - info",
    title: "Global chat added",
    desc: "Took like 3 hours but i FINALLY added chat and it WORKS!!!!."
  },
  {
    date: "September 18, 2026",
    tag: "BETA - info",
    title: "More games coming",
    desc: "Slope is the first game on Saltzy. The Games tab is built to hold more \u2014 new additions will be announced here first."
  }
];

function renderUpdates() {
  const list = document.getElementById("updates-list");
  list.innerHTML = "";
  UPDATES.forEach(u => {
    const item = document.createElement("div");
    item.className = "update-item";
    item.innerHTML = `
      <div class="update-date">${u.date}</div>
      <div class="update-card glass">
        <span class="update-tag ${u.tag}">${u.tag.toUpperCase()}</span>
        <h3 class="update-title">${escapeHtml(u.title)}</h3>
        <p class="update-desc">${escapeHtml(u.desc)}</p>
      </div>`;
    list.appendChild(item);
  });
}

renderUpdates();
