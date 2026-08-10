import webpush from "web-push";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  DEFAULT_SETTINGS,
  isWeekendDate,
  MEALS,
  RESTAURANTS,
  localDateTime,
  mealForDate,
  mealNotification,
  sanitizeMeal,
  sanitizeSettings
} from "./domain.js";

const MEAL_INDEX_KEY = "meal:index";
const MAX_WEEKS = 3;
const MAX_DUE_PER_MEAL = 500;
const QUEUE_BATCH_SIZE = 100;
const OUTGOING_CONCURRENCY = 6;
const textEncoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  if (status >= 500) console.error(JSON.stringify({ event: "request_error", error: String(error?.message || error) }));
  return json({ error: status >= 500 ? "서버 오류가 발생했습니다." : String(error.message) }, status);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJsonBody(request, maxBytes = 16 * 1024) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw httpError(413, "요청 본문이 너무 큽니다.");
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw httpError(413, "요청 본문이 너무 큽니다.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw httpError(400, "올바른 JSON 요청이 필요합니다."); }
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(String(token || "")));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function validatePushSubscription(value) {
  let endpoint;
  try { endpoint = new URL(value?.endpoint); } catch { throw httpError(400, "유효하지 않은 Push 구독입니다."); }
  if (endpoint.protocol !== "https:" || !value?.keys?.p256dh || !value?.keys?.auth) {
    throw httpError(400, "유효하지 않은 Push 구독입니다.");
  }
  const p256dh = String(value.keys.p256dh);
  const auth = String(value.keys.auth);
  if (endpoint.toString().length > 2048 || p256dh.length > 512 || auth.length > 256) {
    throw httpError(400, "Push 구독 데이터가 너무 큽니다.");
  }
  return { endpoint: endpoint.toString(), p256dh, auth };
}

function settingsFromRow(row) {
  return {
    restaurant: row.restaurant,
    timezone: row.timezone,
    weekendNotifications: Boolean(row.weekend_enabled),
    mealNotifications: Object.fromEntries(Object.keys(MEALS).map(mealKey => [mealKey, {
      enabled: Boolean(row[`${mealKey}_enabled`]),
      time: row[`${mealKey}_time`]
    }]))
  };
}

function settingsValues(settings) {
  return Object.keys(MEALS).flatMap(mealKey => [
    settings.mealNotifications[mealKey].enabled ? 1 : 0,
    settings.mealNotifications[mealKey].time
  ]);
}

async function getSubscription(env, id, token) {
  if (!id || !token) throw httpError(401, "구독 관리 권한이 없습니다.");
  const row = await env.DB.prepare(
    "SELECT * FROM subscriptions WHERE id = ? AND management_token_hash = ?"
  ).bind(id, await tokenHash(token)).first();
  if (!row) throw httpError(404, "구독을 찾을 수 없습니다.");
  return row;
}

async function createSubscription(request, env) {
  const body = await readJsonBody(request);
  const push = validatePushSubscription(body.subscription);
  const settings = sanitizeSettings(body.settings);
  const existing = await env.DB.prepare("SELECT id FROM subscriptions WHERE endpoint = ?").bind(push.endpoint).first();
  const id = existing?.id || crypto.randomUUID();
  const managementToken = randomToken();
  const hash = await tokenHash(managementToken);
  const now = new Date().toISOString();
  const values = settingsValues(settings);

  if (existing) {
    await env.DB.prepare(`UPDATE subscriptions SET
      management_token_hash = ?, p256dh = ?, auth = ?, restaurant = ?, timezone = ?,
      breakfast_enabled = ?, breakfast_time = ?, lunch_enabled = ?, lunch_time = ?,
      dinner_enabled = ?, dinner_time = ?, weekend_enabled = ?, updated_at = ? WHERE id = ?`)
      .bind(hash, push.p256dh, push.auth, settings.restaurant, settings.timezone, ...values,
        settings.weekendNotifications ? 1 : 0, now, id).run();
  } else {
    await env.DB.prepare(`INSERT INTO subscriptions (
      id, management_token_hash, endpoint, p256dh, auth, restaurant, timezone,
      breakfast_enabled, breakfast_time, lunch_enabled, lunch_time,
      dinner_enabled, dinner_time, weekend_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, hash, push.endpoint, push.p256dh, push.auth, settings.restaurant, settings.timezone,
        ...values, settings.weekendNotifications ? 1 : 0, now, now).run();
  }
  return json({ id, managementToken, settings }, 201);
}

async function updateSubscription(request, env, id) {
  const row = await getSubscription(env, id, bearerToken(request));
  const settings = sanitizeSettings(await readJsonBody(request));
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE subscriptions SET restaurant = ?, timezone = ?,
    breakfast_enabled = ?, breakfast_time = ?, lunch_enabled = ?, lunch_time = ?,
    dinner_enabled = ?, dinner_time = ?, weekend_enabled = ?, updated_at = ? WHERE id = ?`)
    .bind(settings.restaurant, settings.timezone, ...settingsValues(settings),
      settings.weekendNotifications ? 1 : 0, now, row.id).run();
  return json({ ok: true, settings });
}

async function deleteSubscription(request, env, id) {
  const row = await getSubscription(env, id, bearerToken(request));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries WHERE subscription_id = ?").bind(row.id),
    env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(row.id)
  ]);
  return json({ ok: true });
}

async function mealIndex(env) {
  const value = await env.MEALS.get(MEAL_INDEX_KEY, "json");
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

async function getMeals(env) {
  const index = await mealIndex(env);
  const meals = await Promise.all(index.map(weekStart => env.MEALS.get(`meal:${weekStart}`, "json")));
  return meals.filter(Boolean).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

async function saveMeal(env, incoming) {
  const meal = sanitizeMeal(incoming);
  const previous = await mealIndex(env);
  const next = [...new Set([...previous, meal.weekStart])].sort().slice(-MAX_WEEKS);
  const removed = previous.filter(weekStart => !next.includes(weekStart));
  await Promise.all([
    env.MEALS.put(`meal:${meal.weekStart}`, JSON.stringify(meal)),
    env.MEALS.put(MEAL_INDEX_KEY, JSON.stringify(next)),
    ...removed.map(weekStart => env.MEALS.delete(`meal:${weekStart}`))
  ]);
  return { weekStart: meal.weekStart, weekEnd: meal.weekEnd, restaurants: meal.restaurants.length };
}

function webPushSubscription(row) {
  return { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
}

async function sendPush(env, row, payload) {
  return webpush.sendNotification(webPushSubscription(row), JSON.stringify(payload), {
    TTL: 3600,
    urgency: "normal",
    vapidDetails: {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY
    }
  });
}

async function removeDeadSubscription(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries WHERE subscription_id = ?").bind(id),
    env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(id)
  ]);
}

async function testSubscription(request, env, id) {
  const row = await getSubscription(env, id, bearerToken(request));
  const local = localDateTime();
  const meals = await getMeals(env);
  const meal = mealForDate(meals, local.date);
  try {
    await sendPush(env, row, {
      ...mealNotification(meal, local.date, "lunch", row.restaurant),
      title: "[테스트] 오늘의 중식"
    });
  } catch (error) {
    if (error?.statusCode === 404 || error?.statusCode === 410) {
      await removeDeadSubscription(env, row.id);
      throw httpError(410, "만료된 Push 구독입니다. 알림을 다시 허용해주세요.");
    }
    throw error;
  }
  return json({ ok: true });
}

async function api(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true, service: "meal-notifier" });
  if (url.pathname === "/api/bootstrap" && request.method === "GET") {
    return json({ meals: await getMeals(env), restaurants: RESTAURANTS, vapidPublicKey: env.VAPID_PUBLIC_KEY });
  }
  if (url.pathname === "/api/meals" && request.method === "GET") {
    return json({ meals: await getMeals(env) });
  }
  if (url.pathname === "/api/subscriptions" && request.method === "POST") {
    return createSubscription(request, env);
  }

  const match = url.pathname.match(/^\/api\/subscriptions\/([0-9a-f-]+)(?:\/(test))?$/i);
  if (match) {
    const [, id, action] = match;
    if (!action && request.method === "GET") {
      const row = await getSubscription(env, id, bearerToken(request));
      return json({ id: row.id, settings: settingsFromRow(row) });
    }
    if (!action && request.method === "PUT") return updateSubscription(request, env, id);
    if (!action && request.method === "DELETE") return deleteSubscription(request, env, id);
    if (action === "test" && request.method === "POST") return testSubscription(request, env, id);
  }
  throw httpError(404, "요청한 API를 찾을 수 없습니다.");
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

const dueColumns = Object.freeze({
  breakfast: ["breakfast_enabled", "breakfast_time"],
  lunch: ["lunch_enabled", "lunch_time"],
  dinner: ["dinner_enabled", "dinner_time"]
});

async function enqueueDueMeal(env, local, mealKey) {
  const [enabledColumn, timeColumn] = dueColumns[mealKey];
  const result = await env.DB.prepare(`SELECT s.id FROM subscriptions s
    WHERE s.${enabledColumn} = 1 AND s.${timeColumn} <= ?
      AND (? = 0 OR s.weekend_enabled = 1)
      AND unixepoch(s.updated_at) <= unixepoch(? || 'T' || s.${timeColumn} || ':00', '-9 hours')
      AND NOT EXISTS (
        SELECT 1 FROM deliveries d
        WHERE d.subscription_id = s.id AND d.meal_date = ? AND d.meal_type = ?
      )
    LIMIT ?`).bind(local.time, isWeekendDate(local.date) ? 1 : 0,
      local.date, local.date, mealKey, MAX_DUE_PER_MEAL).all();
  const ids = result.results.map(row => row.id);
  if (!ids.length) return 0;

  const now = new Date().toISOString();
  const claims = await env.DB.batch(ids.map(id => env.DB.prepare(
    "INSERT OR IGNORE INTO deliveries (subscription_id, meal_date, meal_type, status, queued_at) VALUES (?, ?, ?, 'queued', ?)"
  ).bind(id, local.date, mealKey, now)));
  const claimed = ids.filter((_, index) => Number(claims[index]?.meta?.changes) > 0);

  for (const group of chunks(claimed, QUEUE_BATCH_SIZE)) {
    try {
      await env.PUSH_QUEUE.sendBatch(group.map(subscriptionId => ({
        body: { subscriptionId, date: local.date, mealKey }
      })));
    } catch (error) {
      await env.DB.batch(group.map(subscriptionId => env.DB.prepare(
        "DELETE FROM deliveries WHERE subscription_id = ? AND meal_date = ? AND meal_type = ? AND status = 'queued'"
      ).bind(subscriptionId, local.date, mealKey)));
      throw error;
    }
  }
  return claimed.length;
}

async function enqueueDueNotifications(env, date = new Date()) {
  const local = localDateTime(date);
  const counts = {};
  for (const mealKey of Object.keys(MEALS)) counts[mealKey] = await enqueueDueMeal(env, local, mealKey);
  console.log(JSON.stringify({ event: "notifications_enqueued", date: local.date, counts }));
}

async function deliverMessage(env, meals, value) {
  const { subscriptionId, date, mealKey } = value || {};
  if (!subscriptionId || !Object.hasOwn(MEALS, mealKey) || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return;
  const row = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(subscriptionId).first();
  if (!row) return;
  const meal = mealForDate(meals, date);
  try {
    await sendPush(env, row, mealNotification(meal, date, mealKey, row.restaurant));
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE deliveries SET status = 'sent', sent_at = ?
        WHERE subscription_id = ? AND meal_date = ? AND meal_type = ?`)
        .bind(now, subscriptionId, date, mealKey),
      env.DB.prepare("UPDATE subscriptions SET last_success_at = ? WHERE id = ?").bind(now, subscriptionId)
    ]);
  } catch (error) {
    if (error?.statusCode === 404 || error?.statusCode === 410) {
      await removeDeadSubscription(env, subscriptionId);
      return;
    }
    throw error;
  }
}

async function consumeQueue(batch, env) {
  const meals = await getMeals(env);
  for (const group of chunks(batch.messages, OUTGOING_CONCURRENCY)) {
    await Promise.all(group.map(async message => {
      try {
        await deliverMessage(env, meals, message.body);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: "push_failed", messageId: message.id, error: String(error?.message || error) }));
        message.retry({ delaySeconds: 60 });
      }
    }));
  }
}

export class MealPublisher extends WorkerEntrypoint {
  async publishMeals(value) {
    return saveMeal(this.env, value);
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/") || url.pathname === "/health") return await api(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(enqueueDueNotifications(env).catch(error => {
      console.error(JSON.stringify({ event: "scheduler_failed", error: String(error?.message || error) }));
    }));
  },
  async queue(batch, env) {
    await consumeQueue(batch, env);
  }
};
