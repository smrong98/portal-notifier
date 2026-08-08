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
  enabledBoards: BOARDS.map(b => b.key)
};

const nowIso = () => new Date().toISOString();

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"content-type":"application/json; charset=utf-8"}
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const allowed = [
    env.ALLOWED_ORIGIN,
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
  ];
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Key",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function withCors(response, request, env) {
  const h = new Headers(response.headers);
  for (const [k,v] of Object.entries(corsHeaders(request, env))) h.set(k,v);
  return new Response(response.body, {status: response.status, headers:h});
}

function authorized(req, env) {
  return (req.headers.get("X-Client-Key") || "") === env.CLIENT_KEY;
}

async function getSettings(env) {
  const s = await env.PORTAL_KV.get(SETTINGS_KEY, "json");
  return {...DEFAULT_SETTINGS, ...(s || {})};
}

async function saveSettings(env, incoming) {
  const allowedIntervals = [5,10,15,30,60];
  const enabledBoards = Array.isArray(incoming.enabledBoards)
    ? incoming.enabledBoards.filter(k => BOARDS.some(b => b.key === k))
    : DEFAULT_SETTINGS.enabledBoards;

  const out = {
    intervalMinutes: allowedIntervals.includes(Number(incoming.intervalMinutes))
      ? Number(incoming.intervalMinutes) : 5,
    quietEnabled: Boolean(incoming.quietEnabled),
    quietStart: /^\d{2}:\d{2}$/.test(incoming.quietStart || "") ? incoming.quietStart : "22:00",
    quietEnd: /^\d{2}:\d{2}$/.test(incoming.quietEnd || "") ? incoming.quietEnd : "07:00",
    timezone: incoming.timezone || "Asia/Seoul",
    enabledBoards
  };
  await env.PORTAL_KV.put(SETTINGS_KEY, JSON.stringify(out));
  return out;
}

async function getState(env) {
  return (await env.PORTAL_KV.get(STATE_KEY, "json")) || {
    initialized:false,
    lastCheckAt:null,
    lastSuccessAt:null,
    lastError:null,
    seenByBoard:{},
    latestByBoard:{},
    recent:[],
    pending:[]
  };
}

const saveState = (env, state) =>
  env.PORTAL_KV.put(STATE_KEY, JSON.stringify(state));

function parseSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const v = headers.get("set-cookie");
  return v ? v.split(/,(?=\s*[^;,]+=)/) : [];
}
function absorbCookies(jar, headers) {
  for (const raw of parseSetCookies(headers)) {
    const first = raw.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0,eq).trim(), first.slice(eq+1).trim());
  }
}
function cookieHeader(jar) {
  return [...jar.entries()].map(([k,v]) => `${k}=${v}`).join("; ");
}

async function login(env) {
  const jar = new Map();
  const body = new URLSearchParams({
    username: env.PORTAL_USERNAME,
    password: env.PORTAL_PASSWORD,
    remember_me: "Y"
  });

  let res = await fetch(env.PORTAL_LOGIN_URL, {
    method:"POST",
    redirect:"manual",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body: body.toString()
  });
  absorbCookies(jar, res.headers);

  for (let i=0;i<5 && [301,302,303,307,308].includes(res.status);i++) {
    const loc = res.headers.get("location");
    if (!loc) break;
    res = await fetch(new URL(loc, env.PORTAL_BASE_URL).toString(), {
      redirect:"manual",
      headers:{"Cookie":cookieHeader(jar)}
    });
    absorbCookies(jar, res.headers);
  }

  if (!jar.size) throw new Error("포탈 로그인 후 세션 쿠키를 얻지 못했습니다.");
  return jar;
}

async function fetchBoard(env, jar, board) {
  const u = new URL(env.PORTAL_BOARD_API_URL);
  u.searchParams.set("boardmst_id", board.boardmstId);
  u.searchParams.set("pageSize", String(board.pageSize || 10));
  u.searchParams.set("view_body", board.viewBody || "N");
  u.searchParams.set("board_type", board.boardType || "");
  u.searchParams.set("_", String(Date.now()));

  const res = await fetch(u, {
    headers:{
      "Cookie": cookieHeader(jar),
      "accept":"application/json, text/javascript, */*; q=0.01",
      "x-requested-with":"XMLHttpRequest",
      "referer": env.PORTAL_BASE_URL + "/"
    }
  });

  if (!res.ok) throw new Error(`${board.name}: HTTP ${res.status}`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`${board.name}: JSON 응답이 아닙니다.`); }
  if (!Array.isArray(data.result)) throw new Error(`${board.name}: result 배열 없음`);
  return data.result;
}

function buildPostUrl(env, boardId) {
  const u = new URL("/board/boardview.do", env.PORTAL_BASE_URL);
  u.searchParams.set("board_id", boardId);
  u.searchParams.set("page_no", "0");
  return u.toString();
}

function normalize(env, board, p) {
  const id = String(p.board_id ?? `${board.key}:${p.board_seq ?? p.board_num}`);
  return {
    boardKey: board.key,
    boardName: board.name,
    boardmstId: board.boardmstId,
    id,
    title: String(p._title ?? p.title ?? "(제목 없음)").trim(),
    regDt: p.reg_dt ?? null,
    boardSeq: p.board_seq ?? null,
    boardNum: p.board_num ?? null,
    url: p.board_id ? buildPostUrl(env, p.board_id) : null,
    detectedAt: nowIso()
  };
}

function minuteOfDay(s) {
  const [h,m] = s.split(":").map(Number);
  return h*60+m;
}
function localMinute(tz) {
  const parts = new Intl.DateTimeFormat("en-GB",{
    timeZone:tz,hour:"2-digit",minute:"2-digit",hourCycle:"h23"
  }).formatToParts(new Date());
  return Number(parts.find(x=>x.type==="hour").value)*60
       + Number(parts.find(x=>x.type==="minute").value);
}
function inQuiet(s) {
  if (!s.quietEnabled) return false;
  const n=localMinute(s.timezone), a=minuteOfDay(s.quietStart), b=minuteOfDay(s.quietEnd);
  if (a===b) return true;
  return a<b ? n>=a && n<b : n>=a || n<b;
}

async function subscriptions(env) {
  return (await env.PORTAL_KV.get(SUBSCRIPTIONS_KEY,"json")) || [];
}
async function putSubscriptions(env, subs) {
  await env.PORTAL_KV.put(SUBSCRIPTIONS_KEY, JSON.stringify(subs.slice(-10)));
}
function configurePush(env) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}
async function push(env, payload) {
  configurePush(env);
  const subs = await subscriptions(env);
  const dead = new Set();
  let sent=0;

  await Promise.all(subs.map(async s=>{
    try {
      await webpush.sendNotification(s, JSON.stringify(payload));
      sent++;
    } catch(e) {
      const code = e?.statusCode;
      if (code===404 || code===410) dead.add(s.endpoint);
      else console.error("push", code, e?.message || e);
    }
  }));

  if (dead.size) await putSubscriptions(env, subs.filter(s=>!dead.has(s.endpoint)));
  return {sent};
}

async function notify(env, posts) {
  if (!posts.length) return;

  if (posts.length <= 3) {
    for (const p of posts) {
      await push(env,{
        title:`[${p.boardName}] 새 게시글`,
        body:p.title,
        tag:`portal-${p.id}`,
        data:{url:p.url || env.APP_URL}
      });
    }
  } else {
    await push(env,{
      title:`새 게시글 ${posts.length}개`,
      body:posts.slice(0,3).map(p=>`• ${p.title}`).join("\n"),
      tag:"portal-summary",
      data:{url:env.APP_URL}
    });
  }
}

function latestForEnabledBoards(settings, state, limit = 5) {
  const enabled = new Set(settings.enabledBoards || []);
  return Object.values(state.latestByBoard || {})
    .flat()
    .filter(p => enabled.has(p.boardKey))
    .sort((a,b) => new Date(b.regDt || 0) - new Date(a.regDt || 0))
    .slice(0, limit);
}

async function sendLatestTestPush(env) {
  const settings = await getSettings(env);
  const state = await getState(env);

  let latest = latestForEnabledBoards(settings, state, 5);

  // 아직 latest 캐시가 없다면 즉시 한 번 조회해서 채운다.
  if (!latest.length) {
    await monitor(env, { force: true });
    const refreshed = await getState(env);
    latest = latestForEnabledBoards(settings, refreshed, 5);
  }

  if (!latest.length) {
    return push(env, {
      title: "Portal Notifier",
      body: "알림 대상으로 설정된 게시판에서 표시할 최신 게시글이 없습니다.",
      tag: "portal-test-empty",
      data: { url: env.APP_URL }
    });
  }

  const body = latest
    .map((p, i) => `${i + 1}. [${p.boardName}] ${p.title}`)
    .join("\n");

  return push(env, {
    title: `최신 게시글 ${latest.length}개`,
    body,
    tag: "portal-latest-test",
    data: { url: env.APP_URL }
  });
}

function due(settings,state,force=false) {
  if (force || !state.lastCheckAt) return true;
  return Date.now()-new Date(state.lastCheckAt).getTime()
    >= settings.intervalMinutes*60000-15000;
}

async function monitor(env,{force=false}={}) {
  const settings = await getSettings(env);
  const state = await getState(env);
  state.latestByBoard ||= {};
  state.seenByBoard ||= {};
  state.pending ||= [];
  state.recent ||= [];

  if (!due(settings,state,force))
    return {ok:true,skipped:true,lastCheckAt:state.lastCheckAt};

  state.lastCheckAt = nowIso();

  try {
    const jar = await login(env);
    const enabled = BOARDS.filter(b=>settings.enabledBoards.includes(b.key));
    const detected = [];

    for (const board of enabled) {
      const posts = (await fetchBoard(env,jar,board)).map(p=>normalize(env,board,p));
      state.latestByBoard[board.key] = posts.slice(0,10);

      const seen = new Set(state.seenByBoard[board.key] || []);
      if (state.initialized) {
        for (const p of [...posts].reverse()) if (!seen.has(p.id)) detected.push(p);
      }

      state.seenByBoard[board.key] = [
        ...new Set([...posts.map(p=>p.id), ...(state.seenByBoard[board.key]||[])])
      ].slice(0,100);
    }

    if (!state.initialized) {
      state.initialized = true;
    } else if (detected.length) {
      state.recent = [...detected.reverse(), ...state.recent].slice(0,50);
      if (inQuiet(settings)) {
        state.pending = [...state.pending, ...detected].slice(-50);
      } else {
        const sending = [...state.pending, ...detected];
        state.pending = [];
        await notify(env,sending);
      }
    } else if (!inQuiet(settings) && state.pending.length) {
      const sending=[...state.pending];
      state.pending=[];
      await notify(env,sending);
    }

    state.lastSuccessAt=nowIso();
    state.lastError=null;
    await saveState(env,state);
    return {ok:true,newPosts:detected.length,lastSuccessAt:state.lastSuccessAt};
  } catch(e) {
    state.lastError=String(e?.message||e);
    await saveState(env,state);
    throw e;
  }
}

async function api(request,env) {
  const url=new URL(request.url);
  if (request.method==="OPTIONS") return new Response(null,{status:204});
  if (url.pathname==="/health") return json({ok:true,service:"portal-notifier-v2"});
  if (!url.pathname.startsWith("/api/")) return json({error:"Not found"},404);
  if (!authorized(request,env)) return json({error:"Unauthorized"},401);

  if (url.pathname==="/api/vapid-public-key" && request.method==="GET")
    return json({publicKey:env.VAPID_PUBLIC_KEY});

  if (url.pathname==="/api/config" && request.method==="GET")
    return json({
      settings:await getSettings(env),
      boards:BOARDS.map(({key,name})=>({key,name}))
    });

  if (url.pathname==="/api/settings" && request.method==="PUT")
    return json({ok:true,settings:await saveSettings(env,await request.json())});

  if (url.pathname==="/api/status" && request.method==="GET") {
    const s=await getState(env);
    return json({
      ok:!s.lastError,
      initialized:s.initialized,
      lastCheckAt:s.lastCheckAt,
      lastSuccessAt:s.lastSuccessAt,
      lastError:s.lastError,
      pendingCount:s.pending?.length||0,
      latestByBoard:s.latestByBoard||{},
      recent:s.recent||[]
    });
  }

  if (url.pathname==="/api/check" && request.method==="POST") {
    try { return json(await monitor(env,{force:true})); }
    catch(e) { return json({ok:false,error:String(e?.message||e)},500); }
  }

  if (url.pathname==="/api/push/subscribe" && request.method==="POST") {
    const sub=await request.json();
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth)
      return json({error:"Invalid subscription"},400);
    const subs=await subscriptions(env);
    await putSubscriptions(env,[...subs.filter(s=>s.endpoint!==sub.endpoint),sub]);
    return json({ok:true});
  }

  if (url.pathname==="/api/push/test" && request.method==="POST") {
    return json({ok:true,...await sendLatestTestPush(env)});
  }

  return json({error:"Not found"},404);
}

export default {
  async fetch(request,env) {
    try { return withCors(await api(request,env),request,env); }
    catch(e) { return withCors(json({error:String(e?.message||e)},500),request,env); }
  },
  async scheduled(_c,env,ctx) {
    ctx.waitUntil(monitor(env).catch(e=>console.error(e)));
  }
};
