import webpush from "web-push";
import { BOARDS } from "./boards.js";

const SETTINGS_KEY = "settings";
const STATE_KEY = "monitor_state";
const SUBSCRIPTIONS_KEY = "push_subscriptions";

const DEFAULT_SETTINGS = {
  intervalMinutes: 5,
  quietEnabled: false,
  quietStart: "22:00",
  quietEnd: "07:00",
  timezone: "Asia/Seoul",
  enabledBoards: BOARDS.map((b) => b.key)
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;

  if (!origin) return {};

  if (
    origin === allowed ||
    origin === "http://localhost:8000" ||
    origin === "http://127.0.0.1:8000" ||
    origin === "http://localhost:5500" ||
    origin === "http://127.0.0.1:5500"
  ) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type, X-Client-Key",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
  }

  return {};
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function isAuthorized(request, env) {
  const provided = request.headers.get("X-Client-Key") || "";
  return provided && provided === env.CLIENT_KEY;
}

async function getSettings(env) {
  const saved = await env.PORTAL_KV.get(SETTINGS_KEY, "json");
  return {
    ...DEFAULT_SETTINGS,
    ...(saved || {})
  };
}

async function putSettings(env, incoming) {
  const interval = Number(incoming.intervalMinutes);
  const allowedIntervals = [5, 10, 15, 30, 60];

  const enabledBoards = Array.isArray(incoming.enabledBoards)
    ? incoming.enabledBoards.filter((key) => BOARDS.some((b) => b.key === key))
    : DEFAULT_SETTINGS.enabledBoards;

  const settings = {
    intervalMinutes: allowedIntervals.includes(interval) ? interval : 5,
    quietEnabled: Boolean(incoming.quietEnabled),
    quietStart: /^\d{2}:\d{2}$/.test(incoming.quietStart || "")
      ? incoming.quietStart
      : "22:00",
    quietEnd: /^\d{2}:\d{2}$/.test(incoming.quietEnd || "")
      ? incoming.quietEnd
      : "07:00",
    timezone: incoming.timezone || "Asia/Seoul",
    enabledBoards
  };

  await env.PORTAL_KV.put(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

async function getState(env) {
  return (
    (await env.PORTAL_KV.get(STATE_KEY, "json")) || {
      initialized: false,
      lastCheckAt: null,
      lastSuccessAt: null,
      lastError: null,
      seenByBoard: {},
      recent: [],
      pending: []
    }
  );
}

async function saveState(env, state) {
  await env.PORTAL_KV.put(STATE_KEY, JSON.stringify(state));
}

function parseCookieHeaders(headers) {
  let setCookies = [];

  if (typeof headers.getSetCookie === "function") {
    setCookies = headers.getSetCookie();
  } else {
    const combined = headers.get("set-cookie");
    if (combined) {
      // Expires=... 안의 쉼표를 최대한 피해서 나누는 fallback
      setCookies = combined.split(/,(?=\s*[^;,]+=)/);
    }
  }

  return setCookies;
}

function absorbCookies(jar, headers) {
  for (const raw of parseCookieHeaders(headers)) {
    const first = raw.split(";")[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function loginToPortal(env) {
  const jar = new Map();

  const form = new URLSearchParams({
    username: env.PORTAL_USERNAME,
    password: env.PORTAL_PASSWORD,
    remember_me: "Y"
  });

  let response = await fetch(env.PORTAL_LOGIN_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
    },
    body: form.toString()
  });

  absorbCookies(jar, response.headers);

  // 로그인 성공 후 302 redirect 체인을 직접 따라가며 쿠키를 수집
  for (let i = 0; i < 5; i++) {
    if (![301, 302, 303, 307, 308].includes(response.status)) break;

    const location = response.headers.get("location");
    if (!location) break;

    const nextUrl = new URL(location, env.PORTAL_BASE_URL).toString();
    response = await fetch(nextUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "Cookie": cookieHeader(jar),
        "accept": "text/html,application/xhtml+xml,*/*"
      }
    });
    absorbCookies(jar, response.headers);
  }

  if (jar.size === 0) {
    throw new Error("로그인 후 세션 쿠키를 얻지 못했습니다.");
  }

  return jar;
}

async function fetchBoard(env, jar, board) {
  const url = new URL(env.PORTAL_BOARD_API_URL);
  url.searchParams.set("boardmst_id", board.boardmstId);
  url.searchParams.set("pageSize", String(board.pageSize ?? 10));
  url.searchParams.set("view_body", board.viewBody ?? "N");
  url.searchParams.set("board_type", board.boardType ?? "");
  url.searchParams.set("_", String(Date.now()));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Cookie": cookieHeader(jar),
      "accept": "application/json, text/javascript, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
      "referer": env.PORTAL_BASE_URL + "/"
    }
  });

  if (!response.ok) {
    throw new Error(`${board.name} 조회 실패: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `${board.name} 응답이 JSON이 아닙니다. 세션 만료/로그인 실패 가능성. content-type=${contentType}`
    );
  }

  if (!Array.isArray(data.result)) {
    throw new Error(`${board.name} 응답에 result 배열이 없습니다.`);
  }

  return data.result;
}

function normalizePost(board, post) {
  return {
    boardKey: board.key,
    boardName: board.name,
    id: String(post.board_id ?? `${board.key}:${post.board_seq ?? post.board_num}`),
    title: String(post._title ?? post.title ?? "(제목 없음)").trim(),
    regDt: post.reg_dt ?? null,
    boardSeq: post.board_seq ?? null,
    boardNum: post.board_num ?? null,
    detectedAt: new Date().toISOString()
  };
}

function minuteOfDay(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function localMinuteNow(timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone || "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return hour * 60 + minute;
}

function inQuietHours(settings) {
  if (!settings.quietEnabled) return false;

  const now = localMinuteNow(settings.timezone);
  const start = minuteOfDay(settings.quietStart);
  const end = minuteOfDay(settings.quietEnd);

  if (start === end) return true;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end; // 자정을 넘기는 경우
}

async function getSubscriptions(env) {
  return (await env.PORTAL_KV.get(SUBSCRIPTIONS_KEY, "json")) || [];
}

async function saveSubscriptions(env, subscriptions) {
  await env.PORTAL_KV.put(
    SUBSCRIPTIONS_KEY,
    JSON.stringify(subscriptions.slice(-10))
  );
}

function configureWebPush(env) {
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
}

async function sendPush(env, payload) {
  configureWebPush(env);

  const subscriptions = await getSubscriptions(env);
  if (subscriptions.length === 0) {
    return { sent: 0, removed: 0 };
  }

  const dead = new Set();
  let sent = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
        sent++;
      } catch (err) {
        const statusCode =
          err instanceof webpush.WebPushError ? err.statusCode : err?.statusCode;

        if (statusCode === 404 || statusCode === 410) {
          dead.add(sub.endpoint);
        } else {
          console.error("push error", statusCode, err?.message || err);
        }
      }
    })
  );

  if (dead.size) {
    await saveSubscriptions(
      env,
      subscriptions.filter((s) => !dead.has(s.endpoint))
    );
  }

  return { sent, removed: dead.size };
}

async function notifyPosts(env, posts) {
  if (!posts.length) return;

  if (posts.length <= 3) {
    for (const post of posts) {
      await sendPush(env, {
        title: `[${post.boardName}] 새 게시글`,
        body: post.title,
        tag: `portal-${post.id}`,
        data: {
          url: env.APP_URL
        }
      });
    }
    return;
  }

  await sendPush(env, {
    title: `새 게시글 ${posts.length}개`,
    body: posts
      .slice(0, 3)
      .map((p) => p.title)
      .join(" · "),
    tag: "portal-summary",
    data: {
      url: env.APP_URL
    }
  });
}

function dueForCheck(settings, state, force = false) {
  if (force || !state.lastCheckAt) return true;

  const elapsed = Date.now() - new Date(state.lastCheckAt).getTime();
  return elapsed >= settings.intervalMinutes * 60_000 - 15_000;
}

async function monitor(env, { force = false } = {}) {
  const settings = await getSettings(env);
  const state = await getState(env);

  if (!dueForCheck(settings, state, force)) {
    return {
      ok: true,
      skipped: true,
      reason: "interval",
      lastCheckAt: state.lastCheckAt
    };
  }

  state.lastCheckAt = new Date().toISOString();

  try {
    const jar = await loginToPortal(env);
    const enabled = BOARDS.filter((b) =>
      settings.enabledBoards.includes(b.key)
    );

    const detected = [];

    for (const board of enabled) {
      const rawPosts = await fetchBoard(env, jar, board);
      const posts = rawPosts.map((p) => normalizePost(board, p));

      const priorSeen = new Set(state.seenByBoard[board.key] || []);

      if (state.initialized) {
        // API는 최신순이므로 알림은 오래된 새 글부터
        for (const post of [...posts].reverse()) {
          if (!priorSeen.has(post.id)) detected.push(post);
        }
      }

      // 최신 목록 + 이전 목록 일부를 합쳐 누락/중복 방지
      state.seenByBoard[board.key] = [
        ...new Set([
          ...posts.map((p) => p.id),
          ...(state.seenByBoard[board.key] || [])
        ])
      ].slice(0, 100);
    }

    // 최초 실행은 현재 게시물을 baseline으로만 저장
    if (!state.initialized) {
      state.initialized = true;
    } else if (detected.length) {
      state.recent = [...detected.reverse(), ...(state.recent || [])].slice(0, 50);

      if (inQuietHours(settings)) {
        state.pending = [...(state.pending || []), ...detected].slice(-50);
      } else {
        const toSend = [...(state.pending || []), ...detected];
        state.pending = [];
        await notifyPosts(env, toSend);
      }
    } else if (!inQuietHours(settings) && (state.pending || []).length) {
      const pending = [...state.pending];
      state.pending = [];
      await notifyPosts(env, pending);
    }

    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    await saveState(env, state);

    return {
      ok: true,
      skipped: false,
      newPosts: detected.length,
      pending: state.pending.length,
      lastSuccessAt: state.lastSuccessAt
    };
  } catch (err) {
    state.lastError = String(err?.message || err);
    await saveState(env, state);
    console.error("monitor failed:", err);
    throw err;
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/health") {
    return json({ ok: true, service: "portal-notifier" });
  }

  if (!url.pathname.startsWith("/api/")) {
    return json({ error: "Not found" }, 404);
  }

  if (!isAuthorized(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (url.pathname === "/api/vapid-public-key" && request.method === "GET") {
    return json({ publicKey: env.VAPID_PUBLIC_KEY });
  }

  if (url.pathname === "/api/config" && request.method === "GET") {
    return json({
      settings: await getSettings(env),
      boards: BOARDS.map(({ key, name }) => ({ key, name }))
    });
  }

  if (url.pathname === "/api/settings" && request.method === "PUT") {
    const body = await request.json();
    const settings = await putSettings(env, body);
    return json({ ok: true, settings });
  }

  if (url.pathname === "/api/status" && request.method === "GET") {
    const state = await getState(env);
    return json({
      ok: !state.lastError,
      initialized: state.initialized,
      lastCheckAt: state.lastCheckAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      pendingCount: state.pending?.length || 0,
      recent: state.recent || []
    });
  }

  if (url.pathname === "/api/check" && request.method === "POST") {
    try {
      const result = await monitor(env, { force: true });
      return json(result);
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  }

  if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
    const subscription = await request.json();

    if (
      !subscription?.endpoint ||
      !subscription?.keys?.p256dh ||
      !subscription?.keys?.auth
    ) {
      return json({ error: "Invalid push subscription" }, 400);
    }

    const subscriptions = await getSubscriptions(env);
    const withoutSame = subscriptions.filter(
      (s) => s.endpoint !== subscription.endpoint
    );
    withoutSame.push(subscription);
    await saveSubscriptions(env, withoutSame);

    return json({ ok: true });
  }

  if (url.pathname === "/api/push/test" && request.method === "POST") {
    const result = await sendPush(env, {
      title: "Portal Notifier",
      body: "테스트 알림이 정상적으로 도착했습니다.",
      tag: "portal-test",
      data: { url: env.APP_URL }
    });

    return json({ ok: true, ...result });
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const response = await handleApi(request, env);
      return withCors(response, request, env);
    } catch (err) {
      console.error(err);
      return withCors(
        json({ error: String(err?.message || err) }, 500),
        request,
        env
      );
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      monitor(env).catch((err) => console.error("scheduled monitor error:", err))
    );
  }
};
