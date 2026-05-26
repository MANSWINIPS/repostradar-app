// src/shared/api.ts
var MatchReason = {
  /** Reddit's getDuplicatesForPost returned this — same URL/image. */
  ExactUrl: "exact_url",
  /** Title tokens overlap significantly with the current post. */
  TitleSimilarity: "title_similarity",
  /** Both (URL match and title overlap). */
  Both: "both"
};
var ViewMode = {
  Scan: "scan",
  Stats: "stats"
};
var ApiEndpoint = {
  // Client HTTP routes
  Init: "/api/init",
  Remove: "/api/remove",
  Stats: "/api/stats",
  // Menu actions
  MenuScanPost: "/internal/menu/scan-post",
  MenuStats: "/internal/menu/stats",
  // Triggers
  TriggerAppInstall: "/internal/triggers/app-install"
};

// src/client/game.ts
var $ = (id) => document.getElementById(id);
var subtitleEl = $("subtitle");
var currentCardEl = $("current-card");
var candidatesEl = $("candidates");
var emptyStateEl = $("empty-state");
var currentSectionEl = document.querySelector(
  ".current-section"
);
var candidatesSectionEl = document.querySelector(
  ".candidates-section"
);
var removeRowEl = $("remove-row");
var pickedLabelEl = $("picked-label");
var removeButtonEl = $("remove-button");
var refreshButtonEl = $("refresh-button");
var statsButtonEl = $("stats-button");
var statsPanelEl = $("stats-panel");
var statsBodyEl = $("stats-body");
var closeStatsEl = $("close-stats");
var toastEl = $("toast");
var state = {};
function reasonLabel(reason) {
  switch (reason) {
    case MatchReason.ExactUrl:
      return "Same URL";
    case MatchReason.TitleSimilarity:
      return "Similar title";
    case MatchReason.Both:
      return "URL + title";
    default:
      return "Match";
  }
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtNum(n) {
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}
function permalinkHref(p) {
  return p.startsWith("http") ? p : `https://www.reddit.com${p}`;
}
function showToast(text, kind) {
  toastEl.textContent = text;
  toastEl.dataset["kind"] = kind;
  toastEl.classList.add("visible");
  window.setTimeout(() => toastEl.classList.remove("visible"), 3200);
}
function renderCurrent(current) {
  const thumb = current.thumbnail ? `<img class="thumb" src="${escapeHtml(current.thumbnail)}" alt="" />` : `<div class="thumb thumb-placeholder">\u{1F4DD}</div>`;
  const removedBadge = current.removed ? `<span class="pill pill-danger">Removed</span>` : "";
  currentCardEl.innerHTML = `
    ${thumb}
    <div class="card-body">
      <div class="card-title-row">
        <a class="card-title" href="${escapeHtml(
    permalinkHref(current.permalink)
  )}" target="_blank" rel="noopener noreferrer">${escapeHtml(current.title)}</a>
        ${removedBadge}
      </div>
      <div class="card-meta">
        <span>by u/${escapeHtml(current.authorName)}</span>
        <span>\xB7</span>
        <span>${fmtNum(current.score)} pts</span>
        <span>\xB7</span>
        <span>${fmtNum(current.numComments)} comments</span>
      </div>
    </div>
  `;
}
function renderCandidate(c, isMod) {
  const li = document.createElement("li");
  li.className = "candidate";
  const thumb = c.thumbnail ? `<img class="thumb" src="${escapeHtml(c.thumbnail)}" alt="" />` : `<div class="thumb thumb-placeholder">\u{1F4DD}</div>`;
  const simPct = Math.round(c.similarity * 100);
  const reasonClass = c.reason === MatchReason.ExactUrl ? "reason-url" : c.reason === MatchReason.Both ? "reason-both" : "reason-title";
  const pickBtn = isMod ? `<button class="ghost-btn small pick-btn" data-id="${escapeHtml(c.id)}">Use as original</button>` : "";
  li.innerHTML = `
    ${thumb}
    <div class="card-body">
      <div class="card-title-row">
        <a class="card-title" href="${escapeHtml(
    permalinkHref(c.permalink)
  )}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.title)}</a>
        <span class="pill ${reasonClass}">${reasonLabel(c.reason)}</span>
      </div>
      <div class="card-meta">
        <span>by u/${escapeHtml(c.authorName)}</span>
        <span>\xB7</span>
        <span>${escapeHtml(c.ageLabel)}</span>
        <span>\xB7</span>
        <span>${fmtNum(c.score)} pts</span>
        <span>\xB7</span>
        <span>${fmtNum(c.numComments)} comments</span>
      </div>
      <div class="sim-row">
        <div class="sim-bar"><div class="sim-fill" style="width:${simPct}%"></div></div>
        <span class="sim-pct">${simPct}%</span>
        ${pickBtn}
      </div>
    </div>
  `;
  const btn = li.querySelector(".pick-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      state.selected = c;
      pickedLabelEl.textContent = `Original: "${c.title.length > 50 ? `${c.title.slice(0, 50)}\u2026` : c.title}"`;
      removeButtonEl.disabled = false;
      for (const el of candidatesEl.querySelectorAll(".candidate")) {
        el.classList.remove("selected");
      }
      li.classList.add("selected");
    });
  }
  return li;
}
function renderScanView(init) {
  subtitleEl.textContent = init.candidates.length === 0 ? `No likely duplicates found in r/${init.subredditName}.` : `${init.candidates.length} likely duplicate${init.candidates.length === 1 ? "" : "s"} in r/${init.subredditName}.`;
  if (init.current) renderCurrent(init.current);
  candidatesEl.innerHTML = "";
  if (init.candidates.length === 0) {
    emptyStateEl.style.display = "";
    emptyStateEl.querySelector(".empty-text").textContent = `No likely duplicates found in r/${init.subredditName}.`;
  } else {
    emptyStateEl.style.display = "none";
    for (const c of init.candidates) {
      candidatesEl.appendChild(renderCandidate(c, init.isModerator));
    }
  }
  if (init.isModerator && init.current && !init.current.removed) {
    removeRowEl.style.display = "";
    removeButtonEl.disabled = true;
  } else {
    removeRowEl.style.display = "none";
  }
}
function renderStatsOnlyView(init) {
  subtitleEl.textContent = `Repost stats for r/${init.subredditName}`;
  currentSectionEl.style.display = "none";
  candidatesSectionEl.style.display = "none";
  removeRowEl.style.display = "none";
  refreshButtonEl.style.display = "none";
  statsButtonEl.style.display = "none";
  openStats();
}
function renderStats(stats) {
  const rows = stats.topReposters.length ? `<table class="stats-table">
        <thead><tr><th>#</th><th>User</th><th>Removals</th></tr></thead>
        <tbody>${stats.topReposters.map(
    (r, i) => `<tr><td>${i + 1}</td><td>u/${escapeHtml(r.username)}</td><td>${r.removalCount}</td></tr>`
  ).join("")}</tbody>
      </table>` : `<div class="muted">No reposters tracked yet.</div>`;
  statsBodyEl.innerHTML = `
    <div class="stats-numbers">
      <div class="stats-num">
        <div class="stats-num-value">${stats.removalsLast7d}</div>
        <div class="stats-num-label">Removed in last 7 days</div>
      </div>
      <div class="stats-num">
        <div class="stats-num-value">${stats.removalsAllTime}</div>
        <div class="stats-num-label">Removed all-time</div>
      </div>
    </div>
    <h3 class="stats-subhead">Top reposters</h3>
    ${rows}
  `;
}
async function fetchJSON(url, init) {
  const rsp = await fetch(url, init);
  if (!rsp.ok) {
    let msg = `HTTP ${rsp.status}`;
    try {
      const j = await rsp.json();
      if (j.error) msg = j.error;
    } catch {
    }
    throw Error(msg);
  }
  return await rsp.json();
}
async function loadInit() {
  subtitleEl.textContent = "Scanning\u2026";
  candidatesEl.innerHTML = "";
  emptyStateEl.style.display = "none";
  try {
    const data = await fetchJSON(ApiEndpoint.Init);
    state.init = data;
    if (data.mode === ViewMode.Scan) {
      renderScanView(data);
    } else {
      renderStatsOnlyView(data);
    }
  } catch (err) {
    subtitleEl.textContent = "Failed to load.";
    showToast(
      err instanceof Error ? err.message : "Failed to load.",
      "danger"
    );
  }
}
async function openStats() {
  statsPanelEl.classList.add("visible");
  statsBodyEl.textContent = "Loading\u2026";
  try {
    const stats = await fetchJSON(ApiEndpoint.Stats);
    renderStats(stats);
  } catch (err) {
    statsBodyEl.textContent = err instanceof Error ? err.message : "Failed to load stats.";
  }
}
async function doRemove() {
  const init = state.init;
  if (!init || !init.current) return;
  const selected = state.selected;
  const body = selected ? {
    originalPermalink: selected.permalink,
    originalTitle: selected.title
  } : {};
  const confirmed = window.confirm(
    selected ? `Remove this post as a repost of:

"${selected.title}"

A stickied removal comment will be posted citing the original.` : `Remove this post as a repost? No original was selected \u2014 no citation comment will be posted.`
  );
  if (!confirmed) return;
  removeButtonEl.disabled = true;
  try {
    const rsp = await fetchJSON(ApiEndpoint.Remove, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    showToast(
      rsp.removalCommentPermalink ? "Post removed. Stickied citation posted." : "Post removed.",
      "success"
    );
    if (init.current) init.current.removed = true;
    renderScanView(init);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Remove failed.", "danger");
    removeButtonEl.disabled = false;
  }
}
refreshButtonEl.addEventListener("click", () => void loadInit());
statsButtonEl.addEventListener("click", () => void openStats());
closeStatsEl.addEventListener(
  "click",
  () => statsPanelEl.classList.remove("visible")
);
removeButtonEl.addEventListener("click", () => void doRemove());
void loadInit();
//# sourceMappingURL=game.js.map
