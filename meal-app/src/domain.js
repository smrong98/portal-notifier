export const MEALS = Object.freeze({
  breakfast: "조식",
  lunch: "중식",
  dinner: "석식"
});

export const RESTAURANTS = Object.freeze([
  { key: "namsan", name: "남산점" },
  { key: "seongju", name: "성주점" }
]);

export const DEFAULT_SETTINGS = Object.freeze({
  restaurant: "namsan",
  timezone: "Asia/Seoul",
  mealNotifications: {
    breakfast: { enabled: true, time: "07:30" },
    lunch: { enabled: true, time: "11:30" },
    dinner: { enabled: true, time: "17:30" }
  }
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const clean = (value, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function restaurantKey(value, index) {
  const explicit = clean(value?.key, 30);
  if (RESTAURANTS.some(restaurant => restaurant.key === explicit)) return explicit;
  const name = clean(value?.restaurant ?? value?.name, 80);
  if (name.includes("남산")) return "namsan";
  if (name.includes("성주")) return "seongju";
  return RESTAURANTS[index]?.key ?? null;
}

function sanitizeCorners(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).slice(0, 20).flatMap(([corner, items]) => {
    if (!Array.isArray(items)) return [];
    const safeItems = items.slice(0, 30).map(item => clean(item)).filter(Boolean);
    return safeItems.length ? [[clean(corner, 64) || "menu", safeItems]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

function sanitizeDays(value, weekStart, weekEnd) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 14).flatMap(([date, meals]) => {
    if (!ISO_DATE.test(date) || date < weekStart || date > weekEnd || !meals || typeof meals !== "object") return [];
    const safeMeals = Object.fromEntries(Object.keys(MEALS).flatMap(mealKey => {
      const corners = sanitizeCorners(meals[mealKey]);
      return corners ? [[mealKey, corners]] : [];
    }));
    return [[date, safeMeals]];
  }));
}

export function sanitizeMeal(value, now = new Date()) {
  if (!value || typeof value !== "object") throw new Error("식단 데이터가 객체가 아닙니다.");
  const weekStart = clean(value.weekStart, 10);
  const weekEnd = clean(value.weekEnd, 10);
  if (!ISO_DATE.test(weekStart) || !ISO_DATE.test(weekEnd) || weekStart > weekEnd) {
    throw new Error("식단 주차 날짜가 올바르지 않습니다.");
  }
  const seen = new Set();
  const restaurants = (Array.isArray(value.restaurants) ? value.restaurants : []).slice(0, RESTAURANTS.length)
    .flatMap((restaurant, index) => {
      const key = restaurantKey(restaurant, index);
      if (!key || seen.has(key)) return [];
      seen.add(key);
      const fallbackName = RESTAURANTS.find(item => item.key === key)?.name ?? key;
      return [{
        key,
        name: fallbackName,
        days: sanitizeDays(restaurant.days, weekStart, weekEnd)
      }];
    });
  if (!restaurants.length) throw new Error("공개할 식당 데이터가 없습니다.");
  return {
    schemaVersion: 1,
    weekStart,
    weekEnd,
    restaurants,
    publishedAt: now.toISOString()
  };
}

export function sanitizeSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const notifications = source.mealNotifications && typeof source.mealNotifications === "object"
    ? source.mealNotifications : {};
  return {
    restaurant: RESTAURANTS.some(item => item.key === source.restaurant)
      ? source.restaurant : DEFAULT_SETTINGS.restaurant,
    timezone: "Asia/Seoul",
    mealNotifications: Object.fromEntries(Object.entries(MEALS).map(([mealKey]) => {
      const incoming = notifications[mealKey] ?? {};
      const fallback = DEFAULT_SETTINGS.mealNotifications[mealKey];
      return [mealKey, {
        enabled: incoming.enabled === undefined ? fallback.enabled : Boolean(incoming.enabled),
        time: CLOCK_TIME.test(incoming.time ?? "") ? incoming.time : fallback.time
      }];
    }))
  };
}

export function localDateTime(date = new Date(), timezone = "Asia/Seoul") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function mealForDate(meals, date) {
  const weeks = Array.isArray(meals) ? meals : [];
  return weeks.find(meal => meal.weekStart <= date && meal.weekEnd >= date) ?? weeks.at(-1) ?? null;
}

export function mealNotification(meal, date, mealKey, restaurantKey) {
  const mealName = MEALS[mealKey];
  const restaurant = meal?.restaurants?.find(item => item.key === restaurantKey);
  const corners = restaurant?.days?.[date]?.[mealKey];
  const lines = corners ? Object.entries(corners).map(([corner, items]) => {
    const summary = items.slice(0, 2).join(", ");
    const suffix = items.length > 2 ? ", ..." : "";
    return `${corner === "menu" ? "" : `${corner}: `}${summary}${suffix}`;
  }).filter(Boolean) : [];
  return {
    title: `오늘의 ${mealName}`,
    body: lines.length ? lines.join("\n") : `${date}에 등록된 ${mealName} 메뉴가 없습니다.`,
    tag: `meal-${restaurantKey}-${mealKey}-${date}`,
    data: { url: `/?date=${encodeURIComponent(date)}` }
  };
}
