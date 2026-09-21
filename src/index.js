const AMAP_BASE = "https://restapi.amap.com";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
});

const safeText = (value, max = 80) => String(value ?? "").trim().slice(0, max);
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min));
const round10 = (value) => Math.round(value / 10) * 10;
const amapCache = new Map();
const amapInFlight = new Map();
const amapCacheTtlMs = 2 * 60 * 1000;
const isValidIsoDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};

async function amap(path, params, key) {
  const url = new URL(path, AMAP_BASE);
  Object.entries({ ...params, key }).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  });
  const cacheKey = url.toString();
  const cached = amapCache.get(cacheKey);
  if (cached && Date.now() - cached.time < amapCacheTtlMs) return cached.data;
  if (amapInFlight.has(cacheKey)) return amapInFlight.get(cacheKey);
  const task = (async () => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`地图服务暂时不可用（${response.status}）`);
        const data = await response.json();
        if (String(data.status) !== "1") throw new Error(data.info || "地图服务返回异常");
        amapCache.set(cacheKey, { data, time: Date.now() });
        return data;
      } catch (error) { lastError = error; }
    }
    throw lastError;
  })();
  amapInFlight.set(cacheKey, task);
  try { return await task; } finally { amapInFlight.delete(cacheKey); }
}

const interestKeywords = {
  culture: ["博物馆", "历史文化景点", "美术馆"],
  nature: ["景点", "自然风景区"],
  food: ["特色美食", "老字号餐厅"],
  city: ["城市地标", "特色商业街", "观景台"],
  family: ["亲子景点", "动物园", "科技馆"],
  relaxed: ["城市公园", "特色咖啡馆", "历史街区"],
};

const slotMeta = [
  { time: "09:00", period: "上午" },
  { time: "12:30", period: "午间" },
  { time: "15:00", period: "下午" },
  { time: "19:00", period: "晚间" },
];

const budgetConfig = {
  value: { label: "精打细算", hotel: 240, food: 100, tickets: 60, restaurant: "人均 ¥40–80", hotelRange: "¥180–320/晚", hotelKeyword: "经济型酒店" },
  comfort: { label: "舒适均衡", hotel: 520, food: 200, tickets: 110, restaurant: "人均 ¥80–160", hotelRange: "¥380–680/晚", hotelKeyword: "舒适型酒店" },
  premium: { label: "品质体验", hotel: 1100, food: 420, tickets: 180, restaurant: "人均 ¥180–350", hotelRange: "¥800–1500/晚", hotelKeyword: "豪华酒店" },
};

const transportLabels = { auto: "智能推荐", train: "高铁/火车", flight: "飞机", drive: "自驾", bus: "长途汽车" };

function haversine(a, b) {
  const toRad = (n) => (n * Math.PI) / 180;
  const [lng1, lat1] = a.split(",").map(Number);
  const [lng2, lat2] = b.split(",").map(Number);
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function travelHint(a, b) {
  const km = haversine(a.location, b.location);
  if (km < 1.5) return { mode: "步行", minutes: Math.max(8, Math.round(km * 14)), distance: km };
  if (km < 7) return { mode: "公交/打车", minutes: Math.round(12 + km * 4), distance: km };
  return { mode: "地铁/打车", minutes: Math.round(18 + km * 3), distance: km };
}

function scorePoi(poi, center) {
  const name = poi.name || "";
  const rating = Number(poi.business?.rating || poi.biz_ext?.rating || 0);
  let score = rating * 12;
  if (/博物馆|故宫|景区|古城|西湖|寺|塔|步行街|旧居|历史街区|美术馆|动物园|科技馆/.test(name)) score += 22;
  if (/公园/.test(name)) score += 4;
  if (/国家级|省级/.test(poi.type || "")) score += 14;
  if (/酒店|公司|小区|便利店|停车场|卫生间/.test(name)) score -= 50;
  if (center && poi.location) score -= Math.min(haversine(center, poi.location), 30);
  return score;
}

function normalizePoi(poi, city, center) {
  return {
    id: poi.id,
    name: poi.name,
    address: typeof poi.address === "string" ? poi.address : city,
    location: poi.location,
    type: poi.type?.split(";").slice(-1)[0] || "目的地",
    rating: poi.business?.rating || poi.biz_ext?.rating || null,
    tel: poi.business?.tel || null,
    businessArea: poi.business?.business_area || null,
    photo: poi.photos?.[0]?.url || null,
    score: scorePoi(poi, center),
  };
}

async function placeSearch(city, keywords, key, center, size = 12) {
  try {
    const result = await amap("/v5/place/text", { keywords, region: city, city_limit: true, page_size: size, show_fields: "business,photos" }, key);
    return (result.pois || []).filter((poi) => poi?.id && poi?.location && poi?.name).map((poi) => normalizePoi(poi, city, center));
  } catch {
    return [];
  }
}

async function fetchPois(city, interests, key, center) {
  const selected = interests.length ? interests : ["culture", "nature", "food"];
  const keywords = [...new Set(selected.flatMap((item) => interestKeywords[item] || []))].slice(0, 7);
  const batches = await Promise.all(keywords.map((word) => placeSearch(city, word, key, center)));
  const seen = new Set();
  return batches.flat().filter((poi) => !seen.has(poi.id) && seen.add(poi.id)).sort((a, b) => b.score - a.score);
}

async function fetchRecommendations(city, tier, key, center) {
  const config = budgetConfig[tier];
  const [foodA, foodB, hotelsA, hotelsB] = await Promise.all([
    placeSearch(city, "特色美食", key, center, 14),
    placeSearch(city, "老字号餐厅", key, center, 14),
    placeSearch(city, config.hotelKeyword, key, center, 14),
    placeSearch(city, "市中心酒店", key, center, 14),
  ]);
  const dedupe = (items) => [...new Map(items.map((item) => [item.id, item])).values()];
  const select = (items, reject) => dedupe(items)
    .filter((item) => !reject.test(item.name) && haversine(center, item.location) < 18)
    .sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || b.score - a.score)
    .slice(0, 4);
  let restaurants = select([...foodA, ...foodB], /海底捞|肯德基|麦当劳/);
  let hotels = select([...hotelsA, ...hotelsB], /公寓.*店|足浴|洗浴/);
  if (restaurants.length < 4) restaurants = select([...restaurants, ...await placeSearch(city, "餐厅", key, center, 20)], /海底捞|肯德基|麦当劳/);
  if (hotels.length < 4) hotels = select([...hotels, ...await placeSearch(city, "酒店", key, center, 20)], /公寓.*店|足浴|洗浴/);
  return {
    restaurants: restaurants.map((item) => ({ ...item, priceEstimate: config.restaurant })),
    hotels: hotels.map((item) => ({ ...item, priceEstimate: config.hotelRange })),
  };
}

function chooseTransport(mode, km) {
  if (mode !== "auto") return mode;
  if (km > 900) return "flight";
  if (km > 120) return "train";
  return "drive";
}

function estimateLeg(modeInput, km) {
  const mode = chooseTransport(modeInput, km);
  const references = {
    train: { hours: Math.max(1, km / 230 + 1.1), note: "请前往 12306 查询实时车次与票价", queryUrl: "https://www.12306.cn/index/" },
    flight: { hours: Math.max(3.2, km / 750 + 3), note: "请前往航司或授权票务平台查询实时票价", queryUrl: "https://www.umetrip.com/" },
    drive: { hours: Math.max(.5, km / 75), note: "高德可提供实时路况；油费不展示估算值", queryUrl: "https://ditu.amap.com/" },
    bus: { hours: Math.max(1, km / 65 + .6), note: "请前往客运站授权渠道查询实时班次与票价", queryUrl: "https://ditu.amap.com/" },
  };
  return { mode, label: transportLabels[mode], distanceKm: Math.round(km), hours: Number(references[mode].hours.toFixed(1)), note: references[mode].note, queryUrl: references[mode].queryUrl, priceStatus: "not_connected", price: null };
}

function buildTransport(originGeo, destinationGeo, outboundMode, returnMode) {
  if (!originGeo?.location) return null;
  const km = haversine(originGeo.location, destinationGeo.location);
  if (km < 30) return { origin: originGeo.formatted_address, destination: destinationGeo.formatted_address, distanceKm: Math.round(km), localTrip: true, outbound: null, inbound: null, pricing: { status: "not_required", source: null, checkedAt: null, total: 0, message: "出发地与目的地位于同一城市，无需规划跨城往返交通。" } };
  const outbound = estimateLeg(outboundMode, km);
  const inbound = estimateLeg(returnMode, km);
  return { origin: originGeo.formatted_address, destination: destinationGeo.formatted_address, distanceKm: Math.round(km), outbound, inbound, pricing: { status: "not_connected", source: null, checkedAt: null, message: "尚未接入授权票务供应商，不展示交通费用。" } };
}

function orderByProximity(items, startLocation) {
  const remaining = [...items];
  const ordered = [];
  let current = startLocation;
  while (remaining.length) {
    remaining.sort((a, b) => haversine(current, a.location) - haversine(current, b.location));
    const next = remaining.shift();
    ordered.push(next);
    current = next.location;
  }
  return ordered;
}

function buildDays(pois, days, pace, startDate, center) {
  const perDay = pace === "slow" ? 2 : pace === "full" ? 4 : 3;
  const desired = Math.min(days * perDay, pois.length);
  const chosen = [];
  for (const poi of pois) {
    const similar = chosen.some((item) => item.name === poi.name || ((item.name.includes(poi.name) || poi.name.includes(item.name)) && haversine(item.location, poi.location) < 3));
    if (!similar) chosen.push(poi);
    if (chosen.length >= desired) break;
  }
  const routeOrdered = orderByProximity(chosen, center);
  return Array.from({ length: days }, (_, day) => {
    const date = new Date(`${startDate}T12:00:00`);
    date.setDate(date.getDate() + day);
    const items = routeOrdered.slice(day * perDay, (day + 1) * perDay);
    return {
      day: day + 1,
      date: date.toISOString().slice(0, 10),
      title: day === 0 ? "初见城市" : day === days - 1 ? "从容收官" : "深入漫游",
      items: items.map((poi, index) => ({ ...poi, ...slotMeta[index], stay: index === 1 ? "1–1.5 小时" : "1.5–2 小时", transfer: index === 0 ? null : travelHint(items[index - 1], poi) })),
    };
  });
}

async function fetchLocalTransit(itinerary, cityCode, travelers, key) {
  const pairs = itinerary.flatMap((day) => day.items.slice(1).map((item, index) => ({ from: day.items[index], to: item })));
  const legs = await Promise.all(pairs.map(async ({ from, to }) => {
    try {
      const data = await amap("/v3/direction/transit/integrated", { origin: from.location, destination: to.location, city: cityCode, cityd: cityCode, strategy: 0, nightflag: 0 }, key);
      const candidates = (data.route?.transits || []).filter((item) => item.cost !== undefined && item.cost !== null && item.cost !== "" && Number.isFinite(Number(item.cost)));
      const best = candidates.sort((a, b) => Number(a.duration) - Number(b.duration))[0];
      return { from: from.name, to: to.name, costPerPerson: best ? Number(best.cost) : null, durationMinutes: best ? Math.round(Number(best.duration) / 60) : null };
    } catch { return { from: from.name, to: to.name, costPerPerson: null, durationMinutes: null }; }
  }));
  const known = legs.filter((leg) => leg.costPerPerson !== null);
  const total = known.length === legs.length ? Number((known.reduce((sum, leg) => sum + leg.costPerPerson, 0) * travelers).toFixed(2)) : null;
  return { status: total === null ? "partial" : "queried", source: "高德公交路径规划", checkedAt: new Date().toISOString(), total, legs };
}

function budgetScenario(tier, days, travelers, localTransit) {
  const config = budgetConfig[tier];
  const nights = Math.max(0, days - 1);
  const rooms = nights > 0 ? Math.max(1, Math.ceil(travelers / 2)) : 0;
  const accommodation = config.hotel * nights * rooms;
  const food = config.food * days * travelers;
  const tickets = config.tickets * days * travelers;
  const total = round10(accommodation + food + tickets + (localTransit.total || 0));
  return { tier, label: config.label, total, perPerson: round10(total / travelers), excludesIntercityTransport: true, breakdown: { accommodation, food, localTransit: localTransit.total, tickets }, assumptions: `${travelers} 人 · ${nights} 晚 · ${rooms} 间房 · 不含跨城往返交通` };
}

async function geocode(address, city, key) {
  if (!address) return null;
  const result = await amap("/v3/geocode/geo", { address, city }, key);
  return result.geocodes?.[0] || null;
}

async function plan(request, env) {
  if (!env.AMAP_MAPS_API_KEY) return json({ error: "服务端尚未配置地图密钥" }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "请求格式不正确" }, 400); }

  const city = safeText(body.city, 40);
  const origin = safeText(body.origin, 80);
  const startDate = safeText(body.startDate, 10);
  const days = clamp(body.days, 1, 5);
  const travelers = clamp(body.travelers, 1, 10);
  const pace = ["slow", "balanced", "full"].includes(body.pace) ? body.pace : "balanced";
  const budget = Object.hasOwn(budgetConfig, body.budget) ? body.budget : "comfort";
  const outboundMode = Object.hasOwn(transportLabels, body.outboundMode) ? body.outboundMode : "auto";
  const returnMode = Object.hasOwn(transportLabels, body.returnMode) ? body.returnMode : outboundMode;
  const budgetLimit = Math.max(0, Number(body.budgetLimit) || 0);
  const interests = Array.isArray(body.interests) ? body.interests.map((x) => safeText(x, 20)).slice(0, 6) : [];
  if (!city || !origin || !isValidIsoDate(startDate)) return json({ error: "请填写出发地、目的地和有效日期" }, 400);
  const today = new Date();
  const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (startDate < localToday) return json({ error: "出发日期不能早于今天" }, 400);

  try {
    const [destinationGeo, originGeo] = await Promise.all([geocode(city, city, env.AMAP_MAPS_API_KEY), geocode(origin, origin, env.AMAP_MAPS_API_KEY)]);
    if (!destinationGeo?.location || !originGeo?.location) return json({ error: "没有找到出发地或目的地，请换个更具体的名称" }, 404);
    const transport = buildTransport(originGeo, destinationGeo, outboundMode, returnMode);
    const [weatherResult, pois, recommendations] = await Promise.all([
      amap("/v3/weather/weatherInfo", { city: destinationGeo.adcode, extensions: "all" }, env.AMAP_MAPS_API_KEY).catch(() => null),
      fetchPois(city, interests, env.AMAP_MAPS_API_KEY, destinationGeo.location),
      fetchRecommendations(city, budget, env.AMAP_MAPS_API_KEY, destinationGeo.location),
    ]);
    if (pois.length < 3) return json({ error: "找到的可规划地点太少，请输入更具体的城市或地区" }, 422);

    const itinerary = buildDays(pois, days, pace, startDate, destinationGeo.location);
    const tripDates = itinerary.map((day) => day.date);
    const forecastByDate = new Map((weatherResult?.forecasts?.[0]?.casts || []).map((item) => [item.date, item]));
    const forecast = tripDates.map((date) => forecastByDate.get(date)).filter(Boolean).map((item) => ({ date: item.date, dayWeather: item.dayweather, nightWeather: item.nightweather, dayTemp: Number(item.daytemp), nightTemp: Number(item.nighttemp), wind: item.daywind, power: item.daypower }));
    const weatherStatus = {
      status: forecast.length === tripDates.length ? "complete" : forecast.length ? "partial" : "unavailable",
      message: forecast.length === tripDates.length ? "行程日期天气预报已更新" : forecast.length ? "仅部分行程日期进入预报窗口" : "行程日期尚未进入天气预报窗口，请临近出发时更新",
    };
    const localTransit = await fetchLocalTransit(itinerary, destinationGeo.citycode || destinationGeo.adcode, travelers, env.AMAP_MAPS_API_KEY);
    const scenarios = ["value", "comfort", "premium"].map((tier) => budgetScenario(tier, days, travelers, localTransit));
    const selectedScenario = scenarios.find((item) => item.tier === budget);
    const affordable = budgetLimit ? scenarios.filter((item) => item.total <= budgetLimit).at(-1) : null;
    const budgetAdvice = !budgetLimit
      ? "填写总预算后，可自动判断余量并切换更合适的方案。"
      : selectedScenario.total <= budgetLimit
        ? `在地预算预计可结余约 ¥${budgetLimit - selectedScenario.total}；往返交通需另按实时票价预留。`
        : affordable
          ? `当前预计超出 ¥${selectedScenario.total - budgetLimit}，建议切换为「${affordable.label}」。`
          : `最低方案仍超出约 ¥${scenarios[0].total - budgetLimit}，建议缩短天数或调整往返交通。`;

    return json({
      city: destinationGeo.city || destinationGeo.province || city,
      formattedAddress: destinationGeo.formatted_address,
      center: destinationGeo.location,
      origin: originGeo.formatted_address,
      days, travelers, budget, pace, budgetLimit, transport, localTransit, weather: forecast, weatherStatus, itinerary, recommendations,
      budgetSummary: { selected: selectedScenario, scenarios, advice: budgetAdvice },
      mapPoints: itinerary.flatMap((day) => day.items.map((item) => item.location)),
      mapDays: itinerary.map((day) => ({ day: day.day, date: day.date, points: day.items.map((item) => item.location) })),
      generatedAt: new Date().toISOString(),
      tips: [
        "开放时间与预约政策可能临时变化，出发前请以景点官方公告为准。",
        "交通与住宿价格会在本地增强服务可用时通过飞猪查询，最终以下单页为准。",
        "餐饮与门票预算属于规划参考，不代表实时库存或最终成交价。",
        "地图路线根据推荐地点生成，实际出发前请结合实时路况调整。",
      ],
    });
  } catch (error) {
    return json({ error: error.message || "生成行程时遇到问题，请稍后重试" }, 502);
  }
}

function validPoint(value) { return /^-?\d{1,3}(?:\.\d+)?,-?\d{1,2}(?:\.\d+)?$/.test(value); }

async function routeGeo(request, env) {
  const url = new URL(request.url);
  const points = (url.searchParams.get("points") || "").split(";").filter(validPoint).slice(0, 16);
  if (points.length < 2) return json({ error: "至少需要两个路线点" }, 400);
  try {
    const driving = await amap("/v3/direction/driving", { origin: points[0], destination: points.at(-1), waypoints: points.slice(1, -1).join(";"), extensions: "base" }, env.AMAP_MAPS_API_KEY);
    const routePoints = (driving.route?.paths?.[0]?.steps || []).flatMap((step) => (step.polyline || "").split(";")).filter(validPoint);
    const simplified = routePoints.filter((_, index) => index % Math.max(1, Math.ceil(routePoints.length / 120)) === 0).slice(0, 120);
    if (routePoints.at(-1)) simplified.push(routePoints.at(-1));
    return json({ route: simplified.length ? simplified : points, points, distance: driving.route?.paths?.[0]?.distance || null, duration: driving.route?.paths?.[0]?.duration || null });
  } catch (error) {
    return json({ error: error.message || "路线地图生成失败" }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok: true, maps: Boolean(env.AMAP_MAPS_API_KEY) });
    if (url.pathname === "/api/plan" && request.method === "POST") return plan(request, env);
    if (url.pathname === "/api/route" && request.method === "GET") return routeGeo(request, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
