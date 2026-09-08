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
  queue: { tasks: [], quiet: 0, noise: [] },
  runs: [],
  connections: [],
  audit: [],
  yolo: false,
  brain: "",
  owner: "",
  autopilot: false,
  feeds: null, // /api/feeds payload: source streams + the replica's persistent chat
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
  if (state.feeds?.chat?.some((m) => m.status === "pending")) return true;
  return state.queue.tasks.some((t) => t.chat?.some((m) => m.status === "pending"));
}

let serverBoot = null;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const [q, r] = await Promise.all([api("/api/queue"), api("/api/runs")]);
    // The server restarted (new code) while this tab was open — pick it up.
    if (serverBoot && q.v !== serverBoot) { location.reload(); return; }
    serverBoot = q.v ?? serverBoot;
    state.queue = { tasks: q.tasks ?? [], quiet: q.quiet ?? 0, noise: q.noise ?? [] };
    state.runs = r.runs ?? [];
    if (state.route.view === "home") state.feeds = await api("/api/feeds");
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
  state.autopilot = r.autopilot === true;
  state.brain = r.brain || "";
  state.owner = r.owner || "you";
  typeGreeting();
  renderTopbar();
}

/* ============ home — the copy ============ */
let greetingTyped = false;
function typeGreeting() {
  if (greetingTyped || !state.owner) return;
  greetingTyped = true;
  const el = $("#greeting");
  const text = `Hello — I'm ${state.owner}'s replica. How can I help?`;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { el.textContent = text; return; }
  el.innerHTML = `<span class="caret"></span>`;
  let i = 0;
  const step = () => {
    i++;
    el.firstChild?.remove?.();
    el.textContent = text.slice(0, i);
    if (i < text.length) {
      el.insertAdjacentHTML("beforeend", `<span class="caret"></span>`);
      setTimeout(step, 26);
    }
  };
  setTimeout(step, 400);
}

function renderHome() {
  const t = state.queue.tasks;
  const urgent = t.filter((x) => x.lane === 4).length;
  const decisions = t.length - urgent;
  const working = state.runs.filter((r) => r.status === "running").length;
  const needsYou = state.runs.filter((r) => r.status === "waiting").length;
  const bits = [];
  if (urgent) bits.push(`<b>${urgent} urgent</b>`);
  if (decisions) bits.push(`<b>${decisions}</b> need${decisions === 1 ? "s" : ""} your call`);
  if (working) bits.push(`${working} agent${working === 1 ? "" : "s"} working`);
  if (needsYou) bits.push(`<b>${needsYou} agent${needsYou === 1 ? "" : "s"} waiting on you</b>`);
  if (!bits.length) bits.push("all quiet — nothing needs you");
  $("#sitline").innerHTML =
    `Right now: ${bits.join(" · ")}${state.queue.quiet ? ` · ${state.queue.quiet} handled quietly` : ""} — <a href="#/queue">open the queue</a>`;

  // needs-you panel: top tasks, one click into their detail
  const tasks = t.slice(0, 6).map((it, ix) => ({ it, rank: ix + 1 }));
  const tasksEl = $("#home-tasks");
  if (tasks.length === 0) {
    tasksEl.replaceChildren(Object.assign(document.createElement("div"), {
      className: "empty", innerHTML: "<b>Queue clear.</b>",
    }));
  } else {
    if (tasksEl.firstElementChild?.className === "empty") tasksEl.replaceChildren();
    syncList(tasksEl, tasks, {
      key: (w) => "ht" + w.it.id,
      sig: (w) => [w.rank, w.it.lane, w.it.count, (w.it.sent ?? []).join(","), !!w.it.draft, timeAgo(w.it.createdAt)].join("|"),
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
        el.className = "row lane" + w.it.lane;
        const badges = [];
        if (w.it.draft) badges.push(`<span class="tag acc">draft ready</span>`);
        for (const k of w.it.sent ?? [])
          badges.push(`<span class="tag acc">${k.split(".")[0]} ✓</span>`);
        el.innerHTML = `
          <div class="rtop"><span>#${w.rank}</span><span class="ltag">${w.it.lane === 4 ? "escalate" : "needs you"}</span><span class="when">${timeAgo(w.it.createdAt)}</span></div>
          <div class="rtitle">${esc(w.it.title)}</div>
          ${badges.length ? `<div class="rbadges">${badges.join("")}</div>` : ""}`;
      },
    });
  }

  // agents panel: live runs, one click into their detail
  const runsEl = $("#home-runs");
  const runs = state.runs.slice(0, 5);
  if (runs.length === 0) {
    runsEl.replaceChildren(Object.assign(document.createElement("div"), {
      className: "empty", innerHTML: "No agents running.<br><b>Go do it</b> on a task.",
    }));
  } else {
    if (runsEl.firstElementChild?.className === "empty") runsEl.replaceChildren();
    syncList(runsEl, runs, {
      key: (r) => "hr" + r.id,
      sig: (r) => [r.updatedAt, r.status].join("|"),
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
        el.innerHTML = `
          <div class="rtop"><span class="ltag">agent</span><span class="when">${timeAgo(r.updatedAt)}</span></div>
          <div class="rtitle">${esc(r.title)}</div>
          <div class="rbadges"><span class="tag ${r.status === "waiting" ? "sig pulse" : r.status === "running" ? "acc pulse" : ""}">${PILL[r.status]}</span></div>`;
      },
    });
  }

  renderFeeds();

  const thread = $("#home-thread");
  const chat = state.feeds?.chat ?? [];
  const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
  syncList(thread, chat, {
    key: (m) => "hm" + m.id,
    sig: (m) => `${m.status}|${(m.content ?? "").length}`,
    create: () => document.createElement("div"),
    update: (el, m) => {
      el.className = `bubble ${m.role}` + (m.status === "pending" ? " pending" : m.status === "failed" ? " failed" : "");
      el.replaceChildren();
      if (m.status === "pending") el.textContent = "reading the whole board…";
      else if (m.role === "standin") el.append(md(m.content));
      else el.textContent = m.content;
    },
  });
  if (near) thread.scrollTop = thread.scrollHeight;
}

/* two-step outward action: first click arms, second executes through the contract */
function armBtn(label, fn) {
  const b = mkBtn(label, "ghost", async () => {
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = "sure? " + label;
      setTimeout(() => { b.dataset.armed = ""; b.textContent = label; }, 3000);
      return;
    }
    b.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, "err"); }
    b.disabled = false;
    b.dataset.armed = "";
    b.textContent = label;
  });
  return b;
}

function miniInput(row, placeholder, prefill, send) {
  const b = mkBtn(placeholder.split(" ")[0] + "…", "ghost", () => {
    if (row.querySelector("form")) { row.querySelector("form").remove(); return; }
    const form = document.createElement("form");
    form.className = "ask";
    form.style.flexBasis = "100%";
    const input = document.createElement("input");
    input.placeholder = placeholder;
    input.value = prefill;
    const go = mkBtn("Send", "primary", null);
    go.type = "submit";
    form.append(input, go);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      go.disabled = true;
      try { await send(input.value.trim()); form.remove(); } catch (err) { toast(err.message, "err"); go.disabled = false; }
    });
    row.append(form);
    input.focus();
  });
  return b;
}

async function quickAction(itemId, kind, body) {
  const r = await api(`/api/items/${itemId}/action`, { kind, body });
  toast("✓ " + r.note);
  scheduleTick(true);
}

function renderFeeds() {
  const f = state.feeds;
  if (!f) return;
  const paint = (elId, items, emptyHtml) => {
    const el = $(elId);
    if (!items?.length) {
      el.replaceChildren(Object.assign(document.createElement("div"), { className: "empty", innerHTML: emptyHtml }));
      return;
    }
    if (el.firstElementChild?.className === "empty") el.replaceChildren();
    syncList(el, items, {
      key: (i) => "f" + i.id,
      sig: (i) => `${i.status}|${timeAgo(i.createdAt)}`,
      create: () => document.createElement("div"),
      update: (el2, i) => {
        el2.className = "feed-row";
        el2.innerHTML = `
          <div class="ftop"><span>${esc(i.actor ?? i.kind)}</span><span class="when">${timeAgo(i.createdAt)}</span></div>
          <div class="ftitle">${esc(i.title)}</div>
          <div class="frow">
            ${i.url ? `<a href="${i.url}" target="_blank" rel="noopener">open ↗</a>` : ""}
            ${i.lane >= 3 && i.status === "open" ? `<a href="#/queue/item/${i.id}">in queue →</a>` : ""}
          </div>`;
        const row = el2.querySelector(".frow");
        const b = mkBtn("▶ agent", "ghost", async (e) => {
          e.stopPropagation();
          if (!state.yolo) { toast("Flip yolo on first — then agents may work", "err"); return; }
          b.disabled = true;
          try {
            await api("/api/work", { itemId: i.id });
            toast("Agent started — it will brief you before touching anything");
            scheduleTick(true);
          } catch (err) { toast(err.message, "err"); b.disabled = false; }
        });
        row.append(b);
        // source-native quick actions — each is an approval + ledger entry
        if (elId === "#feed-linear") {
          row.append(
            armBtn("→ In Review", () => quickAction(i.id, "linear.status", "In Review")),
            armBtn("→ Done", () => quickAction(i.id, "linear.status", "Done")),
            miniInput(row, "comment on the ticket…", "", (t) => quickAction(i.id, "linear.comment", t)),
          );
        } else if (elId === "#feed-github") {
          row.append(
            miniInput(row, "comment on the PR…", "@aria please review this PR 🙏", (t) => quickAction(i.id, "github.comment", t)),
            armBtn("close PR", () => quickAction(i.id, "github.close")),
          );
        } else if (elId === "#feed-slack") {
          row.append(
            miniInput(row, "reply in the channel…", "", (t) => quickAction(i.id, "slack.message", t)),
          );
        }
        if (i.status === "open") {
          row.append(armBtn("discard", async () => {
            await api(`/api/items/${i.id}/dismiss`, {});
            toast("Discarded");
            scheduleTick(true);
          }));
        }
      },
    });
  };
  paint("#feed-linear", f.linear, "Nothing ingested yet — run triage.");
  paint("#feed-slack", f.slack, f.slackConnected
    ? "No channel messages since the last sweep."
    : `Connect Slack and <b>/invite @standin</b> to your channels — their activity lands here. <a href="#/connections">connections →</a>`);
  paint("#feed-github", f.github, "No open PRs involving you right now.");
}

$("#home-ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#home-input");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  try {
    const r = await api("/api/ask", { question });
    if (state.feeds) state.feeds.chat = r.chat;
    else state.feeds = { chat: r.chat };
    renderHome();
    scheduleTick(true); // the pending answer resolves server-side; polling picks it up
  } catch (err) { toast(err.message, "err"); }
});

/* ============ the orb ============ */
function startOrb() {
  const canvas = $("#orb");
  const ctx = canvas.getContext("2d");
  const S = 320;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const blobs = [...Array(6)].map((_, i) => ({
    a: (i / 6) * Math.PI * 2,
    r: 42 + (i % 3) * 22,
    sp: (0.35 + (i % 4) * 0.14) * (i % 2 ? 1 : -1),
    size: 66 + (i % 3) * 30,
  }));
  let t = 0;
  function frame() {
    t += 0.008;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 4, 0, 7);
    ctx.clip();
    // liquid mercury: chrome grays, hard specular, cold rim
    const base = ctx.createRadialGradient(S * 0.38, S * 0.34, 12, S / 2, S / 2, S * 0.56);
    base.addColorStop(0, "#F4F4F6");
    base.addColorStop(0.42, "#8E8E98");
    base.addColorStop(0.78, "#3A3A42");
    base.addColorStop(1, "#0A0A0D");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = "lighter";
    for (const b of blobs) {
      const x = S / 2 + Math.cos(t * b.sp * 3 + b.a) * b.r * (0.82 + 0.18 * Math.sin(t * 1.7 + b.a));
      const y = S / 2 + Math.sin(t * b.sp * 2.2 + b.a) * b.r * 0.85;
      const g = ctx.createRadialGradient(x, y, 0, x, y, b.size);
      g.addColorStop(0, "rgba(255,255,255,0.36)");
      g.addColorStop(0.55, "rgba(170,175,190,0.16)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, b.size, 0, 7);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    const spec = ctx.createRadialGradient(S * 0.35, S * 0.27, 2, S * 0.35, S * 0.27, 58);
    spec.addColorStop(0, "rgba(255,255,255,0.85)");
    spec.addColorStop(0.4, "rgba(255,255,255,0.25)");
    spec.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = spec;
    ctx.fillRect(0, 0, S, S);
    const rim = ctx.createRadialGradient(S / 2, S / 2, S * 0.4, S / 2, S / 2, S * 0.5);
    rim.addColorStop(0, "rgba(0,0,0,0)");
    rim.addColorStop(1, "rgba(220,225,235,0.28)");
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, S, S);
    ctx.restore();
    if (!reduce && !document.hidden) requestAnimationFrame(frame);
  }
  frame();
  if (!reduce)
    document.addEventListener("visibilitychange", () => { if (!document.hidden) frame(); });
}
async function loadConnections() {
  state.connections = (await api("/api/connections")).connections;
  renderConnDots();
  if (state.route.view === "connections") renderConnections();
}

/* ============ router ============ */
const ROUTES = [
  [/^#\/home$/, () => ({ view: "home", id: null })],
  [/^#\/queue\/item\/(\d+)$/, (m) => ({ view: "queue", id: +m[1] })],
  [/^#\/queue$/, () => ({ view: "queue", id: null })],
  [/^#\/work\/run\/(\d+)$/, (m) => ({ view: "work", id: +m[1] })],
  [/^#\/work$/, () => ({ view: "work", id: null })],
  [/^#\/connections$/, () => ({ view: "connections", id: null })],
  [/^#\/ledger$/, () => ({ view: "ledger", id: null })],
];
function onHash() {
  const hash = location.hash || "#/home";
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
  location.replace("#/home");
}
window.addEventListener("hashchange", onHash);

/* ============ render root + topbar ============ */
function render() {
  renderTopbar();
  for (const v of ["home", "queue", "work", "connections", "ledger"]) {
    const sec = $("#view-" + v);
    sec.hidden = state.route.view !== v;
    sec.classList.toggle("has-id", state.route.view === v && state.route.id != null);
  }
  if (state.route.view === "home") renderHome();
  else if (state.route.view === "queue") { renderQueueList(); renderQueueDetail(); }
  else if (state.route.view === "work") { renderWorkList(); renderWorkDetail(); }
  else if (state.route.view === "ledger") renderLedger();
}

function renderTopbar() {
  $("#brain").textContent = state.brain || "…";
  for (const a of document.querySelectorAll("#tabs a"))
    a.classList.toggle("active", a.dataset.view === state.route.view);
  const urgent = state.queue.tasks.filter((t) => t.lane === 4).length;
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
  const a = $("#autopilot");
  a.classList.toggle("on", state.autopilot);
  a.setAttribute("aria-checked", String(state.autopilot));
  a.style.opacity = state.yolo ? "" : ".5";
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
function linkedRun(task) {
  return state.runs.find((r) => task.itemIds.includes(r.itemId)) ?? null;
}
const RUNLABEL = { running: "agent working…", waiting: "agent needs you", done: "agent done", failed: "agent failed" };

function renderQueueList() {
  const items = state.queue.tasks.map((it, ix) => ({ it, rank: ix + 1 }));
  const l4 = state.queue.tasks.filter((t) => t.lane === 4).length;
  const l3 = state.queue.tasks.length - l4;
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
      innerHTML: "<span class='mark'>🪞</span><b>Queue clear.</b><br>Run triage to read your inbox again.",
    }));
    return;
  }
  if (list.firstElementChild?.className === "empty") list.replaceChildren();
  syncList(list, items, {
    key: (w) => "i" + w.it.id,
    sig: (w) => {
      const last = w.it.chat?.at(-1);
      const run = linkedRun(w.it);
      return [w.rank, w.it.lane, w.it.count, w.it.chat?.length ?? 0, last?.status ?? "",
        !!w.it.draft, run?.status ?? "", (w.it.sent ?? []).join(","),
        state.route.id === w.it.id, timeAgo(w.it.createdAt)].join("|");
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
      const run = linkedRun(it);
      const last = it.chat?.at(-1);
      const badges = [];
      if (it.count > 1) badges.push(`<span class="tag">${it.count} updates</span>`);
      for (const k of it.sent ?? []) {
        const label = k.startsWith("linear") ? "linear ✓" : k.startsWith("slack") ? "slack ✓" : "github ✓";
        if (!badges.some((b) => b.includes(label))) badges.push(`<span class="tag acc">${label}</span>`);
      }
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

function displayChat(task) {
  const overlay = state.ui.overlay.get(task.key) ?? [];
  if (overlay.length) {
    const owner = overlay.find((m) => m.role === "owner");
    const lastOwner = [...(task.chat ?? [])].reverse().find((m) => m.role === "owner");
    if (owner && lastOwner && lastOwner.content === owner.content) {
      state.ui.overlay.delete(task.key); // server caught up
      return task.chat ?? [];
    }
  }
  return [...(task.chat ?? []), ...overlay];
}

function renderQueueDetail() {
  const pane = $("#q-detail");
  const id = state.route.id;
  if (id == null) {
    if (qd.key !== "ph") {
      pane.replaceChildren(Object.assign(document.createElement("div"), {
        className: "dplaceholder",
        innerHTML: "<span><span class='mark'>🪞</span>Select an item — its context, conversation, and actions live here.</span>",
      }));
      qd = { key: "ph" };
    }
    return;
  }
  const task = state.queue.tasks.find((t) => t.id === id || t.itemIds.includes(id));
  if (!task) { renderTerminal(pane, id); return; }
  if (qd.key !== "q" + task.key) buildQueueDetail(pane, task);
  updateQueueDetail(task);
}

function buildQueueDetail(pane, item) {
  qd = { key: "q" + item.key };
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
      // one task = every notification under it
      await Promise.all(item.itemIds.map((i) => api(`/api/items/${i}/dismiss`, {})));
      location.hash = "#/queue";
      tick();
    }),
    mkBtn("This is noise", "ghost", async () => {
      const r = await api(`/api/items/${item.id}/noise`, {}); // one rule, not N
      await Promise.all(item.itemIds.filter((i) => i !== item.id).map((i) => api(`/api/items/${i}/dismiss`, {})));
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

  // grouped updates (one task = all its notifications)
  if (item.count > 1) {
    const ev = document.createElement("div");
    ev.className = "thread-label";
    ev.textContent = `${item.count} updates on this task`;
    const list = document.createElement("div");
    list.className = "dwhy";
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.gap = "5px";
    list.innerHTML = item.events
      .map((e) => `<span>· ${esc(e.actor ?? e.kind)} — ${esc(e.summary)} <i>(${timeAgo(e.createdAt)})</i></span>`)
      .join("");
    scroll.append(ev, list);
  }

  // draft + approve
  const draftItemId = item.draftItemId;
  if (item.draft && draftItemId) {
    state.ui.draftBase.set(draftItemId, item.draft);
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
    ta.value = state.ui.drafts.get(draftItemId) ?? item.draft;
    ta.addEventListener("input", () => state.ui.drafts.set(draftItemId, ta.value));
    qd.draftNotice.addEventListener("click", () => {
      state.ui.drafts.delete(draftItemId);
      ta.value = state.ui.draftBase.get(draftItemId) ?? "";
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
        const r = await api(`/api/items/${draftItemId}/approve`, { draft: ta.value });
        qd.statusEl.textContent = "✓ " + r.note;
        toast("Sent — " + r.note);
        state.ui.drafts.delete(draftItemId);
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

  // loop closure strip — evidence from the approvals ledger, not intentions
  qd.loop = document.createElement("div");
  qd.loop.className = "runstrip";
  scroll.append(qd.loop);

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
  bar.addEventListener("submit", (e) => { e.preventDefault(); sendAsk(item); });

  pane.append(scroll, bar);
}

function sendAsk(task) {
  const q = qd.askInput.value.trim();
  if (!q) return;
  qd.askInput.value = "";
  state.ui.overlay.set(task.key, [
    { id: "tmp-o", role: "owner", content: q, status: "done" },
    { id: "tmp-p", role: "standin", content: "", status: "pending" },
  ]);
  render();
  api(`/api/items/${task.id}/ask`, { question: q })
    .then(() => scheduleTick(true)) // the next tick's merged chat replaces the overlay
    .catch((e) => {
      state.ui.overlay.set(task.key, [
        { id: "tmp-o", role: "owner", content: q, status: "done" },
        { id: "tmp-p", role: "standin", content: e.message, status: "failed", retryQ: q },
      ]);
      render();
    });
}

function bubbleNode(m, task) {
  const el = document.createElement("div");
  el.setAttribute("data-bubble", "");
  fillBubble(el, m, task);
  return el;
}
function fillBubble(el, m, task) {
  el.className = `bubble ${m.role}` + (m.status === "pending" ? " pending" : m.status === "failed" ? " failed" : "");
  el.replaceChildren();
  if (m.status === "pending") el.textContent = "pulling the live ticket and thinking…";
  else if (m.status === "failed") {
    el.append(document.createTextNode("failed: " + m.content + " "));
    if (task) {
      const retry = mkBtn("Retry", "ghost", () => {
        const prev = m.retryQ ?? [...(task.chat ?? [])].reverse().find((x) => x.role === "owner")?.content;
        if (prev) { qd.askInput.value = prev; sendAsk(task); }
      });
      retry.style.padding = "2px 10px";
      el.append(retry);
    }
  } else if (m.role === "standin") el.append(md(m.content));
  else el.textContent = m.content;
}

function updateQueueDetail(item) {
  $("[data-when]", qd.scroll) && ($("[data-when]", qd.scroll).textContent = timeAgo(item.createdAt));
  qd.goBtn.hidden = !state.yolo;

  // draft changed server-side while locally edited?
  if (qd.draftTa && item.draftItemId) {
    const base = state.ui.draftBase.get(item.draftItemId);
    if (item.draft !== base) {
      if (state.ui.drafts.has(item.draftItemId)) qd.draftNotice.hidden = false;
      else if (document.activeElement !== qd.draftTa) {
        qd.draftTa.value = item.draft ?? "";
        state.ui.draftBase.set(item.draftItemId, item.draft);
      }
    }
  }

  // loop closure chips
  const sent = item.sent ?? [];
  const run = linkedRun(item);
  const loopChip = (label, done, active) =>
    `<span class="tag ${done ? "acc" : active ? "acc pulse" : ""}">${label} ${done ? "✓" : active ? "…" : "—"}</span>`;
  qd.loop.innerHTML =
    `<span class="tag" style="border:none;padding-left:0">loop:</span>` +
    loopChip("work", run?.status === "done", run?.status === "running" || run?.status === "waiting") +
    loopChip("linear", sent.includes("linear.comment"), false) +
    loopChip("slack", sent.includes("slack.message"), false) +
    loopChip("github", sent.includes("github.comment") || sent.includes("github.merge"), false);

  // linked runs strip (no inputs — safe to rebuild)
  const runs = state.runs.filter((r) => item.itemIds.includes(r.itemId));
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
    create: (m) => bubbleNode(m, item),
    update: (el, m) => fillBubble(el, m, item),
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
  for (const m of cached.chat ?? []) thread.append(bubbleNode(m, null));
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
      innerHTML: "<span class='mark'>🪞</span>No agents have run yet.<br>Give one a task above, or <b>Go do it</b> on a queue item.",
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
        innerHTML: "<span><span class='mark'>🪞</span>Select a run — its brief, questions, log, and report live here.</span>",
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
const BRAND = {
  claude: { mark: "C", color: "#D97757", role: "the brain's runtime — your Claude account" },
  github: { mark: "G", color: "#24292F", role: "repos, PRs, and yolo pushes — as you" },
  linear: { mark: "L", color: "#5E6AD2", role: "your inbox in, approved comments out" },
  slack: { mark: "S", color: "#4A154B", role: "approved announcements to your channel" },
};

function renderConnections() {
  const on = state.connections.filter((c) => c.connected).length;
  const total = state.connections.length || 4;
  const prog = $("#conn-progress");
  prog.innerHTML = `
    <span class="ptext">${on === total
      ? "<b>Fully powered.</b> Every connection is live."
      : `<b>${on} of ${total} connected.</b> ${total - on} to go — each card walks you through it.`}</span>
    <span class="pbar">${state.connections.map((c) => `<i class="${c.connected ? "on" : ""}"></i>`).join("")}</span>`;
  $("#conn-grid").replaceChildren(...state.connections.map(connCard));
}

function foldSection(label, node, open = false) {
  const d = document.createElement("details");
  if (open) d.open = true;
  const s = document.createElement("summary");
  s.textContent = label;
  const body = document.createElement("div");
  body.className = "body";
  body.append(node);
  d.append(s, body);
  return d;
}

function connCard(c) {
  const brand = BRAND[c.id] ?? { mark: "?", color: "#888", role: "" };
  const el = document.createElement("div");
  el.className = "conn";

  // head: monogram · name/role · status pill
  const head = document.createElement("div");
  head.className = "head";
  head.innerHTML = `
    <span class="mono-mark" style="background:${brand.color}">${brand.mark}</span>
    <span class="titlebox">
      <span class="name">${esc(c.name)}</span>
      ${c.connected && c.who ? `<span class="who">${esc(c.who)}</span>` : `<span class="role">${esc(brand.role)}</span>`}
    </span>
    <span class="statuspill ${c.connected ? "on" : "off"}"><span class="dot"></span>${c.connected ? "Connected" : "Not connected"}</span>`;
  el.append(head);

  // primary CTA row (only while disconnected)
  if (!c.connected) {
    const cta = document.createElement("div");
    cta.className = "cta";
    if (c.id === "linear") {
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
      cta.append(oauth, msg);
    } else if (!c.acceptsToken) {
      cta.innerHTML = `<span class="msg" style="color:var(--muted)">${esc(c.detail)}</span>`;
    }
    if (c.acceptsToken) {
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.type = "password";
      input.placeholder = c.id === "linear" ? "or paste an API key: lin_api_…" : "paste your bot token: xoxb-…";
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
      cta.append(form);
    }
    el.append(cta);
  }

  // setup guide, folded (steps + manifest) — the server includes these exactly
  // when they're needed (disconnected, or connected-but-degraded like send-only)
  if (c.steps || c.manifest) {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "10px";
    if (c.steps) {
      const ol = document.createElement("ol");
      ol.replaceChildren(...c.steps.map((s) => {
        const li = document.createElement("li");
        li.innerHTML = esc(s)
          .replace(/(api\.slack\.com\/apps)/g, '<a href="https://$1" target="_blank" rel="noopener">$1</a>')
          .replace(/(chat:write|xoxb-|\/invite @standin|gh auth login|brew install gh)/g, "<code>$1</code>")
          .replace(/“([^”]+)”/g, "<b>“$1”</b>");
        return li;
      }));
      wrap.append(ol);
    }
    if (c.manifest) {
      const pre = document.createElement("div");
      pre.className = "manifest";
      const copy = mkBtn("Copy", "", async () => {
        try { await navigator.clipboard.writeText(c.manifest); toast("Manifest copied — paste it in Slack's “From a manifest” box"); }
        catch { toast("Couldn't access the clipboard — select and copy it manually", "err"); }
      });
      pre.append(copy, document.createTextNode(c.manifest));
      wrap.append(pre);
    }
    el.append(foldSection("Setup guide — step by step", wrap, c.id === "slack" && !c.connected));
  }

  // grants, folded — always available, never sugarcoated
  if (c.permissions?.length) {
    const g = document.createElement("div");
    g.className = "grants";
    const ul = document.createElement("ul");
    ul.replaceChildren(...c.permissions.map((p) => Object.assign(document.createElement("li"), { textContent: p })));
    g.append(ul);
    el.append(foldSection("What connecting grants", g));
  }

  if (c.acceptsToken && c.connected) {
    const row = document.createElement("div");
    row.className = "actions";
    row.append(mkBtn("Disconnect", "ghost", async () => {
      await apiDelete(`/api/connections/${c.id}`);
      await loadConnections();
    }));
    el.append(row);
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
async function toggleAutopilot() {
  if (!state.yolo && !state.autopilot) { toast("Auto-brief needs yolo on — it starts agents", "err"); return; }
  const { on } = await api("/api/autopilot", { on: !state.autopilot });
  state.autopilot = on;
  toast(on
    ? "Auto-brief on — every new task gets an agent that briefs you; nothing executes before your go"
    : "Auto-brief off — agents start only when you click Go do it");
  renderTopbar();
}
$("#autopilot").addEventListener("click", toggleAutopilot);
$("#autopilot").addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleAutopilot(); } });
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
    toast(`Triage done — ${r.new} new item${r.new === 1 ? "" : "s"}${r.briefed ? ` · ${r.briefed} agent${r.briefed === 1 ? "" : "s"} briefing` : ""}`);
    for (const w of r.warnings ?? []) toast(w, "err");
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
startOrb();
loadYolo();
loadConnections();
onHash();
tick();
