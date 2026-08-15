import { cookieHeader, login } from "./portalSession.js";
import { extractMealPdf } from "./mealParser.js";

export const MEAL_CACHE_KEY = "meal_current";
export const MEAL_META_KEY = "meal_meta";
export const MEAL_INDEX_KEY = "meal_week_index";
const MEAL_WEEK_PREFIX = "meal_week:";
const MAX_STORED_WEEKS = 3;
const DEFAULT_REFRESH_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_DEBUG_ITEMS = 3000;
const PDF_SIGNATURE = "%PDF-";
const MEAL_BOARD_PAGE_SIZE = 5;

const mealWeekKey = weekStart => `${MEAL_WEEK_PREFIX}${weekStart}`;

async function mealIndex(env) {
  const index = await env.PORTAL_KV.get(MEAL_INDEX_KEY, "json");
  return Array.isArray(index) ? index : [];
}

export async function getMeals(env) {
  const index = await mealIndex(env);
  if (!index.length) {
    const legacy = await env.PORTAL_KV.get(MEAL_CACHE_KEY, "json");
    return legacy ? [legacy] : [];
  }
  const weeks = await Promise.all(index.map(entry => env.PORTAL_KV.get(mealWeekKey(entry.weekStart), "json")));
  return weeks.filter(Boolean).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export async function getMeal(env, date) {
  const weeks = await getMeals(env);
  if (!weeks.length) return null;
  if (date) {
    const matching = weeks.find(meal => meal.weekStart <= date && meal.weekEnd >= date);
    if (matching) return matching;
    const previous = weeks.findLast(meal => meal.weekStart <= date);
    if (previous) return previous;
    return weeks[0];
  }
  return weeks.at(-1);
}

export async function saveMealWeek(env, result) {
  const existingIndex = await mealIndex(env);
  const legacy = existingIndex.length ? null : await env.PORTAL_KV.get(MEAL_CACHE_KEY, "json");
  const entries = new Map(existingIndex.map(entry => [entry.weekStart, entry]));
  if (legacy?.weekStart && legacy.weekStart !== result.weekStart) {
    entries.set(legacy.weekStart, {
      weekStart: legacy.weekStart,
      weekEnd: legacy.weekEnd,
      pdfUrl: legacy.pdfUrl,
      storedAt: legacy.parsedAt
    });
    await env.PORTAL_KV.put(mealWeekKey(legacy.weekStart), JSON.stringify(legacy));
  }
  entries.set(result.weekStart, {
    weekStart: result.weekStart,
    weekEnd: result.weekEnd,
    pdfUrl: result.pdfUrl,
    storedAt: new Date().toISOString()
  });
  const sorted = [...entries.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const retained = sorted.slice(-MAX_STORED_WEEKS);
  const retainedStarts = new Set(retained.map(entry => entry.weekStart));
  const removed = sorted.filter(entry => !retainedStarts.has(entry.weekStart));
  await Promise.all([
    env.PORTAL_KV.put(mealWeekKey(result.weekStart), JSON.stringify(result)),
    env.PORTAL_KV.put(MEAL_CACHE_KEY, JSON.stringify(result)),
    env.PORTAL_KV.put(MEAL_INDEX_KEY, JSON.stringify(retained)),
    ...removed.map(entry => env.PORTAL_KV.delete(mealWeekKey(entry.weekStart)))
  ]);
  return retained;
}

async function saveError(env, error) {
  const previous = await env.PORTAL_KV.get(MEAL_META_KEY, "json") || {};
  await env.PORTAL_KV.put(MEAL_META_KEY, JSON.stringify({
    ...previous,
    lastAttemptAt: new Date().toISOString(),
    lastError: String(error?.message || error)
  }));
}

async function pdfResponseData(response) {
  if (!response.ok) throw new Error(`식단 PDF 다운로드 실패: HTTP ${response.status}`);

  const data = await response.arrayBuffer();
  const signature = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(PDF_SIGNATURE.length, data.byteLength)));
  if (signature !== PDF_SIGNATURE) {
    const contentType = response.headers.get("content-type") || "unknown";
    throw new Error(`식단 PDF가 아닌 응답입니다: ${contentType}`);
  }
  return data;
}

function portalJsonHeaders(env, jar) {
  return {
    Cookie: cookieHeader(jar),
    accept: "application/json, text/javascript, */*; q=0.01",
    "x-requested-with": "XMLHttpRequest",
    referer: `${env.PORTAL_BASE_URL}/`
  };
}

async function responseJson(response, label) {
  if (!response.ok) throw new Error(`${label} 실패: HTTP ${response.status}`);
  try { return await response.json(); }
  catch { throw new Error(`${label} 응답이 JSON이 아닙니다.`); }
}

export async function discoverLatestMealPdf(env) {
  if (!env.MEAL_BOARDMST_ID) throw new Error("MEAL_BOARDMST_ID 설정이 필요합니다.");
  const jar = await login(env);
  const headers = portalJsonHeaders(env, jar);
  const boardUrl = new URL(env.PORTAL_BOARD_API_URL);
  boardUrl.searchParams.set("boardmst_id", env.MEAL_BOARDMST_ID);
  boardUrl.searchParams.set("pageSize", String(MEAL_BOARD_PAGE_SIZE));
  boardUrl.searchParams.set("view_body", "N");
  boardUrl.searchParams.set("board_type", "");
  boardUrl.searchParams.set("_", String(Date.now()));

  const boardData = await responseJson(await fetch(boardUrl, { headers }), "식단 게시판 조회");
  const posts = Array.isArray(boardData?.result)
    ? boardData.result.filter(post => post?.board_id && post.attach_file_yn === "Y")
    : [];
  if (!posts.length) throw new Error("식단 게시판에서 첨부파일이 있는 글을 찾지 못했습니다.");

  for (const post of posts) {
    const fileUrl = new URL("/board/selectBoardFileList.do", env.PORTAL_BASE_URL);
    fileUrl.searchParams.set("board_id", post.board_id);
    const files = await responseJson(await fetch(fileUrl, { headers }), "식단 첨부파일 조회");
    const pdf = Array.isArray(files) && files.find(file =>
      file?.use_yn !== "N" && (String(file?.file_ext || "").toLowerCase() === "pdf"
        || /\.pdf(?:$|[?#])/i.test(String(file?.file_url || "")))
    );
    if (pdf?.file_url) return new URL(pdf.file_url, env.PORTAL_BASE_URL).toString();
  }
  throw new Error("최신 식단 게시글에서 PDF 첨부파일을 찾지 못했습니다.");
}

export async function downloadMealPdf(env, pdfUrl) {
  const headers = {
    accept: "application/pdf, application/octet-stream;q=0.9, */*;q=0.1",
    referer: `${env.PORTAL_BASE_URL}/`
  };

  // /privatefiles/public 경로는 로그인 없이 제공된다. 먼저 공개 링크를 직접
  // 요청하고, 포탈이 인증을 요구하는 환경에서만 세션을 생성해 다시 시도한다.
  let response = await fetch(pdfUrl, { headers });
  if (response.status === 401 || response.status === 403) {
    const jar = await login(env);
    response = await fetch(pdfUrl, {
      headers: { ...headers, Cookie: cookieHeader(jar) }
    });
  }
  return pdfResponseData(response);
}

export async function refreshMeal(env, {
  pdfUrl,
  force = false,
  debug = false,
  maxAgeMs = DEFAULT_REFRESH_AGE_MS
} = {}) {
  const previous = await env.PORTAL_KV.get(MEAL_META_KEY, "json") || {};
  pdfUrl ||= await discoverLatestMealPdf(env);
  const requestedUrl = new URL(pdfUrl);
  if (requestedUrl.protocol !== "https:" || requestedUrl.origin !== new URL(env.PORTAL_BASE_URL).origin) {
    throw new Error("식단 PDF URL은 포탈의 HTTPS URL이어야 합니다.");
  }
  const lastAttempt = Date.parse(previous.lastAttemptAt || "");
  if (!force && previous.pdfUrl === pdfUrl && Number.isFinite(lastAttempt)
    && Date.now() - lastAttempt < maxAgeMs) {
    const cached = await getMeal(env, previous.weekStart);
    if (cached) return { cached: true, result: cached };
  }

  try {
    const { result } = await extractMealPdf(await downloadMealPdf(env, pdfUrl), {
      pdfUrl,
      onTextItems: debug ? pages => {
        console.log("meal PDF text items", JSON.stringify(pages.flatMap(page =>
          page.items.map(({ str, x, y }) => ({ str, x, y, pageNumber: page.pageNumber }))).slice(0, MAX_DEBUG_ITEMS)));
      } : undefined
    });
    const meta = {
      pdfUrl,
      weekStart: result.weekStart,
      weekEnd: result.weekEnd,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      lastError: null
    };
    await Promise.all([
      saveMealWeek(env, result),
      env.PORTAL_KV.put(MEAL_META_KEY, JSON.stringify(meta))
    ]);
    return { cached: false, result };
  } catch (error) {
    await saveError(env, error);
    throw error;
  }
}
