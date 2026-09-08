/* standin web UI — vanilla ES module.
   Sections: lib · state · sync engine · data/polling · router · topbar ·
   view: queue · view: work · view: connections · view: ledger · init. */

/* ============ lib ============ */
const $ = (s, el = document) => el.querySelector(s);

async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
async function apiDelete(path) {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
}

function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
function mkBtn(text, cls, onclick) {
  const b = document.createElement("button");
  if (cls) b.className = cls;
  b.textContent = text;
  if (onclick) b.addEventListener("click", onclick);
  return b;
}
function toast(msg, kind) {
  const t = document.createElement("div");
  t.className = "toast" + (kind === "err" ? " err" : "");
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 4200);
}

const hasMd = typeof marked !== "undefined" && typeof DOMPurify !== "undefined";
if (hasMd) {
  DOMPurify.addHook("afterSanitizeAttributes", (n) => {
    if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener"); }
  });
}
function md(text) {
  const el = document.createElement("div");
  el.className = "md";
  if (!hasMd) { el.textContent = text ?? ""; return el; } // offline fallback: escaped text
  el.innerHTML = DOMPurify.sanitize(
    marked.parse(text ?? "", { gfm: true, breaks: true }),
    { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "img", "svg", "math"] },
  );
  return el;
}

/* ============ state ============ */
const state = {
  route: { view: "queue", id: null },
  queue: { items: [], quiet: 0, noise: [] },
  runs: [],
  connections: [],
  audit: [],
  yolo: false,
  brain: "",
  ui: {
    drafts: new Map(),     // itemId -> locally edited draft (authoritative once edited)
    draftBase: new Map(),  // itemId -> server draft at detail-build time
    overlay: new Map(),    // itemId -> optimistic chat bubbles
    terminal: new Map(),   // itemId -> fetched non-open item (or "missing")
    noiseOpen: false,
  },
};

/* ============ sync engine ============ */
/* Keyed diff. Invariants: never touch a subtree containing focus; create()
   builds inputs once per key; update() never rewrites input values. */
function syncList(container, items, { key, sig, create, update }) {
  const want = new Map(items.map((it) => [String(key(it)), it]));
  for (const el of [...container.children]) {
    if (!want.has(el.dataset.key) && !el.contains(document.activeElement)) el.remove();
  }
  let cursor = container.firstElementChild;
  for (const it of items) {
    const k = String(key(it));
    let el = [...container.children].find((c) => c.dataset.key === k);
    if (!el) { el = create(it); el.dataset.key = k; el.dataset.sig = ""; }
    if (el !== cursor) container.insertBefore(el, cursor);
    else cursor = cursor.nextElementSibling;
    const s = String(sig(it));
    if (el.dataset.sig !== s && !el.contains(document.activeElement)) {
      update(el, it);
      el.dataset.sig = s;
    }
  }
}

/* ============ data / polling ============ */
let tickTimer = null;
let ticking = false;

function isLive() {
  if (state.runs.some((r) => r.status === "running" || r.status === "waiting")) return true;
  if ([...state.ui.overlay.values()].some((o) => o.length)) return true;
  return state.queue.items.some((i) => i.chat?.some((m) => m.status === "pending"));
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const [q, r] = await Promise.all([api("/api/queue"), api("/api/runs")]);
    state.queue = q;
    state.runs = r.runs;
    if (state.route.view === "ledger") state.audit = (await api("/api/audit")).events;
  } catch { /* server hiccup — keep last state */ }
  ticking = false;
  render();
  scheduleTick();
}
function scheduleTick(extraSoon) {
  clearTimeout(tickTimer);
  if (document.hidden) return;
  tickTimer = setTimeout(tick, extraSoon ? 800 : isLive() ? 3000 : 10000);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(tickTimer);
  else tick();
});

async function loadYolo() {
  const r = await api("/api/yolo");
  state.yolo = r.on;
  state.brain = r.brain || "";
  renderTopbar();
}
async function loadConnections() {
  state.connections = (await api("/api/connections")).connections;
  renderConnDots();
  if (state.route.view === "connections") renderConnections();
}

/* ============ router ============ */
const ROUTES = [
  [/^#\/queue\/item\/(\d+)$/, (m) => ({ view: "queue", id: +m[1] })],
  [/^#\/queue$/, () => ({ view: "queue", id: null })],
  [/^#\/work\/run\/(\d+)$/, (m) => ({ view: "work", id: +m[1] })],
  [/^#\/work$/, () => ({ view: "work", id: null })],
  [/^#\/connections$/, () => ({ view: "connections", id: null })],
  [/^#\/ledger$/, () => ({ view: "ledger", id: null })],
];
function onHash() {
  const hash = location.hash || "#/queue";
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (m) {
      state.route = fn(m);
      if (state.route.view === "connections") loadConnections();
      if (state.route.view === "ledger") api("/api/audit").then((r) => { state.audit = r.events; renderLedger(); });
      render();
      return;
    }
  }
  location.replace("#/queue");
}
window.addEventListener("hashchange", onHash);

/* ============ render root + topbar ============ */
function render() {
  renderTopbar();
  for (const v of ["queue", "work", "connections", "ledger"]) {
    const sec = $("#view-" + v);
    sec.hidden = state.route.view !== v;
    sec.classList.toggle("has-id", state.route.view === v && state.route.id != null);
  }
  if (state.route.view === "queue") { renderQueueList(); renderQueueDetail(); }
  else if (state.route.view === "work") { renderWorkList(); renderWorkDetail(); }
  else if (state.route.view === "ledger") renderLedger();
}

function renderTopbar() {
  $("#brain").textContent = state.brain || "…";
  for (const a of document.querySelectorAll("#tabs a"))
    a.classList.toggle("active", a.dataset.view === state.route.view);
  const urgent = state.queue.items.filter((i) => i.lane === 4).length;
  const bq = $("#badge-queue");
  bq.hidden = urgent === 0;
  bq.textContent = urgent;
  const waiting = state.runs.filter((r) => r.status === "waiting").length;
  const bw = $("#badge-work");
  bw.hidden = waiting === 0;
  bw.textContent = waiting;
  const y = $("#yolo");
  y.classList.toggle("on", state.yolo);
  y.setAttribute("aria-checked", String(state.yolo));
}
function renderConnDots() {
  $("#conn-dots").replaceChildren(...state.connections.map((c) => {
    const i = document.createElement("i");
    if (c.connected) i.className = "on";
    i.title = c.name + (c.connected ? " · connected" : " · not connected");
    return i;
  }));
}

/* ============ view: queue — list ============ */
function linkedRun(itemId) {
  return state.runs.find((r) => r.itemId === itemId) ?? null;
}
const RUNLABEL = { running: "agent working…", waiting: "agent needs you", done: "agent done", failed: "agent failed" };

function renderQueueList() {
  const items = state.queue.items.map((it, ix) => ({ it, rank: ix + 1 }));
  const l4 = state.queue.items.filter((i) => i.lane === 4).length;
  const l3 = state.queue.items.length - l4;
  const parts = [];
  if (l4) parts.push(`<b>${l4} urgent</b>`);
  if (l3) parts.push(`<b>${l3}</b> need${l3 === 1 ? "s" : ""} a decision`);
  if (!parts.length) parts.push("nothing needs you");
  const quiet = state.queue.quiet ? ` · ${state.queue.quiet} quiet <a id="noise-toggle">${state.ui.noiseOpen ? "hide" : "show"}</a>` : "";
  $("#pulse").innerHTML = parts.join(" · ") + quiet;
  const tgl = $("#noise-toggle");
  if (tgl) tgl.addEventListener("click", () => { state.ui.noiseOpen = !state.ui.noiseOpen; renderQueueList(); });
  const nl = $("#noise-list");
  nl.hidden = !state.ui.noiseOpen;
  if (state.ui.noiseOpen)
    nl.replaceChildren(...state.queue.noise.map((n) => {
      const li = document.createElement("li");
      li.textContent = n.title + " — " + n.summary;
      return li;
    }));

  const list = $("#q-list");
  if (items.length === 0) {
    list.replaceChildren(Object.assign(document.createElement("div"), {
      className: "empty",
      innerHTML: "<b>Queue clear.</b><br>Run triage to read your inbox again.",
    }));
    return;
  }
  if (list.firstElementChild?.className === "empty") list.replaceChildren();
  syncList(list, items, {
    key: (w) => "i" + w.it.id,
    sig: (w) => {
      const last = w.it.chat?.at(-1);
      const run = linkedRun(w.it.id);
      return [w.rank, w.it.lane, w.it.chat?.length ?? 0, last?.status ?? "", !!w.it.draft,
        run?.status ?? "", state.route.id === w.it.id, timeAgo(w.it.createdAt)].join("|");
    },
    create: (w) => {
      const el = document.createElement("div");
      el.setAttribute("role", "button");
      el.tabIndex = 0;
      const go = () => { location.hash = `#/queue/item/${w.it.id}`; };
      el.addEventListener("click", go);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      return el;
    },
    update: (el, w) => {
      const { it } = w;
      el.className = "row lane" + it.lane;
      if (state.route.id === it.id) el.setAttribute("aria-current", "true");
      else el.removeAttribute("aria-current");
      const run = linkedRun(it.id);
      const last = it.chat?.at(-1);
      const badges = [];
      if (it.draft) badges.push(`<span class="tag acc">draft ready</span>`);
      if (it.chat?.length) badges.push(`<span class="tag${last?.status === "pending" ? " pulse" : ""}">💬 ${it.chat.length}</span>`);
      if (run) badges.push(`<span class="tag ${run.status === "waiting" ? "sig pulse" : run.status === "running" ? "acc pulse" : ""}">${RUNLABEL[run.status]}</span>`);
      el.innerHTML = `
        <div class="rtop"><span>#${w.rank}</span><span class="ltag">${it.lane === 4 ? "escalate" : "needs you"}</span><span>${esc(it.source)}</span><span class="when">${timeAgo(it.createdAt)}</span></div>
        <div class="rtitle">${esc(it.title)}</div>
        <div class="rsub">${esc(it.summary)}</div>
        ${badges.length ? `<div class="rbadges">${badges.join("")}</div>` : ""}`;
    },
  });
}

/* ============ view: queue — detail ============ */
let qd = { key: null }; // refs for the built detail skeleton

function displayChat(item) {
  const overlay = state.ui.overlay.get(item.id) ?? [];
  if (overlay.length) {
    const owner = overlay.find((m) => m.role === "owner");
    const lastOwner = [...(item.chat ?? [])].reverse().find((m) => m.role === "owner");
    if (owner && lastOwner && lastOwner.content === owner.content) {
      state.ui.overlay.delete(item.id); // server caught up
      return item.chat ?? [];
    }
  }
  return [...(item.chat ?? []), ...overlay];
}

function renderQueueDetail() {
  const pane = $("#q-detail");
  const id = state.route.id;
  if (id == null) {
    if (qd.key !== "ph") {
      pane.replaceChildren(Object.assign(document.createElement("div"), {
        className: "dplaceholder",
        textContent: "Select an item — its context, conversation, and actions live here.",
      }));
      qd = { key: "ph" };
    }
    return;
  }
  const item = state.queue.items.find((i) => i.id === id);
  if (!item) { renderTerminal(pane, id); return; }
  if (qd.key !== "q" + id) buildQueueDetail(pane, item);
  updateQueueDetail(item);
}

function buildQueueDetail(pane, item) {
  qd = { key: "q" + item.id };
  pane.replaceChildren();

  const scroll = document.createElement("div");
  scroll.className = "dscroll";
  qd.scroll = scroll;

  // header
  const head = document.createElement("div");
  head.className = "dhead";
  const meta = document.createElement("div");
  meta.className = "dmeta";
  meta.innerHTML = `
    <a class="backlink" href="#/queue">← queue</a>
    <span class="ltag l${item.lane}">${item.lane === 4 ? "escalate now" : "needs you"}</span>
    <span>${esc(item.source)}</span>
    ${item.actor ? `<span>· ${esc(item.actor)}</span>` : ""}
    <span data-when>${timeAgo(item.createdAt)}</span>`;
  const dactions = document.createElement("span");
  dactions.className = "dactions";
  qd.goBtn = mkBtn("Go do it", "ghost", async () => {
    qd.goBtn.disabled = true;
    try {
      await api("/api/work", { itemId: item.id });
      toast("Agent started — it will brief you before touching anything");
      scheduleTick(true);
    } catch (e) { toast(e.message, "err"); }
    qd.goBtn.disabled = false;
  });
  qd.goBtn.title = "an agent gathers context, briefs you, and only works after your go";
  dactions.append(
    qd.goBtn,
    mkBtn("Not now", "ghost", async () => {
      await api(`/api/items/${item.id}/dismiss`, {});
      location.hash = "#/queue";
      tick();
    }),
    mkBtn("This is noise", "ghost", async () => {
      const r = await api(`/api/items/${item.id}/noise`, {});
      toast("Hidden — the line moved: " + r.rule);
      location.hash = "#/queue";
      tick();
    }),
  );
  meta.append(dactions);
  const title = document.createElement("div");
  title.className = "dtitle";
  title.innerHTML = item.url ? `<a href="${item.url}" target="_blank" rel="noopener">${esc(item.title)}</a>` : esc(item.title);
  head.append(meta, title);
  scroll.append(head);

  const summary = document.createElement("div");
  summary.className = "dsummary";
  summary.textContent = item.summary;
  const why = document.createElement("div");
  why.className = "dwhy";
  why.textContent = "why here: " + item.reason;
  scroll.append(summary, why);

  // draft + approve
  if (item.draft && item.action) {
    state.ui.draftBase.set(item.id, item.draft);
    const box = document.createElement("div");
    box.className = "draft";
    const label = document.createElement("div");
    label.className = "dlabel";
    label.textContent = "draft · edit freely · what you approve is exactly what sends";
    qd.draftNotice = document.createElement("a");
    qd.draftNotice.hidden = true;
    qd.draftNotice.textContent = "draft changed on server — reset to it";
    label.append(qd.draftNotice);
    const ta = document.createElement("textarea");
    ta.value = state.ui.drafts.get(item.id) ?? item.draft;
    ta.addEventListener("input", () => state.ui.drafts.set(item.id, ta.value));
    qd.draftNotice.addEventListener("click", () => {
      state.ui.drafts.delete(item.id);
      ta.value = state.ui.draftBase.get(item.id) ?? "";
      qd.draftNotice.hidden = true;
    });
    qd.draftTa = ta;
    const row = document.createElement("div");
    row.className = "drow";
    qd.statusEl = document.createElement("span");
    qd.statusEl.className = "status";
    const approve = mkBtn("Approve & send", "primary", async () => {
      approve.disabled = true;
      qd.statusEl.className = "status";
      qd.statusEl.textContent = "sending…";
      try {
        const r = await api(`/api/items/${item.id}/approve`, { draft: ta.value });
        qd.statusEl.textContent = "✓ " + r.note;
        toast("Sent — " + r.note);
        state.ui.drafts.delete(item.id);
        tick();
      } catch (e) {
        qd.statusEl.className = "status err";
        qd.statusEl.textContent = "failed: " + e.message;
        approve.disabled = false;
      }
    });
    row.append(approve, qd.statusEl);
    box.append(label, ta, row);
    scroll.append(box);
  }

  // linked runs
  qd.runstrip = document.createElement("div");
  qd.runstrip.className = "runstrip";
  scroll.append(qd.runstrip);

  // conversation
  const tlabel = document.createElement("div");
  tlabel.className = "thread-label";
  tlabel.textContent = "conversation — context, options, whatever you need";
  qd.thread = document.createElement("div");
  qd.thread.className = "thread";
  scroll.append(tlabel, qd.thread);

  // ask bar (pinned)
  const bar = document.createElement("form");
  bar.className = "askbar";
  qd.askInput = document.createElement("input");
  qd.askInput.placeholder = "ask about this — who's involved, what happened, your options…";
  const askBtn = mkBtn("Ask", "primary", null);
  askBtn.type = "submit";
  bar.append(qd.askInput, askBtn);
  bar.addEventListener("submit", (e) => { e.preventDefault(); sendAsk(item.id); });

  pane.append(scroll, bar);
}

function sendAsk(itemId) {
  const q = qd.askInput.value.trim();
  if (!q) return;
  qd.askInput.value = "";
  state.ui.overlay.set(itemId, [
    { id: "tmp-o", role: "owner", content: q, status: "done" },
    { id: "tmp-p", role: "standin", content: "", status: "pending" },
  ]);
  render();
  api(`/api/items/${itemId}/ask`, { question: q })
    .then((r) => {
      const item = state.queue.items.find((i) => i.id === itemId);
      if (item) item.chat = r.chat;
      state.ui.overlay.delete(itemId);
      render();
      scheduleTick(true);
    })
    .catch((e) => {
      state.ui.overlay.set(itemId, [
        { id: "tmp-o", role: "owner", content: q, status: "done" },
        { id: "tmp-p", role: "standin", content: e.message, status: "failed", retryQ: q },
      ]);
      render();
    });
}

function bubbleNode(m, itemId) {
  const el = document.createElement("div");
  el.setAttribute("data-bubble", "");
  fillBubble(el, m, itemId);
  return el;
}
function fillBubble(el, m, itemId) {
  el.className = `bubble ${m.role}` + (m.status === "pending" ? " pending" : m.status === "failed" ? " failed" : "");
  el.replaceChildren();
  if (m.status === "pending") el.textContent = "pulling the live ticket and thinking…";
  else if (m.status === "failed") {
    el.append(document.createTextNode("failed: " + m.content + " "));
    const retry = mkBtn("Retry", "ghost", () => {
      const prev = m.retryQ ?? [...(state.queue.items.find((i) => i.id === itemId)?.chat ?? [])].reverse().find((x) => x.role === "owner")?.content;
      if (prev) { qd.askInput.value = prev; sendAsk(itemId); }
    });
    retry.style.padding = "2px 10px";
    el.append(retry);
  } else if (m.role === "standin") el.append(md(m.content));
  else el.textContent = m.content;
}

function updateQueueDetail(item) {
  $("[data-when]", qd.scroll) && ($("[data-when]", qd.scroll).textContent = timeAgo(item.createdAt));
  qd.goBtn.hidden = !state.yolo;

  // draft changed server-side while locally edited?
  if (qd.draftTa) {
    const base = state.ui.draftBase.get(item.id);
    if (item.draft !== base) {
      if (state.ui.drafts.has(item.id)) qd.draftNotice.hidden = false;
      else if (!qd.draftTa.contains(document.activeElement) && document.activeElement !== qd.draftTa) {
        qd.draftTa.value = item.draft ?? "";
        state.ui.draftBase.set(item.id, item.draft);
      }
    }
  }

  // linked runs strip (no inputs — safe to rebuild)
  const runs = state.runs.filter((r) => r.itemId === item.id);
  qd.runstrip.replaceChildren(...runs.map((r) => {
    const a = document.createElement("a");
    a.href = `#/work/run/${r.id}`;
    a.innerHTML = `<span class="rpill ${r.status}">${r.status === "running" ? "working…" : r.status === "waiting" ? "needs you" : r.status}</span> agent run · ${timeAgo(r.createdAt)}`;
    return a;
  }));

  // thread
  const chat = displayChat(item);
  const nearBottom = qd.scroll.scrollHeight - qd.scroll.scrollTop - qd.scroll.clientHeight < 60;
  syncList(qd.thread, chat, {
    key: (m) => "m" + m.id,
    sig: (m) => `${m.status}|${(m.content ?? "").length}`,
    create: (m) => bubbleNode(m, item.id),
    update: (el, m) => fillBubble(el, m, item.id),
  });
  if (nearBottom) qd.scroll.scrollTop = qd.scroll.scrollHeight;
}

async function renderTerminal(pane, id) {
  if (qd.key === "t" + id) return;
  let cached = state.ui.terminal.get(id);
  if (qd.key === "loading" + id && !cached) return; // fetch already in flight
  if (!cached) {
    qd = { key: "loading" + id };
    pane.replaceChildren(Object.assign(document.createElement("div"), { className: "dplaceholder", textContent: "loading…" }));
    try {
      cached = (await api(`/api/items/${id}`)).item;
      state.ui.terminal.set(id, cached);
    } catch {
      toast("That item no longer exists", "err");
      location.hash = "#/queue";
      return;
    }
    if (state.route.id !== id) return;
  }
  qd = { key: "t" + id };
  const scroll = document.createElement("div");
  scroll.className = "dscroll";
  const NOTE = { done: "Handled — the approved action was sent.", dismissed: "Cleared — you set this aside.", noise: "Marked as noise — the triage line moved.", open: "This item is open but not in the current queue window." };
  scroll.innerHTML = `
    <div class="dhead">
      <div class="dmeta"><a class="backlink" href="#/queue">← queue</a><span>${esc(cached.source)}</span><span>${timeAgo(cached.createdAt)}</span></div>
      <div class="dtitle">${cached.url ? `<a href="${cached.url}" target="_blank" rel="noopener">${esc(cached.title)}</a>` : esc(cached.title)}</div>
    </div>
    <div class="terminal-note">${NOTE[cached.status] ?? cached.status}</div>
    <div class="dsummary">${esc(cached.summary)}</div>`;
  const thread = document.createElement("div");
  thread.className = "thread";
  for (const m of cached.chat ?? []) thread.append(bubbleNode(m, id));
  scroll.append(thread);
  pane.replaceChildren(scroll);
}

/* ============ view: work ============ */
const PILL = { running: "working…", waiting: "needs you", done: "done", failed: "failed" };
let wd = { key: null };

function renderWorkList() {
  const list = $("#w-list");
  if (state.runs.length === 0) {
    list.replaceChildren(Object.assign(document.createElement("div"), {
      className: "empty",
      innerHTML: "No agents have run yet.<br>Give one a task above, or <b>Go do it</b> on a queue item.",
    }));
    return;
  }
  if (list.firstElementChild?.className === "empty") list.replaceChildren();
  syncList(list, state.runs, {
    key: (r) => "r" + r.id,
    sig: (r) => [r.updatedAt, r.status, state.route.id === r.id].join("|"),
    create: (r) => {
      const el = document.createElement("div");
      el.setAttribute("role", "button");
      el.tabIndex = 0;
      const go = () => { location.hash = `#/work/run/${r.id}`; };
      el.addEventListener("click", go);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      return el;
    },
    update: (el, r) => {
      el.className = "row" + (r.status === "waiting" ? " lane4" : r.status === "running" ? " lane3" : "");
      if (state.route.id === r.id) el.setAttribute("aria-current", "true");
      else el.removeAttribute("aria-current");
      el.innerHTML = `
        <div class="rtop"><span class="ltag">agent</span><span class="when">${timeAgo(r.updatedAt)}</span></div>
        <div class="rtitle">${esc(r.title)}</div>
        <div class="rbadges"><span class="tag ${r.status === "waiting" ? "sig pulse" : r.status === "running" ? "acc pulse" : ""}">${PILL[r.status]}</span></div>`;
    },
  });
}

function renderWorkDetail() {
  const pane = $("#w-detail");
  const id = state.route.id;
  if (id == null) {
    if (wd.key !== "ph") {
      pane.replaceChildren(Object.assign(document.createElement("div"), {
        className: "dplaceholder",
        textContent: "Select a run — its brief, questions, log, and report live here.",
      }));
      wd = { key: "ph" };
    }
    return;
  }
  let run = state.runs.find((r) => r.id === id);
  if (!run) {
    if (wd.key !== "fetch" + id) {
      wd = { key: "fetch" + id };
      api(`/api/runs/${id}`).then((r) => { state.runs.push(r.run); wd = { key: null }; render(); })
        .catch(() => { toast("That run no longer exists", "err"); location.hash = "#/work"; });
    }
    return;
  }
  if (wd.key !== "w" + id) buildWorkDetail(pane, run);
  updateWorkDetail(run);
}

function buildWorkDetail(pane, run) {
  wd = { key: "w" + run.id };
  const scroll = document.createElement("div");
  scroll.className = "dscroll";
  wd.scroll = scroll;

  const head = document.createElement("div");
  head.className = "dhead";
  head.innerHTML = `
    <div class="dmeta"><a class="backlink" href="#/work">← work</a><span class="rpill" data-pill></span><span data-when></span>${run.itemId ? `<span>· <a href="#/queue/item/${run.itemId}">linked item</a></span>` : ""}</div>
    <div class="dtitle">${esc(run.title)}</div>`;
  scroll.append(head);

  wd.qwrap = document.createElement("div");
  scroll.append(wd.qwrap);

  wd.log = document.createElement("div");
  wd.log.className = "rlog";
  wd.log.hidden = true;
  scroll.append(wd.log);

  wd.report = document.createElement("div");
  wd.report.className = "rreport";
  wd.report.hidden = true;
  scroll.append(wd.report);

  wd.cont = document.createElement("form");
  wd.cont.className = "continue";
  wd.cont.hidden = true;
  const ta = document.createElement("textarea");
  ta.placeholder = "answer its open questions or redirect it — same agent, full context";
  wd.contTa = ta;
  const crow = document.createElement("div");
  crow.className = "crow";
  const send = mkBtn("Answer & continue", "primary", null);
  send.type = "submit";
  crow.append(send);
  wd.cont.append(ta, crow);
  wd.cont.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!ta.value.trim()) return;
    send.disabled = true;
    try { await api(`/api/runs/${run.id}/continue`, { answer: ta.value }); ta.value = ""; scheduleTick(true); }
    catch (err) { toast(err.message, "err"); }
    send.disabled = false;
  });

  pane.replaceChildren(scroll, wd.cont);
}

function updateWorkDetail(run) {
  const pill = $("[data-pill]", wd.scroll);
  pill.className = "rpill " + run.status;
  pill.textContent = PILL[run.status];
  $("[data-when]", wd.scroll).textContent = timeAgo(run.updatedAt);

  // question block (contains an input — rebuild only when the question changes and focus is elsewhere)
  const q = run.question;
  const qKey = q ? String(q.id) : "";
  if (wd.qKey !== qKey && !wd.qwrap.contains(document.activeElement)) {
    wd.qKey = qKey;
    wd.qwrap.replaceChildren();
    if (q) {
      const box = document.createElement("div");
      box.className = "question";
      box.innerHTML = `<span class="qtext">${esc(q.question)}</span>`;
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.placeholder = "your answer — the agent continues the moment you send it";
      const send = mkBtn("Answer", "primary", null);
      send.type = "submit";
      form.append(input, send);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        send.disabled = true;
        try { await api(`/api/questions/${q.id}/answer`, { answer: input.value }); scheduleTick(true); }
        catch (err) { toast(err.message, "err"); send.disabled = false; }
      });
      box.append(form);
      wd.qwrap.append(box);
    }
  }

  // live log with smart auto-scroll
  const active = run.status === "running" || run.status === "waiting";
  wd.log.hidden = !(active && run.log);
  if (!wd.log.hidden) {
    const near = wd.log.scrollHeight - wd.log.scrollTop - wd.log.clientHeight < 30;
    const tail = (run.log ?? "").slice(-4000);
    if (wd.log.textContent !== tail) {
      wd.log.textContent = tail;
      if (near) wd.log.scrollTop = wd.log.scrollHeight;
    }
  }

  // report (markdown), once finished
  const showReport = !active && run.report;
  wd.report.hidden = !showReport;
  if (showReport && wd.reportRev !== run.updatedAt) {
    wd.reportRev = run.updatedAt;
    wd.report.replaceChildren(md(run.report));
  }
  wd.cont.hidden = !(!active && run.sessionId);
}

/* ============ view: connections ============ */
function renderConnections() {
  $("#conn-grid").replaceChildren(...state.connections.map(connCard));
}

function connCard(c) {
  const el = document.createElement("div");
  el.className = "conn";
  const help = c.tokenHelpUrl ? ` <a href="${c.tokenHelpUrl}" target="_blank" rel="noopener">get a key →</a>` : "";
  el.innerHTML = `
    <div class="head">
      <span class="name">${esc(c.name)}</span>
      ${c.connected && c.who ? `<span class="who">✓ ${esc(c.who)}</span>` : ""}
    </div>
    <div class="detail">${esc(c.detail)}${c.connected ? "" : help}</div>`;
  if (c.steps && !c.connected) {
    const ol = document.createElement("ol");
    ol.replaceChildren(...c.steps.map((s) => {
      const li = document.createElement("li");
      li.innerHTML = esc(s)
        .replace(/(api\.slack\.com\/apps)/g, '<a href="https://$1" target="_blank" rel="noopener">$1</a>')
        .replace(/(chat:write|xoxb-|\/invite @standin|gh auth login|brew install gh)/g, "<code>$1</code>")
        .replace(/“([^”]+)”/g, "<b>“$1”</b>");
      return li;
    }));
    el.append(ol);
  }
  if (c.manifest && !c.connected) {
    const pre = document.createElement("div");
    pre.className = "manifest";
    const copy = mkBtn("Copy", "", async () => {
      try { await navigator.clipboard.writeText(c.manifest); toast("Manifest copied — paste it in Slack's “From a manifest” box"); }
      catch { toast("Couldn't access the clipboard — select and copy it manually", "err"); }
    });
    pre.append(copy, document.createTextNode(c.manifest));
    el.append(pre);
  }
  if (c.acceptsToken && !c.connected) {
    if (c.id === "linear") {
      const row = document.createElement("div");
      row.className = "actions";
      const msg = document.createElement("span");
      msg.className = "msg";
      const oauth = mkBtn("Sign in with Linear", "primary", async () => {
        oauth.disabled = true;
        msg.className = "msg";
        msg.textContent = "browser opening — approve on Linear's page…";
        try {
          const r = await api("/api/connections/linear-oauth", {});
          toast("Linear connected — " + r.who);
          await loadConnections();
        } catch (err) { msg.className = "msg err"; msg.textContent = err.message; oauth.disabled = false; }
      });
      row.append(oauth, msg);
      el.append(row);
      el.append(Object.assign(document.createElement("div"), { className: "detail", textContent: "or paste an API key:" }));
    }
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = c.id === "linear" ? "lin_api_…" : "xoxb-…";
    input.autocomplete = "off";
    const btn = mkBtn("Connect", "primary", null);
    btn.type = "submit";
    const msg = document.createElement("span");
    msg.className = "msg";
    form.append(input, btn, msg);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      msg.className = "msg";
      msg.textContent = "checking with " + c.name + "…";
      try {
        const r = await api(`/api/connections/${c.id}`, { token: input.value });
        toast(c.name + " connected as " + r.who);
        await loadConnections();
      } catch (err) { msg.className = "msg err"; msg.textContent = err.message + " — nothing saved"; btn.disabled = false; }
    });
    el.append(form);
  } else if (c.acceptsToken && c.connected) {
    const row = document.createElement("div");
    row.className = "actions";
    row.append(mkBtn("Disconnect", "ghost", async () => {
      await apiDelete(`/api/connections/${c.id}`);
      await loadConnections();
    }));
    el.append(row);
  }
  if (c.permissions?.length) {
    const g = document.createElement("div");
    g.className = "grants";
    g.innerHTML = `<span class="glabel">what connecting grants</span>`;
    const ul = document.createElement("ul");
    ul.replaceChildren(...c.permissions.map((p) => Object.assign(document.createElement("li"), { textContent: p })));
    g.append(ul);
    el.append(g);
  }
  return el;
}

/* ============ view: ledger ============ */
function lpillClass(type) {
  if (/^(approval|send)\./.test(type)) return "lpill acc";
  if (/^(line|yolo|run)\./.test(type)) return "lpill sig";
  return "lpill";
}
function renderLedger() {
  const body = $("#ledger-body");
  syncList(body, state.audit, {
    key: (e) => "e" + e.id,
    sig: () => "1", // audit rows are immutable
    create: () => document.createElement("tr"),
    update: (tr, e) => {
      tr.innerHTML = `
        <td class="lts">${e.ts.replace("T", " ").slice(0, 19)}</td>
        <td><span class="${lpillClass(e.type)}">${esc(e.type)}</span></td>
        <td>${esc(e.detail)}${e.itemId ? ` — <a href="#/queue/item/${e.itemId}">item</a>` : ""}</td>`;
    },
  });
}

/* ============ global controls ============ */
$("#yolo").addEventListener("click", toggleYolo);
$("#yolo").addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleYolo(); } });
async function toggleYolo() {
  const { on } = await api("/api/yolo", { on: !state.yolo });
  state.yolo = on;
  toast(on ? "Yolo on — agents may work; sends and merges stay yours" : "Yolo off — triage and drafts only");
  render();
}

$("#triage-btn").addEventListener("click", async () => {
  const b = $("#triage-btn");
  b.disabled = true;
  b.textContent = "Reading your inbox…";
  try {
    const r = await api("/api/triage", {});
    toast(`Triage done — ${r.new} new item${r.new === 1 ? "" : "s"}`);
    await tick();
  } catch (e) { toast(e.message, "err"); }
  b.disabled = false;
  b.textContent = "Run triage";
});

$("#new-task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#task-input");
  const instructions = input.value.trim();
  if (!instructions) return;
  if (!state.yolo) { toast("Flip yolo on first — then agents may work", "err"); return; }
  try {
    await api("/api/work", { instructions });
    input.value = "";
    toast("Agent started — it will brief you before touching anything");
    scheduleTick(true);
  } catch (err) { toast(err.message, "err"); }
});

/* ============ init ============ */
loadYolo();
loadConnections();
onHash();
tick();
