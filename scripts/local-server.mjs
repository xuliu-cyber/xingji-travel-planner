import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import worker from "../src/index.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const flyaiCacheDir = path.join(root, ".cache", "flyai");
const flyaiCacheTtlMs = 5 * 60 * 1000;
const flyaiInFlight = new Map();

async function loadDevVars() {
  const values = {};
  try {
    const content = await readFile(path.join(root, ".dev.vars"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match) values[match[1]] = match[2].trim();
    }
  } catch {}
  return values;
}

const env = { ...await loadDevVars(), ...process.env };
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

async function assetFetch(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(publicDir, `.${pathname}`);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(filePath);
    return new Response(body, { headers: { "content-type": mime[path.extname(filePath)] || "application/octet-stream" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
env.ASSETS = { fetch: assetFetch };

const addDays = (date, offset) => {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + offset);
  return value.toISOString().slice(0, 10);
};

async function flyai(command, args) {
  const cacheKey = createHash("sha256").update(JSON.stringify([command, args])).digest("hex");
  const cacheFile = path.join(flyaiCacheDir, `${cacheKey}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, "utf8"));
    if (Date.now() - Date.parse(cached.fetchedAt) < flyaiCacheTtlMs) return cached;
  } catch {}
  if (flyaiInFlight.has(cacheKey)) return flyaiInFlight.get(cacheKey);
  const task = (async () => {
    const { stdout } = await execFileAsync("flyai", [command, ...args], { timeout: 50000, maxBuffer: 4 * 1024 * 1024, env: process.env });
    const result = JSON.parse(stdout.trim());
    if (result.status !== 0) throw new Error(result.message || "FlyAI 查询失败");
    const cached = { items: result.data?.itemList || [], fetchedAt: new Date().toISOString() };
    await mkdir(flyaiCacheDir, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(cached), { mode: 0o600 });
    return cached;
  })();
  flyaiInFlight.set(cacheKey, task);
  try { return await task; } finally { flyaiInFlight.delete(cacheKey); }
}

function normalizeTicket(item, mode) {
  const segment = item.journeys?.[0]?.segments?.[0] || {};
  const price = Number(mode === "flight" ? item.ticketPrice : item.price);
  return {
    mode, label: mode === "flight" ? "飞机" : "高铁/火车", price: Number.isFinite(price) ? price : null, transportNo: segment.marketingTransportNo,
    carrier: segment.marketingTransportName, seatClass: segment.seatClassName,
    departureTime: segment.depDateTime, arrivalTime: segment.arrDateTime,
    departureStation: segment.depStationName, arrivalStation: segment.arrStationName,
    durationMinutes: Number(item.totalDuration || segment.duration || 0), bookingUrl: item.jumpUrl,
  };
}

async function searchLeg(mode, origin, destination, date) {
  if (!["auto", "train", "flight"].includes(mode)) return [];
  const modes = mode === "auto" ? ["train", "flight"] : [mode];
  const batches = await Promise.all(modes.map(async (type) => {
    try {
      const result = await flyai(type === "train" ? "search-train" : "search-flight", ["--origin", origin, "--destination", destination, "--dep-date", date, "--journey-type", "1", "--sort-type", "3"]);
      return result.items.map((item) => ({ item, queriedAt: result.fetchedAt }));
    } catch { return []; }
  }));
  return batches.flatMap((items, index) => items.map(({ item, queriedAt }) => ({ ...normalizeTicket(item, modes[index]), queriedAt }))).filter((item) => item.price !== null).sort((a, b) => a.price - b.price);
}

function choosePracticalTicket(options, date, direction, budgetTier) {
  if (!options.length) return null;
  const sameDay = options.filter((item) => {
    const compare = direction === "outbound" ? item.arrivalTime : item.departureTime;
    const hour = Number(compare?.slice(11, 13));
    return compare?.slice(0, 10) === date && (direction === "outbound" ? hour <= 18 : hour >= 14);
  });
  const candidates = sameDay.length ? sameDay : options;
  return [...candidates].sort((a, b) => {
    const score = (item) => {
      const compare = direction === "outbound" ? item.arrivalTime : item.departureTime;
      if (!compare) return 1e9;
      const compareDate = compare.slice(0, 10);
      const hour = Number(compare.slice(11, 13));
      const dayOffset = Math.round((new Date(`${compareDate}T12:00:00+08:00`) - new Date(`${date}T12:00:00+08:00`)) / 86400000);
      const badDay = Math.abs(dayOffset) * 50000;
      const badTime = direction === "outbound" ? Math.max(0, hour - 14) * 3000 : Math.max(0, 17 - hour) * 3000;
      const groundTime = item.mode === "flight" ? 240 : 60;
      const priceWeight = budgetTier === "value" ? 4 : budgetTier === "premium" ? .25 : 1;
      const durationWeight = budgetTier === "premium" ? 5 : budgetTier === "value" ? .5 : 2;
      return badDay + badTime + item.durationMinutes * durationWeight + groundTime + item.price * priceWeight;
    };
    return score(a) - score(b);
  })[0];
}

function exactPrice(value) {
  const match = String(value || "").match(/[\d.]+/);
  return match ? Number(match[0]) : null;
}

async function searchHotels(payload) {
  if (Number(payload.days) <= 1) return [];
  const checkout = addDays(payload.startDate, Number(payload.days) - 1);
  const maxByTier = { value: 320, comfort: 680, premium: 1500 };
  const starsByTier = { value: "2,3", comfort: "3,4", premium: "4,5" };
  try {
    const result = await flyai("search-hotel", ["--dest-name", payload.city, "--check-in-date", payload.startDate, "--check-out-date", checkout, "--sort", "price_asc", "--hotel-stars", starsByTier[payload.budget] || "3,4", "--max-price", String(maxByTier[payload.budget] || 680)]);
    const normalized = result.items.map((item) => ({ id: item.shId, name: item.name, address: item.address, location: `${item.longitude},${item.latitude}`, rating: item.score || item.rate, star: item.star, photo: item.mainPic, price: exactPrice(item.price), priceEstimate: `${item.price}起/晚`, detailUrl: item.detailUrl, businessArea: item.interestsPoi, live: true, queriedAt: result.fetchedAt, priceNote: "实时起价，最终以预订页为准" }));
    const suitable = payload.budget === "comfort" ? normalized.filter((item) => !/青年|旅舍|青旅|民宿/.test(item.name)) : payload.budget === "premium" ? normalized.filter((item) => /豪华|五星|度假|国际|大酒店/.test(`${item.star || ""}${item.name}`)) : normalized;
    return (suitable.length >= 2 ? suitable : normalized).slice(0, 4);
  } catch { return []; }
}

function applyLiveBudget(plan, liveTotal) {
  for (const scenario of plan.budgetSummary.scenarios) {
    scenario.breakdown.roundTripTransport = liveTotal;
    scenario.total += liveTotal;
    scenario.perPerson = Math.round(scenario.total / plan.travelers / 10) * 10;
    scenario.excludesIntercityTransport = false;
    scenario.assumptions = scenario.assumptions.replace(/ · 不含跨城往返交通$/, " · 含飞猪实时往返票价");
  }
  plan.budgetSummary.selected = plan.budgetSummary.scenarios.find((item) => item.tier === plan.budget);
  const selected = plan.budgetSummary.selected;
  if (plan.budgetLimit) plan.budgetSummary.advice = selected.total <= plan.budgetLimit ? `按当前实时交通价，预计可结余约 ¥${plan.budgetLimit - selected.total}。` : `按当前实时交通价，预计超出约 ¥${selected.total - plan.budgetLimit}，可切换更低预算档位。`;
}

function applyLiveHotelBudget(plan, hotels) {
  const selectedHotel = hotels.find((hotel) => Number.isFinite(hotel.price));
  if (!selectedHotel) return;
  const nights = Math.max(0, plan.days - 1);
  const rooms = nights > 0 ? Math.ceil(plan.travelers / 2) : 0;
  const total = selectedHotel.price * nights * rooms;
  const scenario = plan.budgetSummary.scenarios.find((item) => item.tier === plan.budget);
  scenario.breakdown.accommodation = total;
  scenario.total = Object.values(scenario.breakdown).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  scenario.perPerson = Math.round(scenario.total / plan.travelers / 10) * 10;
  plan.budgetSummary.selected = plan.budgetSummary.scenarios.find((item) => item.tier === plan.budget);
  plan.budgetSummary.hotelPricing = { status: "live", selectedHotelId: selectedHotel.id, selectedHotelName: selectedHotel.name, nightlyFrom: selectedHotel.price, nights, rooms, total, source: "飞猪 FlyAI", checkedAt: selectedHotel.queriedAt || new Date().toISOString() };
}

function updateBudgetAdvice(plan) {
  if (!plan.budgetLimit) return;
  const selected = plan.budgetSummary.selected;
  plan.budgetSummary.advice = selected.total <= plan.budgetLimit ? `按当前实时交通与酒店起价，预计可结余约 ¥${plan.budgetLimit - selected.total}。` : `按当前实时交通与酒店起价，预计超出约 ¥${selected.total - plan.budgetLimit}；可切换更低预算档位或更换班次。`;
}

function minutesOf(value) { return Number(value?.slice(11, 13) || 0) * 60 + Number(value?.slice(14, 16) || 0); }
function roundUp30(value) { return Math.ceil(value / 30) * 30; }
function timeLabel(minutes) { return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; }

function applyTicketWindows(plan, outbound, inbound) {
  if (!outbound || !inbound || !plan.itinerary.length) return;
  const first = plan.itinerary[0];
  const last = plan.itinerary.at(-1);
  const arrivalDate = outbound.arrivalTime?.slice(0, 10);
  const departureDate = inbound.departureTime?.slice(0, 10);
  const arrivalBuffer = outbound.mode === "flight" ? 120 : 60;
  const departureBuffer = inbound.mode === "flight" ? 180 : 90;
  const firstStart = arrivalDate < first.date ? 540 : arrivalDate === first.date ? roundUp30(minutesOf(outbound.arrivalTime) + arrivalBuffer) : 1440;
  const lastEnd = departureDate > last.date ? 1260 : departureDate === last.date ? minutesOf(inbound.departureTime) - departureBuffer : 0;

  for (const day of plan.itinerary) {
    let start = day === first ? Math.max(540, firstStart) : 540;
    const end = day === last ? Math.min(1260, lastEnd) : 1260;
    const available = Math.max(0, end - start);
    const count = Math.min(day.items.length, Math.floor((available + 30) / 150));
    day.items = day.items.slice(0, count).map((item, index) => ({ ...item, time: timeLabel(start + index * 150), transfer: index === 0 ? null : item.transfer }));
    if (!day.items.length) day.title = day === first ? "抵达与安顿" : "返程日";
  }
  plan.mapPoints = plan.itinerary.flatMap((day) => day.items.map((item) => item.location));
  plan.mapDays = plan.itinerary.map((day) => ({ day: day.day, date: day.date, points: day.items.map((item) => item.location) }));
  plan.scheduleAdjustment = { source: "飞猪实时班次", message: "首末日游览时段已按当前选中班次和进出站时间自动压缩。" };
}

function reconcileLocalTransit(plan) {
  if (!plan.localTransit) return;
  const pairs = new Set(plan.itinerary.flatMap((day) => day.items.slice(1).map((item, index) => `${day.items[index].name}→${item.name}`)));
  const legs = plan.localTransit.legs.filter((leg) => pairs.has(`${leg.from}→${leg.to}`));
  const known = legs.filter((leg) => leg.costPerPerson !== null);
  const total = known.length === legs.length ? Number((known.reduce((sum, leg) => sum + leg.costPerPerson, 0) * plan.travelers).toFixed(2)) : null;
  const previous = plan.localTransit.total;
  plan.localTransit = { ...plan.localTransit, legs, total, status: total === null ? "partial" : "queried" };
  for (const scenario of plan.budgetSummary.scenarios) {
    scenario.breakdown.localTransit = total;
    scenario.total += (total || 0) - (previous || 0);
    scenario.perPerson = Math.round(scenario.total / plan.travelers / 10) * 10;
  }
  plan.budgetSummary.selected = plan.budgetSummary.scenarios.find((item) => item.tier === plan.budget);
}

async function enrichPlan(plan, payload) {
  const returnDate = addDays(payload.startDate, Math.max(0, Number(payload.days) - 1));
  const localTrip = plan.transport?.pricing?.status === "not_required";
  const [outboundOptions, inboundOptions, hotels] = await Promise.all([
    localTrip ? [] : searchLeg(payload.outboundMode, payload.origin, payload.city, payload.startDate),
    localTrip ? [] : searchLeg(payload.returnMode, payload.city, payload.origin, returnDate),
    searchHotels(payload),
  ]);
  if (Number(payload.days) <= 1) plan.recommendations.hotels = [];
  const outbound = choosePracticalTicket(outboundOptions, payload.startDate, "outbound", payload.budget);
  const inbound = choosePracticalTicket(inboundOptions, returnDate, "inbound", payload.budget);
  if (plan.transport.outbound) plan.transport.outbound.options = (outbound ? [outbound, ...outboundOptions.filter((item) => item.bookingUrl !== outbound.bookingUrl)] : outboundOptions).slice(0, 5);
  if (plan.transport.inbound) plan.transport.inbound.options = (inbound ? [inbound, ...inboundOptions.filter((item) => item.bookingUrl !== inbound.bookingUrl)] : inboundOptions).slice(0, 5);
  if (outbound) Object.assign(plan.transport.outbound, outbound, { priceStatus: "live" });
  if (inbound) Object.assign(plan.transport.inbound, inbound, { priceStatus: "live" });
  if (outbound && inbound) {
    const total = (outbound.price + inbound.price) * plan.travelers;
    const checkedAt = [outbound.queriedAt, inbound.queriedAt].filter(Boolean).sort().at(-1) || new Date().toISOString();
    plan.transport.pricing = { status: "live", source: "飞猪 FlyAI", checkedAt, cacheTtlMinutes: 5, total, message: "价格来自飞猪查询，5 分钟内复用同一结果；最终以预订页为准。" };
    applyLiveBudget(plan, total);
    applyTicketWindows(plan, outbound, inbound);
    reconcileLocalTransit(plan);
  } else if (outbound || inbound) {
    const checkedAt = outbound?.queriedAt || inbound?.queriedAt || new Date().toISOString();
    plan.transport.pricing = { status: "partial", source: "飞猪 FlyAI", checkedAt, total: null, message: `${outbound ? "返程" : "去程"}实时查询暂不可用或没有符合条件的方案，暂不计入往返总价。` };
    if (!outbound && plan.transport.outbound) Object.assign(plan.transport.outbound, { priceStatus: "unavailable", note: "飞猪去程查询暂不可用或暂无符合条件的方案" });
    if (!inbound && plan.transport.inbound) Object.assign(plan.transport.inbound, { priceStatus: "unavailable", note: "飞猪返程查询暂不可用或暂无符合条件的方案" });
  } else if (!localTrip) {
    plan.transport.pricing = { status: "unavailable", source: "飞猪 FlyAI", checkedAt: null, total: null, message: "飞猪实时查询暂不可用或没有符合条件的方案，未使用任何估算票价。" };
    if (plan.transport.outbound) Object.assign(plan.transport.outbound, { priceStatus: "unavailable", note: "飞猪实时查询暂不可用或暂无符合条件的方案" });
    if (plan.transport.inbound) Object.assign(plan.transport.inbound, { priceStatus: "unavailable", note: "飞猪实时查询暂不可用或暂无符合条件的方案" });
  }
  if (hotels.length) { plan.recommendations.hotels = hotels; applyLiveHotelBudget(plan, hotels); }
  updateBudgetAdvice(plan);
  return plan;
}

async function handle(req) {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`);
  let body;
  if (url.pathname === "/api/plan" && req.method === "POST") {
    body = await new Promise((resolve, reject) => { const chunks = []; let size = 0; req.on("data", (chunk) => { size += chunk.length; if (size > 65536) { reject(new Error("请求内容过大")); req.destroy(); return; } chunks.push(chunk); }); req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject); });
  }
  const request = new Request(url, { method: req.method, headers: req.headers, body: body?.length ? body : undefined });
  let response = await worker.fetch(request, env);
  if (url.pathname === "/api/plan" && response.ok) {
    const payload = JSON.parse(body.toString("utf8"));
    const plan = await response.json();
    response = new Response(JSON.stringify(await enrichPlan(plan, payload)), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  return response;
}

const server = http.createServer(async (req, res) => {
  try {
    const response = await handle(req);
    const headers = { ...Object.fromEntries(response.headers), "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "SAMEORIGIN", "permissions-policy": "geolocation=(), camera=(), microphone=()" };
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message || "本地服务异常" }));
  }
});
server.listen(port, host, () => console.log(`行迹服务：http://${host}:${port}`));
