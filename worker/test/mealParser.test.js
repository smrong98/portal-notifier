import test from "node:test";
import assert from "node:assert/strict";
import { structureMealText } from "../src/mealParser.js";

const item = (str, x, y) => ({ str, x, y, width: 20, height: 10 });

test("좌표 기반으로 날짜, 식사, 코너의 가변 메뉴를 구조화한다", () => {
  const pages = [{ pageNumber: 1, items: [
    item("DN SOLUTIONS", 40, 790), item("아워홈 DN솔루션즈남산점", 500, 790), item("2026년 주간식단", 250, 790),
    item("8/10(월)", 150, 750), item("8/11(화)", 350, 750),
    item("죽", 150, 700), item("국", 150, 680), item("corner1", 70, 660), item("조식", 40, 630), item("반찬", 150, 650), item("김치", 150, 635), item("토스트", 350, 680),
    item("corner4", 70, 590), item("선식", 150, 610), item("우유", 150, 570), item("PLUS BAR", 70, 550), item("샐러드바", 150, 550),
    item("비빔밥", 150, 530), item("국", 150, 510), item("corner1,2", 70, 500), item("반찬", 150, 490), item("김치", 150, 470), item("돈가스", 350, 510),
    item("라면", 150, 450), item("corner3", 70, 420), item("중식", 40, 415), item("만두", 150, 400), item("300", 150, 380), item("우동", 350, 450), item("370", 350, 380),
    item("corner4", 70, 350), item("특식", 150, 330), item("후식", 70, 310), item("차", 150, 310), item("PLUS BAR", 70, 295),
    item("덮밥", 150, 280), item("국물", 150, 265), item("corner1,2", 70, 250), item("석식", 40, 220), item("반찬", 150, 230), item("PLUS BAR", 70, 155), item("야식", 40, 135)
  ] }];

  const result = structureMealText(pages, {
    pdfUrl: "https://example.test/menu.pdf",
    referenceDate: "2026-08-10T00:00:00Z"
  });

  assert.equal(result.restaurant, undefined);
  assert.equal(result.restaurants[0].restaurant, "DN솔루션즈 남산점");
  assert.equal(result.weekStart, "2026-08-10");
  assert.equal(result.weekEnd, "2026-08-11");
  assert.deepEqual(result.restaurants[0].days["2026-08-10"].breakfast.corner1, ["죽", "국", "반찬", "김치"]);
  assert.deepEqual(result.restaurants[0].days["2026-08-10"].breakfast.corner4, ["선식", "우유"]);
  assert.deepEqual(result.restaurants[0].days["2026-08-10"].lunch["corner1,2"], ["비빔밥", "국", "반찬", "김치"]);
  assert.deepEqual(result.restaurants[0].days["2026-08-10"].lunch.corner3, ["라면", "만두"]);
  assert.deepEqual(result.restaurants[0].days["2026-08-11"].lunch.corner3, ["우동"]);
  assert.deepEqual(result.restaurants[0].days["2026-08-10"].dinner["corner1,2"], ["덮밥", "국물", "반찬"]);
  assert.equal(result.restaurants[0].days["2026-08-10"].breakfast["PLUS BAR"], undefined);
  assert.equal(result.restaurants[0].days["2026-08-10"].dinner?.후식, undefined);
});

test("페이지별 식당을 유지하고 연말을 넘는 날짜의 연도를 보정한다", () => {
  const makePage = (pageNumber, restaurant) => ({ pageNumber, items: [
    item(restaurant, 20, 800), item("12/31(목)", 150, 750), item("1/1(금)", 350, 750),
    item("중식", 20, 600), item("corner4", 60, 580), item("메뉴", 150, 550), item("새해메뉴", 350, 550)
  ] });
  const result = structureMealText([makePage(1, "남산점"), makePage(2, "성주점")], {
    referenceDate: "2026-12-31T00:00:00Z"
  });
  assert.equal(result.restaurants.length, 2);
  assert.equal(result.restaurants[0].restaurant, "DN솔루션즈 남산점");
  assert.equal(result.restaurants[1].restaurant, "DN솔루션즈 성주점");
  assert.equal(result.weekEnd, "2027-01-01");
});

test("성주점 표 밖 안내문과 메뉴가 없는 칸의 연락처를 제외한다", () => {
  const pages = [{ pageNumber: 1, items: [
    item("DN솔루션즈성주점", 20, 800), item("8/10(월)", 150, 750), item("8/15(토)", 350, 750),
    item("중식", 20, 600), item("점심메뉴", 150, 560), item("토요일점심", 350, 560),
    item("추가코너", 20, 500),
    item("석식", 20, 400), item("저녁메뉴", 150, 450), item("반찬", 150, 430),
    item("별도", 150, 120), item("게시", 150, 100), item("된", 150, 80), item("일일메뉴표를", 150, 60),
    item("소중한", 350, 120), item("의견", 350, 100), item("및", 350, 80), item("문의", 350, 60),
    item("lee.minhwan", 350, 40), item("@ourhome.co.kr", 350, 20)
  ] }];

  const result = structureMealText(pages, { referenceDate: "2026-08-10T00:00:00Z" });
  assert.deepEqual(result.restaurants[0].days["2026-08-10"].dinner.menu, ["저녁메뉴", "반찬"]);
  assert.equal(result.restaurants[0].days["2026-08-15"].dinner, undefined);
});
