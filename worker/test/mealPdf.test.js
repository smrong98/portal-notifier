import test from "node:test";
import assert from "node:assert/strict";
import { downloadMealPdf, getMeal, getMeals, saveMealWeek } from "../src/mealPdf.js";

const env = { PORTAL_BASE_URL: "https://dnsep.dncompany.com" };

class MemoryKV {
  data = new Map();
  async get(key, type) {
    const value = this.data.get(key);
    return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.data.set(key, value); }
  async delete(key) { this.data.delete(key); }
}

const meal = weekStart => ({
  weekStart,
  weekEnd: new Date(`${weekStart}T00:00:00Z`).toISOString().slice(0, 10),
  pdfUrl: `https://dnsep.dncompany.com/${weekStart}.pdf`,
  restaurants: []
});

test("공개 식단 링크를 로그인 없이 직접 다운로드한다", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response("%PDF-test", {
      headers: { "content-type": "application/octet-stream" }
    });
  };

  const url = "https://dnsep.dncompany.com/privatefiles/public/CN99999/board/menu.pdf";
  const data = await downloadMealPdf(env, url);

  assert.equal(new TextDecoder().decode(data), "%PDF-test");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, url);
  assert.equal(requests[0].options.headers.Cookie, undefined);
  assert.match(requests[0].options.headers.accept, /application\/octet-stream/);
});

test("Content-Type 대신 PDF 파일 시그니처를 검증한다", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("로그인 페이지", {
    headers: { "content-type": "text/html" }
  });

  await assert.rejects(
    downloadMealPdf(env, "https://dnsep.dncompany.com/privatefiles/public/menu.pdf"),
    /식단 PDF가 아닌 응답입니다: text\/html/
  );
});

test("주차별 식단은 최근 3주를 보관하고 날짜에 맞는 주차를 반환한다", async () => {
  const archiveEnv = { PORTAL_KV: new MemoryKV() };
  const weeks = ["2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17"];
  for (const weekStart of weeks) {
    const value = meal(weekStart);
    value.weekEnd = new Date(Date.parse(`${weekStart}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
    await saveMealWeek(archiveEnv, value);
  }

  assert.deepEqual((await getMeals(archiveEnv)).map(value => value.weekStart), weeks.slice(1));
  assert.equal((await getMeal(archiveEnv, "2026-08-12")).weekStart, "2026-08-10");
  assert.equal(await archiveEnv.PORTAL_KV.get("meal_week:2026-07-27", "json"), null);
});

test("토요일에 다음 주 식단이 저장돼 있어도 지난 주 식단을 반환한다", async () => {
  const archiveEnv = { PORTAL_KV: new MemoryKV() };
  await saveMealWeek(archiveEnv, {
    ...meal("2026-08-10"),
    weekEnd: "2026-08-14"
  });
  await saveMealWeek(archiveEnv, {
    ...meal("2026-08-17"),
    weekEnd: "2026-08-21"
  });

  assert.equal((await getMeal(archiveEnv, "2026-08-15")).weekStart, "2026-08-10");
  assert.equal((await getMeal(archiveEnv, "2026-08-16")).weekStart, "2026-08-10");
});
