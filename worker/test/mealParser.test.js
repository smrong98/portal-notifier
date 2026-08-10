import test from "node:test";
import assert from "node:assert/strict";
import { structureMealText } from "../src/mealParser.js";

const item = (str, x, y) => ({ str, x, y, width: 20, height: 10 });

test("좌표 기반으로 날짜, 식사, 코너의 가변 메뉴를 구조화한다", () => {
  const pages = [{ pageNumber: 1, items: [
    item("남산점", 40, 790), item("2026년 주간식단", 250, 790),
    item("8/10(월)", 150, 750), item("8/11(화)", 350, 750),
    item("조식", 40, 680), item("corner1", 70, 660),
    item("죽", 150, 640), item("샐러드", 150, 620), item("토스트", 350, 640),
    item("중식", 40, 500), item("corner1,2", 70, 480),
    item("비빔밥", 150, 460), item("국", 150, 440), item("돈가스", 350, 460),
    item("corner3", 70, 400), item("라면", 150, 380), item("우동", 350, 380),
    item("석식", 40, 250), item("PLUS BAR", 70, 230),
    item("과일", 150, 210), item("요거트", 350, 210)
  ] }];

  const result = structureMealText(pages, {
    pdfUrl: "https://example.test/menu.pdf",
    referenceDate: "2026-08-10T00:00:00Z"
  });

  assert.equal(result.restaurant, undefined);
  assert.equal(result.restaurants[0].restaurant, "남산점");
  assert.equal(result.weekStart, "2026-08-10");
  assert.equal(result.weekEnd, "2026-08-11");
  assert.deepEqual(result.restaurants[0].days["2026-08-10"].breakfast.corner1, ["죽", "샐러드"]);
  assert.deepEqual(result.restaurants[0].days["2026-08-10"].lunch["corner1,2"], ["비빔밥", "국"]);
  assert.deepEqual(result.restaurants[0].days["2026-08-11"].lunch.corner3, ["우동"]);
  assert.deepEqual(result.restaurants[0].days["2026-08-11"].dinner["PLUS BAR"], ["요거트"]);
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
  assert.equal(result.weekEnd, "2027-01-01");
});
