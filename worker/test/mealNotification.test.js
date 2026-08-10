import test from "node:test";
import assert from "node:assert/strict";
import { localDateTime, mealForDate } from "../src/index.js";

test("서울 시간대의 날짜와 시간을 알림 비교 형식으로 만든다", () => {
  assert.deepEqual(
    localDateTime("Asia/Seoul", new Date("2026-08-09T22:35:00Z")),
    { date: "2026-08-10", time: "07:35" }
  );
});

test("선택한 날짜와 식사의 식당별 메뉴만 반환한다", () => {
  const meal = { restaurants: [
    { restaurant: "남산점", days: { "2026-08-10": { lunch: { corner1: ["비빔밥", "국"] } } } },
    { restaurant: "성주점", days: { "2026-08-10": { breakfast: { menu: ["토스트"] } } } }
  ] };

  assert.deepEqual(mealForDate(meal, "2026-08-10", "lunch"), [
    { name: "남산점", menu: ["corner1: 비빔밥, 국"] }
  ]);
});
