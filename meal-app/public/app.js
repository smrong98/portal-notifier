const $ = selector => document.querySelector(selector);
const MEALS = { breakfast: "조식", lunch: "중식", dinner: "석식" };
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const CREDENTIAL_KEY = "mealNotifierCredential";
const SETTINGS_KEY = "mealNotifierDraftSettings";

let bootstrap = { meals: [], restaurants: [], vapidPublicKey: "" };
let credential = readJson(CREDENTIAL_KEY);
let settings = readJson(SETTINGS_KEY) || defaultSettings();
let selectedWeekStart = null;
let selectedDate = null;

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function defaultSettings() {
  return {
    restaurant: "namsan",
    timezone: "Asia/Seoul",
    weekendNotifications: true,
    mealNotifications: {
      breakfast: { enabled: true, time: "07:00" },
      lunch: { enabled: true, time: "11:00" },
      dinner: { enabled: true, time: "16:30" }
    }
  };
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function authHeaders() {
  return credential?.managementToken ? { authorization: `Bearer ${credential.managementToken}` } : {};
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function todayInSeoul() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function formatDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  return `${value.getUTCMonth() + 1}.${value.getUTCDate()} (${DAYS[value.getUTCDay()]})`;
}

function datesInWeek(meal) {
  const result = [];
  const end = Date.parse(`${meal.weekEnd}T00:00:00Z`);
  for (let time = Date.parse(`${meal.weekStart}T00:00:00Z`); time <= end; time += 86400000) {
    result.push(new Date(time).toISOString().slice(0, 10));
  }
  return result;
}

function effectiveWeekEnd(meal) {
  const sunday = new Date(Date.parse(`${meal.weekStart}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
  return meal.weekEnd > sunday ? meal.weekEnd : sunday;
}

function renderMeal() {
  const today = todayInSeoul();
  const chronologicalMeals = [...bootstrap.meals].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const meal = bootstrap.meals.find(item => item.weekStart === selectedWeekStart)
    || bootstrap.meals.find(item => item.weekStart <= today && item.weekEnd >= today)
    || chronologicalMeals.findLast(item => item.weekStart <= today)
    || chronologicalMeals[0];
  if (!meal) {
    $("#mealContent").innerHTML = '<div class="empty">아직 등록된 식단이 없습니다.</div>';
    $("#updatedAt").textContent = "업데이트 대기";
    return;
  }
  selectedWeekStart = meal.weekStart;
  const dates = datesInWeek(meal);
  if (!selectedDate || !dates.includes(selectedDate)) {
    selectedDate = dates.includes(today) ? today : today > meal.weekEnd ? dates.at(-1) : dates[0];
  }

  $("#weekTabs").innerHTML = bootstrap.meals.map(item => {
    const displayEnd = effectiveWeekEnd(item);
    const relation = item.weekStart <= today && displayEnd >= today ? "이번 주" : displayEnd < today ? "지난 주" : "다음 주";
    return `<button class="tab${item.weekStart === selectedWeekStart ? " active" : ""}" data-week="${item.weekStart}">${relation} ${formatDate(item.weekStart)}~${formatDate(item.weekEnd)}</button>`;
  }).join("");
  $("#weekTabs").querySelectorAll("[data-week]").forEach(button => {
    button.addEventListener("click", () => { selectedWeekStart = button.dataset.week; selectedDate = null; renderMeal(); });
  });

  $("#dayTabs").innerHTML = dates.map(date => {
    const value = new Date(`${date}T00:00:00Z`);
    return `<button class="day${date === selectedDate ? " active" : ""}" data-date="${date}"><small>${DAYS[value.getUTCDay()]}요일</small>${value.getUTCDate()}</button>`;
  }).join("");
  $("#dayTabs").querySelectorAll("[data-date]").forEach(button => {
    button.addEventListener("click", () => { selectedDate = button.dataset.date; renderMeal(); });
  });

  $("#mealDate").textContent = formatDate(selectedDate);
  $("#updatedAt").textContent = meal.publishedAt ? `${new Date(meal.publishedAt).toLocaleDateString("ko-KR")} 갱신` : "업데이트됨";
  const restaurants = (meal.restaurants || []).map(restaurant => ({
    ...restaurant,
    day: restaurant.days?.[selectedDate]
  })).filter(restaurant => restaurant.day && Object.keys(restaurant.day).length);
  $("#mealContent").innerHTML = restaurants.length ? restaurants.map(restaurant => `
    <div class="restaurant">
      <span class="restaurant-name">${escapeHtml(restaurant.name)}</span>
      ${Object.entries(MEALS).map(([mealKey, label]) => {
        const corners = restaurant.day[mealKey];
        if (!corners) return "";
        const content = Object.entries(corners).map(([corner, items]) => `<div class="corner">${corner === "menu" ? "" : `<strong>${escapeHtml(corner)}</strong>`}${items.map(escapeHtml).join(", ")}</div>`).join("");
        return `<div class="meal-row"><span class="meal-label">${label}</span><div>${content}</div></div>`;
      }).join("")}
    </div>`).join("") : '<div class="empty">선택한 날짜에 등록된 식단이 없습니다.</div>';
}

function renderSettings() {
  $("#restaurant").innerHTML = bootstrap.restaurants.map(restaurant => `
    <option value="${escapeHtml(restaurant.key)}">${escapeHtml(restaurant.name)}</option>`).join("");
  $("#restaurant").value = settings.restaurant || "namsan";
  $("#mealSettings").innerHTML = Object.entries(MEALS).map(([mealKey, label]) => {
    const value = settings.mealNotifications?.[mealKey] || defaultSettings().mealNotifications[mealKey];
    return `<div class="meal-setting">
      <label class="toggle"><input type="checkbox" data-enabled="${mealKey}" ${value.enabled ? "checked" : ""}><span>${label} 알림</span></label>
      <label class="field"><input type="time" data-time="${mealKey}" value="${escapeHtml(value.time)}" aria-label="${label} 알림 시각"></label>
    </div>`;
  }).join("");
  $("#weekendNotifications").checked = settings.weekendNotifications !== false;
  renderConnectionState();
}

function collectSettings() {
  return {
    restaurant: $("#restaurant").value,
    timezone: "Asia/Seoul",
    weekendNotifications: $("#weekendNotifications").checked,
    mealNotifications: Object.fromEntries(Object.keys(MEALS).map(mealKey => [mealKey, {
      enabled: Boolean(document.querySelector(`[data-enabled="${mealKey}"]`)?.checked),
      time: document.querySelector(`[data-time="${mealKey}"]`)?.value
    }]))
  };
}

function setMessage(value, isError = false) {
  const element = $("#message");
  element.textContent = value;
  element.classList.toggle("error", isError);
}

function renderConnectionState() {
  const connected = Boolean(credential?.id && credential?.managementToken);
  $("#notificationState").textContent = connected ? "알림 연결됨" : "연결 안 됨";
  $("#notificationState").className = `badge ${connected ? "connected" : "muted"}`;
  $("#testNotification").disabled = !connected;
  $("#disableNotifications").disabled = !connected;
}

function applicationServerKey(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from([...atob(base64)].map(character => character.charCodeAt(0)));
}

async function serviceWorkerRegistration() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("이 브라우저는 Web Push를 지원하지 않습니다.");
  await navigator.serviceWorker.register("./sw.js");
  return navigator.serviceWorker.ready;
}

async function enableNotifications() {
  setMessage("");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("알림 권한이 허용되지 않았습니다.");
  const registration = await serviceWorkerRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(bootstrap.vapidPublicKey)
    });
  }
  settings = collectSettings();
  const result = await api("/api/subscriptions", {
    method: "POST",
    body: JSON.stringify({ subscription: subscription.toJSON(), settings })
  });
  credential = { id: result.id, managementToken: result.managementToken };
  settings = result.settings;
  saveJson(CREDENTIAL_KEY, credential);
  saveJson(SETTINGS_KEY, settings);
  renderSettings();
  setMessage("이 기기의 식사 알림을 연결했습니다.");
}

async function saveSettings() {
  settings = collectSettings();
  saveJson(SETTINGS_KEY, settings);
  if (!credential) {
    setMessage("설정을 기기에 저장했습니다. 알림 허용을 누르면 서버에 연결됩니다.");
    return;
  }
  const result = await api(`/api/subscriptions/${credential.id}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(settings)
  });
  settings = result.settings;
  saveJson(SETTINGS_KEY, settings);
  renderSettings();
  setMessage("알림 설정을 저장했습니다.");
}

async function testNotification() {
  await api(`/api/subscriptions/${credential.id}/test`, { method: "POST", headers: authHeaders() });
  setMessage("테스트 알림을 전송했습니다.");
}

async function disableNotifications() {
  await api(`/api/subscriptions/${credential.id}`, { method: "DELETE", headers: authHeaders() });
  const registration = await serviceWorkerRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) await subscription.unsubscribe();
  credential = null;
  localStorage.removeItem(CREDENTIAL_KEY);
  renderConnectionState();
  setMessage("이 기기의 알림을 해제했습니다.");
}

async function restoreSettings() {
  if (!credential) return;
  try {
    const result = await api(`/api/subscriptions/${credential.id}`, { headers: authHeaders() });
    settings = result.settings;
    saveJson(SETTINGS_KEY, settings);
  } catch {
    credential = null;
    localStorage.removeItem(CREDENTIAL_KEY);
  }
}

async function init() {
  bootstrap = await api("/api/bootstrap");
  await restoreSettings();
  const queryDate = new URL(location.href).searchParams.get("date");
  if (/^\d{4}-\d{2}-\d{2}$/.test(queryDate || "")) selectedDate = queryDate;
  renderMeal();
  renderSettings();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);
}

$("#enableNotifications").addEventListener("click", () => enableNotifications().catch(error => setMessage(error.message, true)));
$("#saveSettings").addEventListener("click", () => saveSettings().catch(error => setMessage(error.message, true)));
$("#testNotification").addEventListener("click", () => testNotification().catch(error => setMessage(error.message, true)));
$("#disableNotifications").addEventListener("click", () => disableNotifications().catch(error => setMessage(error.message, true)));
init().catch(error => {
  $("#mealContent").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  setMessage(error.message, true);
});
