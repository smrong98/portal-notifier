import test from "node:test";
import assert from "node:assert/strict";
import {
  localDateTime,
  mealNotification,
  sanitizeMeal,
  sanitizeSettings
} from "../src/domain.js";

const sourceMeal = {
  pdfUrl: "https://internal.example/menu.pdf",
  parsedAt: "2026-08-10T00:00:00.000Z",
  weekStart: "2026-08-10",
  weekEnd: "2026-08-16",
  restaurants: [
    {
      restaurant: "DN오븐&키친 남산점",
      days: {
        "2026-08-10": {
          lunch: { corner1: ["비빔밥", "국", "김치"] },
          lateNight: { menu: ["공개하지 않을 메뉴"] }
        }
      }
    },
    { restaurant: "DN오븐&키친 성주점", days: {} }
  ]
};

test("공개 식단은 원본 URL과 파싱 메타데이터를 제거한다", () => {
  const result = sanitizeMeal(sourceMeal, new Date("2026-08-10T01:00:00Z"));
  assert.equal(result.pdfUrl, undefined);
  assert.equal(result.parsedAt, undefined);
  assert.equal(result.restaurants[0].key, "namsan");
  assert.equal(result.restaurants[0].days["2026-08-10"].lateNight, undefined);
  assert.equal(result.publishedAt, "2026-08-10T01:00:00.000Z");
});

test("사용자 설정은 두 지점과 올바른 시각만 허용한다", () => {
  const result = sanitizeSettings({
    restaurant: "unknown",
    mealNotifications: {
      breakfast: { enabled: false, time: "99:99" },
      lunch: { enabled: true, time: "12:05" }
    }
  });
  assert.equal(result.restaurant, "namsan");
  assert.deepEqual(result.mealNotifications.breakfast, { enabled: false, time: "07:30" });
  assert.deepEqual(result.mealNotifications.lunch, { enabled: true, time: "12:05" });
});

test("서울 현지 날짜와 시간을 예약 조회 형식으로 반환한다", () => {
  assert.deepEqual(localDateTime(new Date("2026-08-09T22:35:00Z")), {
    date: "2026-08-10",
    time: "07:35"
  });
});

test("알림에는 선택 지점의 메뉴 두 개와 생략 표시를 넣는다", () => {
  const result = sanitizeMeal(sourceMeal);
  assert.deepEqual(mealNotification(result, "2026-08-10", "lunch", "namsan"), {
    title: "오늘의 중식",
    body: "corner1: 비빔밥, 국, ...",
    tag: "meal-namsan-lunch-2026-08-10",
    data: { url: "/?date=2026-08-10" }
  });
});
