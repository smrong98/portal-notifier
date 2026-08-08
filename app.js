const $ = (sel) => document.querySelector(sel);
const workerUrl = (window.PORTAL_NOTIFIER_CONFIG?.WORKER_URL || "").replace(/\/$/, "");

function getClientKey() {
  return localStorage.getItem("portalNotifierClientKey") || "";
}

function setClientKey(value) {
  localStorage.setItem("portalNotifierClientKey", value.trim());
}

async function api(path, options = {}) {
  if (!workerUrl || workerUrl.includes("YOUR-SUBDOMAIN")) {
    throw new Error("frontend/config.js에 Worker URL을 먼저 입력하세요.");
  }

  const headers = new Headers(options.headers || {});
  headers.set("X-Client-Key", getClientKey());
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(workerUrl + path, {
    ...options,
    headers
  });

  let body = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    throw new Error(body?.error || `HTTP ${res.status}`);
  }

  return body;
}

function base64UrlToUint8Array(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function registerPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("이 브라우저는 Web Push를 지원하지 않습니다.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("알림 권한이 허용되지 않았습니다.");
  }

  const registration = await navigator.serviceWorker.register("./sw.js");
  await navigator.serviceWorker.ready;

  const { publicKey } = await api("/api/vapid-public-key");
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey)
    });
  }

  await api("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON())
  });

  $("#pushState").textContent = "알림 연결됨";
}

function renderRecent(posts) {
  const container = $("#recent");
  container.innerHTML = "";

  if (!posts?.length) {
    container.innerHTML = `<div class="empty">아직 감지된 새 게시글이 없습니다.</div>`;
    return;
  }

  for (const post of posts.slice(0, 20)) {
    const item = document.createElement("div");
    item.className = "post";
    item.innerHTML = `
      <div class="post-board">${escapeHtml(post.boardName || "")}</div>
      <div class="post-title">${escapeHtml(post.title || "")}</div>
      <div class="post-date">${escapeHtml(post.regDt || post.detectedAt || "")}</div>
    `;
    container.appendChild(item);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadConfig() {
  const data = await api("/api/config");
  const s = data.settings;

  $("#interval").value = String(s.intervalMinutes);
  $("#quietEnabled").checked = Boolean(s.quietEnabled);
  $("#quietStart").value = s.quietStart;
  $("#quietEnd").value = s.quietEnd;

  const boards = $("#boards");
  boards.innerHTML = "";
  for (const board of data.boards) {
    const label = document.createElement("label");
    label.className = "check-row";
    label.innerHTML = `
      <input type="checkbox" value="${escapeHtml(board.key)}"
        ${s.enabledBoards.includes(board.key) ? "checked" : ""}>
      <span>${escapeHtml(board.name)}</span>
    `;
    boards.appendChild(label);
  }
}

async function loadStatus() {
  const s = await api("/api/status");

  $("#statusDot").className = `dot ${s.ok ? "ok" : "bad"}`;
  $("#statusText").textContent = s.ok ? "정상" : "오류";
  $("#lastCheck").textContent = s.lastSuccessAt
    ? new Date(s.lastSuccessAt).toLocaleString()
    : "아직 없음";

  $("#lastError").textContent = s.lastError || "";
  $("#lastError").style.display = s.lastError ? "block" : "none";
  $("#pending").textContent = String(s.pendingCount || 0);

  renderRecent(s.recent || []);
}

async function saveSettings() {
  const enabledBoards = [...$("#boards input:checked")].map((el) => el.value);

  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      intervalMinutes: Number($("#interval").value),
      quietEnabled: $("#quietEnabled").checked,
      quietStart: $("#quietStart").value,
      quietEnd: $("#quietEnd").value,
      timezone: "Asia/Seoul",
      enabledBoards
    })
  });

  flash("설정 저장 완료");
}

function flash(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1800);
}

async function guarded(action) {
  try {
    await action();
  } catch (err) {
    alert(err.message || String(err));
  }
}

async function initialize() {
  $("#clientKey").value = getClientKey();

  $("#saveClientKey").addEventListener("click", () => {
    setClientKey($("#clientKey").value);
    flash("앱 키 저장 완료");
  });

  $("#saveSettings").addEventListener("click", () => guarded(saveSettings));
  $("#enablePush").addEventListener("click", () => guarded(registerPush));

  $("#testPush").addEventListener("click", () =>
    guarded(async () => {
      await api("/api/push/test", { method: "POST" });
      flash("테스트 알림 전송");
    })
  );

  $("#checkNow").addEventListener("click", () =>
    guarded(async () => {
      $("#checkNow").disabled = true;
      try {
        await api("/api/check", { method: "POST" });
        await loadStatus();
        flash("확인 완료");
      } finally {
        $("#checkNow").disabled = false;
      }
    })
  );

  if (getClientKey()) {
    await guarded(async () => {
      await Promise.all([loadConfig(), loadStatus()]);
    });
  }
}

initialize();
