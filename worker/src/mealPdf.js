import { cookieHeader, login } from "./portalSession.js";
import { extractMealPdf } from "./mealParser.js";

export const MEAL_CACHE_KEY = "meal_current";
export const MEAL_META_KEY = "meal_meta";
const MAX_DEBUG_ITEMS = 3000;

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
    const jar = await login(env);
    const response = await fetch(pdfUrl, {
      headers: { Cookie: cookieHeader(jar), accept: "application/pdf" }
    });
    if (!response.ok) throw new Error(`식단 PDF 다운로드 실패: HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("pdf")) throw new Error(`식단 PDF가 아닌 응답입니다: ${contentType || "unknown"}`);

    const { result } = await extractMealPdf(await response.arrayBuffer(), {
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
