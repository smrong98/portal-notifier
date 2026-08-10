import test from "node:test";
import assert from "node:assert/strict";
import { downloadMealPdf } from "../src/mealPdf.js";

const env = { PORTAL_BASE_URL: "https://dnsep.dncompany.com" };

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
