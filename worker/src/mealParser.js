const DATE_PATTERN = /(?:^|\s)(\d{1,2})\s*[./-]\s*(\d{1,2})\s*\(([월화수목금토일])\)/;
const MEALS = new Map([
  ["조식", "breakfast"], ["아침", "breakfast"],
  ["중식", "lunch"], ["점심", "lunch"],
  ["석식", "dinner"], ["저녁", "dinner"], ["야식", "lateNight"]
]);
const CORNER_PATTERN = /^corner\s*[\d,./&-]+$/i;
const EXCLUDED_SECTION_PATTERN = /^(?:plus\s*bar|후식|추가\s*코너)$/i;
const NUMBER_PATTERN = /^\d+(?:[.,]\d+)?$/;
const SECTION_LINE_TOLERANCE = 3;

const clean = value => String(value || "").replace(/\s+/g, " ").trim();
const midpoint = (a, b) => (a + b) / 2;

function nearestYear(month, day, referenceDate) {
  const reference = new Date(referenceDate || Date.now());
  const candidates = [reference.getUTCFullYear() - 1, reference.getUTCFullYear(), reference.getUTCFullYear() + 1];
  return candidates.reduce((best, year) => {
    const distance = Math.abs(Date.UTC(year, month - 1, day) - reference.getTime());
    return distance < best.distance ? { year, distance } : best;
  }, { year: candidates[0], distance: Infinity }).year;
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function bounds(values, low, high) {
  return values.map((value, index) => ({
    value,
    min: index ? midpoint(values[index - 1], value) : low,
    max: index < values.length - 1 ? midpoint(value, values[index + 1]) : high
  }));
}

function normalizedCorner(label) {
  return clean(label).replace(/\s*,\s*/g, ",").replace(/\s+/g, " ");
}

function restaurantName(items, firstDateY) {
  const candidates = items.filter(item => item.y > firstDateY && !DATE_PATTERN.test(item.str));
  const heading = candidates.map(item => item.str).join("").replace(/\s+/g, "");
  if (heading.includes("남산점")) return "DN솔루션즈 남산점";
  if (heading.includes("성주점")) return "DN솔루션즈 성주점";
  const explicit = candidates.find(item => /(?:점|사업장|식당)$/.test(item.str));
  return clean(explicit?.str || candidates.sort((a, b) => b.y - a.y || a.x - b.x)[0]?.str || "미확인 식당");
}

function nearestSectionBoundary(sections, labelY, direction, fallback) {
  const candidates = sections.filter(section => direction === "above" ? section.y > labelY : section.y < labelY);
  if (!candidates.length) return fallback;
  return direction === "above"
    ? Math.min(...candidates.map(section => section.y))
    : Math.max(...candidates.map(section => section.y));
}

function isExcludedSectionLine(item, sections) {
  return sections.some(section => Math.abs(item.y - section.y) <= SECTION_LINE_TOLERANCE);
}

function parsePage(page, referenceDate) {
  const items = page.items.map(item => ({ ...item, str: clean(item.str) })).filter(item => item.str);
  const dateHeaders = items.map(item => ({ item, match: item.str.match(DATE_PATTERN) })).filter(x => x.match)
    .sort((a, b) => a.item.x - b.item.x);
  if (!dateHeaders.length) return null;

  const yearText = items.map(i => i.str).join(" ").match(/\b(20\d{2})\s*년?/);
  const first = dateHeaders[0].match;
  const inferredYear = yearText ? Number(yearText[1]) : nearestYear(Number(first[1]), Number(first[2]), referenceDate);
  const headerXs = dateHeaders.map(h => h.item.x);
  const typicalGap = headerXs.length > 1
    ? headerXs.slice(1).reduce((sum, x, index) => sum + x - headerXs[index], 0) / (headerXs.length - 1)
    : Math.max(...items.map(item => item.x)) - Math.min(...items.map(item => item.x));
  const dateColumns = bounds(headerXs, headerXs[0] - typicalGap / 2, headerXs.at(-1) + typicalGap / 2);
  const mealLabels = items.filter(item => MEALS.has(item.str)).sort((a, b) => b.y - a.y);
  const excludedSections = items.filter(item => EXCLUDED_SECTION_PATTERN.test(item.str));
  const mealRows = bounds(mealLabels.map(item => item.y), Infinity, -Infinity).map((row, index) => {
    const defaultTop = index ? midpoint(mealLabels[index - 1].y, row.value) : dateHeaders[0].item.y;
    const defaultBottom = index < mealLabels.length - 1 ? midpoint(row.value, mealLabels[index + 1].y) : -Infinity;
    return {
      ...row,
      top: nearestSectionBoundary(excludedSections, row.value, "above", defaultTop),
      bottom: nearestSectionBoundary(excludedSections, row.value, "below", defaultBottom),
      label: mealLabels[index]
    };
  });
  const days = {};

  dateHeaders.forEach((header, columnIndex) => {
    const month = Number(header.match[1]);
    const day = Number(header.match[2]);
    let year = inferredYear;
    if (columnIndex && month < Number(dateHeaders[0].match[1])) year++;
    const date = isoDate(year, month, day);
    const column = dateColumns[columnIndex];
    const dayResult = {};

    for (const row of mealRows) {
      const mealKey = MEALS.get(row.label.str);
      const area = items.filter(item => item.x >= column.min && item.x < column.max && item.y < row.top && item.y >= row.bottom);
      // 코너 표시는 날짜 셀 내부가 아니라 행의 좌측에 한 번만 표시되는 양식도 있다.
      const corners = items.filter(item => item.y < row.top && item.y >= row.bottom && CORNER_PATTERN.test(item.str))
        .sort((a, b) => b.y - a.y || a.x - b.x);
      const sections = corners.length ? corners : [{ str: "menu", y: row.top }];
      const result = {};
      sections.forEach((corner, index) => {
        // 코너명은 병합된 셀의 세로 중앙에 있으므로 그 글자 좌표를 메뉴의
        // 시작점으로 사용할 수 없다. 인접한 코너명의 중간점을 셀 경계로 본다.
        const top = corners.length && index ? midpoint(sections[index - 1].y, corner.y) : row.top;
        const bottom = corners.length && index < sections.length - 1
          ? midpoint(corner.y, sections[index + 1].y)
          : row.bottom;
        const menu = area.filter(item => item !== corner && !MEALS.has(item.str) && !DATE_PATTERN.test(item.str)
          && !CORNER_PATTERN.test(item.str) && !EXCLUDED_SECTION_PATTERN.test(item.str)
          && !isExcludedSectionLine(item, excludedSections) && item.y <= top && item.y >= bottom
          && !(mealKey === "lunch" && NUMBER_PATTERN.test(item.str)))
          .sort((a, b) => b.y - a.y || a.x - b.x).map(item => item.str);
        if (menu.length) result[normalizedCorner(corner.str)] = menu;
      });
      if (Object.keys(result).length) dayResult[mealKey] = result;
    }
    days[date] = dayResult;
  });

  return { restaurant: restaurantName(items, dateHeaders[0].item.y), days };
}

export function structureMealText(pages, { pdfUrl, referenceDate = new Date() } = {}) {
  const restaurants = pages.map(page => parsePage(page, referenceDate)).filter(Boolean);
  if (!restaurants.length) throw new Error("PDF에서 날짜 헤더를 찾지 못했습니다.");
  const dates = restaurants.flatMap(r => Object.keys(r.days)).sort();
  return {
    pdfUrl,
    weekStart: dates[0],
    weekEnd: dates.at(-1),
    restaurants,
    parsedAt: new Date().toISOString()
  };
}

export async function extractMealPdf(data, options = {}) {
  const [{ getDocument }, { WorkerMessageHandler }] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs")
  ]);
  // Cloudflare Workers cannot start pdf.js's Web Worker. Register the bundled
  // handler so pdf.js can run its fake worker without resolving pdf.worker.mjs
  // as a separate module at runtime.
  globalThis.pdfjsWorker = { WorkerMessageHandler };
  const document = await getDocument({ data: new Uint8Array(data), disableWorker: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({
      pageNumber,
      items: content.items.filter(item => "str" in item).map(item => ({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height
      }))
    });
  }
  options.onTextItems?.(pages);
  return { result: structureMealText(pages, options), pages };
}
