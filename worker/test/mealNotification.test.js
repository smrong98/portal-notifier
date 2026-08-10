import test from "node:test";
import assert from "node:assert/strict";
import {
  formatMealNotification,
  isMealRefreshCron,
  localDateTime,
  mealForDate
} from "../src/index.js";

test("서울 시간대의 날짜와 시간을 알림 비교 형식으로 만든다", () => {
  assert.deepEqual(
    localDateTime("Asia/Seoul", new Date("2026-08-09T22:35:00Z")),
    { date: "2026-08-10", time: "07:35" }
  );
});

test("선택한 날짜와 식사의 식당별 메뉴만 반환한다", () => {
  const meal = { restaurants: [
    { restaurant: "DN솔루션즈 남산점", days: { "2026-08-10": { lunch: { corner1: ["비빔밥", "국", "김치"] } } } },
    { restaurant: "DN솔루션즈 성주점", days: { "2026-08-10": { lunch: { menu: ["성주메뉴", "국"] } } } }
  ] };

  assert.deepEqual(mealForDate(meal, "2026-08-10", "lunch", "namsan"), [
    { name: "DN솔루션즈 남산점", menu: ["corner1: 비빔밥, 국, ..."] }
  ]);
});

test("알림 본문은 지점명 없이 코너별로 줄바꿈한다", () => {
  assert.equal(formatMealNotification([
    { name: "DN솔루션즈 남산점", menu: ["corner1: 메뉴1, 메뉴2", "corner3: 메뉴3"] },
  ]), [
    "corner1: 메뉴1, 메뉴2",
    "corner3: 메뉴3"
  ].join("\n"));
});

test("식단 PDF는 토요일 전용 Cron에서만 갱신한다", () => {
  assert.equal(isMealRefreshCron("0 0 * * SAT"), true);
  assert.equal(isMealRefreshCron("*/5 * * * *"), false);
});
