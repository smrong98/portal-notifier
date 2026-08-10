import { cookieHeader, login } from "./portalSession.js";
import { extractMealPdf } from "./mealParser.js";

export const MEAL_CACHE_KEY = "meal_current";
export const MEAL_META_KEY = "meal_meta";
const MAX_DEBUG_ITEMS = 3000;
const PDF_SIGNATURE = "%PDF-";

export async function getMeal(env) {
  return env.PORTAL_KV.get(MEAL_CACHE_KEY, "json");
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

export async function refreshMeal(env, { pdfUrl = env.MEAL_PDF_URL, force = false, debug = false } = {}) {
  if (!pdfUrl) throw new Error("MEAL_PDF_URL 또는 요청 본문의 pdfUrl이 필요합니다.");
  const requestedUrl = new URL(pdfUrl);
  if (requestedUrl.protocol !== "https:" || requestedUrl.origin !== new URL(env.PORTAL_BASE_URL).origin) {
    throw new Error("식단 PDF URL은 포탈의 HTTPS URL이어야 합니다.");
  }
  const previous = await env.PORTAL_KV.get(MEAL_META_KEY, "json") || {};
  if (!force && previous.pdfUrl === pdfUrl && previous.lastSuccessAt) {
    const cached = await getMeal(env);
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
    const meta = { pdfUrl, lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastError: null };
    await Promise.all([
      env.PORTAL_KV.put(MEAL_CACHE_KEY, JSON.stringify(result)),
      env.PORTAL_KV.put(MEAL_META_KEY, JSON.stringify(meta))
    ]);
    return { cached: false, result };
  } catch (error) {
    await saveError(env, error);
    throw error;
  }
}
