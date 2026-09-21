const form = document.querySelector("#planner-form");
const result = document.querySelector("#result");
const submit = form.querySelector("button[type=submit]");
const buttonLabel = submit.querySelector(".button-label");
const dateInput = document.querySelector("#start-date");
const favoritesKey = "xingji-favorites-v1";
let currentPlan = null;

const localDateValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const today = new Date();
const tomorrow = new Date(today);
tomorrow.setDate(tomorrow.getDate() + 1);
dateInput.value = localDateValue(tomorrow);
dateInput.min = localDateValue(today);

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('\"', "&quot;").replaceAll("'", "&#039;");
const dateLabel = (date) => new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date(`${date}T12:00:00`));
const money = (value) => `¥${Number(value || 0).toLocaleString("zh-CN")}`;
const mapUrl = (poi) => `https://uri.amap.com/marker?position=${encodeURIComponent(poi.location)}&name=${encodeURIComponent(poi.name)}&src=travel-planner&coordinate=gaode&callnative=1`;
const safeExternalUrl = (value) => { try { const url = new URL(value); return url.protocol === "https:" ? url.href : "#"; } catch { return "#"; } };

function getFavorites() {
  try { const value = JSON.parse(localStorage.getItem(favoritesKey) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}
function favoriteId(item) { return item.id || `${item.name}-${item.location}`; }
function isFavorite(item) { return getFavorites().some((saved) => saved.favoriteId === favoriteId(item)); }
function toggleFavorite(item, kind, button) {
  const id = favoriteId(item);
  const favorites = getFavorites();
  const index = favorites.findIndex((saved) => saved.favoriteId === id);
  if (index >= 0) favorites.splice(index, 1);
  else favorites.push({ favoriteId: id, kind, name: item.name, location: item.location, address: item.address, rating: item.rating });
  localStorage.setItem(favoritesKey, JSON.stringify(favorites));
  button.classList.toggle("saved", index < 0);
  button.textContent = index < 0 ? "♥" : "♡";
  renderFavoriteCount();
}
function renderFavoriteCount() {
  const count = getFavorites().length;
  document.querySelectorAll("[data-favorite-count]").forEach((node) => { node.textContent = count; });
}

function weatherChart(items) {
  if (!items.length) return `<section class="weather-panel weather-unavailable"><div class="panel-title"><div><small>WEATHER OUTLOOK</small><h3>天气趋势</h3></div></div><div class="empty-state"><b>尚未进入天气预报窗口</b><p>${escapeHtml(currentPlan?.weatherStatus?.message || "请临近出发日期时重新生成行程。")}</p></div></section>`;
  const width = 700, height = 180, padX = 45, padY = 32;
  const values = items.flatMap((item) => [item.dayTemp, item.nightTemp]);
  const min = Math.min(...values) - 2, max = Math.max(...values) + 2;
  const x = (i) => items.length === 1 ? width / 2 : padX + i * ((width - padX * 2) / (items.length - 1));
  const y = (value) => padY + (max - value) * ((height - padY * 2) / Math.max(1, max - min));
  const path = (field) => items.map((item, i) => `${i ? "L" : "M"}${x(i)},${y(item[field])}`).join(" " );
  return `<section class="weather-panel"><div class="panel-title"><div><small>WEATHER OUTLOOK</small><h3>天气趋势</h3></div><div class="weather-legend"><span><i class="day-line"></i>日间</span><span><i class="night-line"></i>夜间</span></div></div><div class="weather-chart-wrap"><svg class="weather-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="未来天气温度折线图"><line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" class="chart-axis"/><path d="${path("dayTemp")}" class="temp-day"/><path d="${path("nightTemp")}" class="temp-night"/>${items.map((item, i) => `<g><circle cx="${x(i)}" cy="${y(item.dayTemp)}" r="5" class="dot-day"/><circle cx="${x(i)}" cy="${y(item.nightTemp)}" r="4" class="dot-night"/><text x="${x(i)}" y="${y(item.dayTemp) - 11}" class="chart-value">${item.dayTemp}°</text><text x="${x(i)}" y="${height - 8}" class="chart-date">${dateLabel(item.date).replace("星期", "周")}</text></g>`).join("")}</svg></div><div class="weather-summaries">${items.map((item) => `<span><b>${escapeHtml(item.dayWeather)}</b><small>${escapeHtml(item.wind)}风 ${escapeHtml(item.power)}级</small></span>`).join("")}</div></section>`;
}

function transportPanel(data) {
  const t = data.transport;
  if (!t) return "";
  if (t.localTrip) return `<section class="transport-panel"><div class="panel-title"><div><small>LOCAL TRIP</small><h3>同城出行</h3></div><strong class="live-status"><i></i>无需跨城票务</strong></div><div class="route-cities"><span>${escapeHtml(data.origin)}</span><i>→</i><span>${escapeHtml(data.formattedAddress)}</span></div><p class="estimate-note">${escapeHtml(t.pricing.message)}页面仅计算行程内高德公交路线。</p></section>`;
  const option = (item, selected) => `<a class="ticket-option ${selected ? "selected" : ""}" href="${escapeHtml(safeExternalUrl(item.bookingUrl))}" target="_blank" rel="noopener noreferrer"><span><b>${selected ? "当前 · " : ""}${escapeHtml(item.transportNo || item.carrier)}</b><small>${escapeHtml(item.departureTime?.slice(11, 16))} → ${escapeHtml(item.arrivalTime?.slice(11, 16))}</small></span><strong>${money(item.price)}</strong></a>`;
  const leg = (label, value, arrow) => {
    const live = value.priceStatus === "live";
    return `<div class="transport-leg"><span>${label}</span><b>${escapeHtml(value.label)}</b><p>${arrow} ${value.distanceKm} km · ${live ? `${escapeHtml(value.departureStation)} → ${escapeHtml(value.arrivalStation)}` : `参考耗时 ${value.hours} 小时`}</p>${live ? `<strong class="live-price">${money(value.price)}/人</strong><small>${escapeHtml(value.transportNo)} · ${escapeHtml(value.seatClass)} · ${value.durationMinutes} 分钟</small><div class="ticket-options">${value.options.slice(0, 3).map((item) => option(item, item.bookingUrl === value.bookingUrl)).join("")}</div>` : `<strong class="price-unavailable">${value.priceStatus === "unavailable" ? "实时票价暂不可用" : "此方式暂无直连票价"}</strong><small>${escapeHtml(value.note)}</small><a href="${escapeHtml(safeExternalUrl(value.queryUrl))}" target="_blank" rel="noopener noreferrer">打开官方查询 ↗</a>`}</div>`;
  };
  const live = t.pricing.status === "live";
  const checkedAt = live ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(t.pricing.checkedAt)) : "";
  const statusLabel = live ? `飞猪查询价 · ${checkedAt}` : t.pricing.status === "partial" ? "部分实时结果" : "实时查询暂不可用";
  return `<section class="transport-panel"><div class="panel-title"><div><small>ROUND TRIP</small><h3>往返交通</h3></div><strong class="live-status ${live ? "" : "offline"}"><i></i>${statusLabel}</strong></div><div class="route-cities"><span>${escapeHtml(data.origin)}</span><i>↔</i><span>${escapeHtml(data.formattedAddress)}</span></div><div class="transport-legs">${leg("去程", t.outbound, "→")}${leg("返程", t.inbound, "←")}</div><p class="estimate-note ${live ? "" : "warning-note"}">${escapeHtml(t.pricing.message)}</p></section>`;
}

function budgetPanel(data) {
  const selected = data.budgetSummary.selected;
  const b = selected.breakdown;
  const rows = [["住宿", b.accommodation], ["餐饮", b.food], ["市内公交", b.localTransit], ["门票体验", b.tickets]];
  const numericRows = rows.filter((row) => row[1] !== null);
  const max = Math.max(...numericRows.map((row) => row[1]), 1);
  const includesTransport = !selected.excludesIntercityTransport;
  return `<section class="budget-panel"><div class="panel-title"><div><small>${includesTransport ? "TRIP BUDGET" : "ON-SITE BUDGET"}</small><h3>${includesTransport ? "全程预算" : "在地预算"}</h3></div><div class="budget-total"><small>${includesTransport ? "含当前飞猪往返方案" : "不含跨城往返交通"}</small><b>${money(selected.total)}</b><span>人均 ${money(selected.perPerson)}</span></div></div><div class="budget-bars">${rows.map(([label, value]) => `<div><span>${label}</span><i><b style="width:${value === null ? 0 : Math.max(3, value / max * 100)}%"></b></i><strong>${value === null ? "待查询" : money(value)}</strong></div>`).join("")}</div><div class="live-cost-source"><i></i>市内公交费用来自${escapeHtml(data.localTransit.source)} · ${data.localTransit.status === "queried" ? "已查询" : "部分路线暂无费用"}</div><div class="budget-switcher"><p>${escapeHtml(data.budgetSummary.advice)}</p><div>${data.budgetSummary.scenarios.map((scenario) => `<button type="button" data-budget-tier="${scenario.tier}" class="${scenario.tier === data.budget ? "active" : ""}"><b>${scenario.label}</b><span>${money(scenario.total)}</span></button>`).join("")}</div></div><small class="estimate-note">${escapeHtml(selected.assumptions)}。住宿采用推荐列表最低实时起价；餐饮与门票为规划参考。</small></section>`;
}

function recommendationCards(items, kind) {
  return items.map((item) => `<article class="recommend-card"><button class="favorite-button ${isFavorite(item) ? "saved" : ""}" data-favorite-id="${escapeHtml(favoriteId(item))}" aria-label="收藏${escapeHtml(item.name)}">${isFavorite(item) ? "♥" : "♡"}</button><div class="recommend-icon">${kind === "hotel" ? "▤" : "♨"}</div><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.businessArea || item.address || "市区")}</p><footer><span>${item.rating ? `★ ${escapeHtml(item.rating)}` : item.live ? "飞猪查询房源" : "暂无评分"}</span><b>${escapeHtml(item.priceEstimate)}</b></footer><a href="${escapeHtml(safeExternalUrl(item.detailUrl || mapUrl(item)))}" target="_blank" rel="noopener noreferrer">${item.detailUrl ? "飞猪预订" : "查看地图"} ↗</a></article>`).join("");
}

function routeMap(data) {
  if (!data.mapPoints.length) return `<section class="map-panel"><div class="panel-title"><div><small>INTERACTIVE ROUTE</small><h3>交互地图</h3></div></div><div class="empty-state"><b>当前班次没有可绘制的游览路线</b><p>请调整交通班次或增加旅行天数。</p></div></section>`;
  return `<section class="map-panel"><div class="panel-title"><div><small>INTERACTIVE ROUTE</small><h3>交互地图</h3></div><span>${data.mapPoints.length} 个行程点</span></div><div id="route-map" class="map-frame" aria-label="${escapeHtml(data.city)}交互路线地图"><div class="map-loading">正在加载分日路线…</div></div><div class="map-day-legend">${data.mapDays.map((day) => `<span><i class="day-color-${day.day}"></i>第 ${day.day} 天</span>`).join("")}</div><p class="estimate-note">可拖拽、缩放并点击编号标记查看地点；仅连接同一天内的景点，不跨夜连线。</p></section>`;
}

async function initInteractiveMap(data) {
  const container = document.querySelector("#route-map");
  if (!container || !window.L) { if (container) container.innerHTML = '<div class="map-loading">交互地图库加载失败，请刷新重试。</div>'; return; }
  const allItems = data.itinerary.flatMap((day) => day.items);
  try {
    const routeDays = await Promise.all(data.mapDays.filter((day) => day.points.length).map(async (day) => {
      if (day.points.length < 2) return { ...day, route: day.points };
      const response = await fetch(`/api/route?points=${encodeURIComponent(day.points.join(";"))}`);
      const routeData = await response.json();
      if (!response.ok) throw new Error(routeData.error || "路线加载失败");
      return { ...day, route: routeData.route };
    }));
    container.innerHTML = "";
    const center = data.center.split(",").map(Number);
    const map = L.map(container, { zoomControl: true }).setView([center[1], center[0]], 12);
    L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?style=7&lang=zh_cn&size=1&scale=1&x={x}&y={y}&z={z}', { subdomains: ['1','2','3','4'], maxZoom: 18, attribution: '© 高德地图' }).addTo(map);
    const colors = ['#e85f2a', '#377d73', '#9c692c', '#6d5795', '#b7435a'];
    const bounds = L.latLngBounds([]);
    routeDays.forEach((day, index) => {
      const latLngs = day.route.map((point) => { const [lng, lat] = point.split(",").map(Number); return [lat, lng]; });
      if (latLngs.length > 1) L.polyline(latLngs, { color: colors[index % colors.length], weight: 5, opacity: .88 }).addTo(map);
      latLngs.forEach((point) => bounds.extend(point));
    });
    allItems.forEach((item, index) => {
      const [lng, lat] = item.location.split(",").map(Number);
      const dayIndex = data.itinerary.findIndex((day) => day.items.some((candidate) => candidate.id === item.id));
      const stopIndex = data.itinerary[dayIndex]?.items.findIndex((candidate) => candidate.id === item.id) ?? index;
      const icon = L.divIcon({ className: 'route-marker-wrap', html: `<span class="route-marker" style="background:${colors[dayIndex % colors.length]}">${dayIndex + 1}-${stopIndex + 1}</span>`, iconSize: [34, 30], iconAnchor: [17, 15] });
      L.marker([lat, lng], { icon }).addTo(map).bindPopup(`<b>${escapeHtml(item.name)}</b><br>第 ${dayIndex + 1} 天 · ${escapeHtml(item.type)}<br><a href="${mapUrl(item)}" target="_blank" rel="noopener noreferrer">高德详情 ↗</a>`);
      bounds.extend([lat, lng]);
    });
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
    window.__travelMap = map;
  } catch (error) { container.innerHTML = `<div class="map-loading">${escapeHtml(error.message)}</div>`; }
}

function renderDays(data) {
  return data.itinerary.map((day) => `<article class="day-card"><header class="day-head"><span class="day-number">0${day.day}</span><h3>${escapeHtml(day.title)}</h3><small>${escapeHtml(dateLabel(day.date))}</small></header><div class="timeline">${day.items.length ? day.items.map((item) => `<div class="stop"><time class="stop-time">${escapeHtml(item.time)}</time><span class="stop-marker"></span><div class="stop-main"><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.type)} · 建议停留 ${escapeHtml(item.stay)}${item.rating ? ` · 评分 ${escapeHtml(item.rating)}` : ""}</p>${item.transfer ? `<p class="transfer">↳ 从上一站约 ${item.transfer.distance.toFixed(1)} km · 建议${escapeHtml(item.transfer.mode)} ${item.transfer.minutes} 分钟</p>` : ""}</div><div class="stop-actions"><button class="favorite-button ${isFavorite(item) ? "saved" : ""}" data-favorite-id="${escapeHtml(favoriteId(item))}" aria-label="收藏${escapeHtml(item.name)}">${isFavorite(item) ? "♥" : "♡"}</button><a class="map-link" href="${mapUrl(item)}" target="_blank" rel="noopener noreferrer">地图 ↗</a></div></div>`).join("") : `<div class="day-empty"><b>当前班次没有留出可用游览时间</b><p>建议延长行程、提前抵达或选择更晚返程。</p></div>`}</div></article>`).join("");
}

function bindResultActions(data) {
  result.querySelector(".regenerate")?.addEventListener("click", () => document.querySelector("#planner").scrollIntoView());
  result.querySelectorAll("[data-budget-tier]").forEach((button) => button.addEventListener("click", () => {
    form.querySelector(`[name=budget][value=${button.dataset.budgetTier}]`).checked = true;
    form.requestSubmit();
  }));
  const allItems = [...data.itinerary.flatMap((day) => day.items), ...data.recommendations.restaurants, ...data.recommendations.hotels];
  result.querySelectorAll("[data-favorite-id]").forEach((button) => {
    const item = allItems.find((candidate) => favoriteId(candidate) === button.dataset.favoriteId);
    if (item) button.addEventListener("click", () => toggleFavorite(item, "place", button));
  });
}

function renderPlan(data) {
  currentPlan = data;
  const hotelSection = data.days > 1 ? `<div class="recommend-section"><div class="panel-title"><div><small>STAY WELL</small><h3>住宿推荐</h3></div><span>飞猪实时起价 · 以预订页为准</span></div><div class="recommend-grid">${recommendationCards(data.recommendations.hotels, "hotel")}</div></div>` : "";
  const scheduleNotice = data.scheduleAdjustment ? `<div class="schedule-notice"><b>已按实时班次调整日程</b><span>${escapeHtml(data.scheduleAdjustment.message)}</span></div>` : "";
  result.innerHTML = `<div class="result-inner"><header class="result-top"><div><p class="eyebrow"><span></span> YOUR JOURNEY</p><h2>${escapeHtml(data.city)} · ${data.days} 日行迹</h2><p>${escapeHtml(data.origin)} → ${escapeHtml(data.formattedAddress)} · ${data.travelers} 人同行</p></div><div class="result-actions"><span class="favorite-counter">已收藏 <b data-favorite-count>0</b></span><button class="regenerate" type="button">调整条件</button></div></header>${weatherChart(data.weather)}<div class="overview-grid">${transportPanel(data)}${budgetPanel(data)}</div>${scheduleNotice}${routeMap(data)}<div class="recommend-section"><div class="panel-title"><div><small>LOCAL PICKS</small><h3>美食推荐</h3></div><span>按当前预算筛选</span></div><div class="recommend-grid">${recommendationCards(data.recommendations.restaurants, "food")}</div></div>${hotelSection}<div class="journey-title"><small>DAILY ITINERARY</small><h3>逐日安排</h3></div>${renderDays(data)}<aside class="tips"><h3>出发前提醒</h3><ul>${data.tips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join("")}</ul></aside></div>`;
  result.hidden = false;
  renderFavoriteCount();
  bindResultActions(data);
  initInteractiveMap(data);
  result.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderError(message) {
  result.innerHTML = `<div class="error-card"><p class="eyebrow"><span></span> SOMETHING WENT WRONG</p><h3>这次没有顺利成行</h3><p>${escapeHtml(message)}</p><button type="button">返回修改</button></div>`;
  result.hidden = false;
  result.querySelector("button").addEventListener("click", () => document.querySelector("#planner").scrollIntoView());
  result.scrollIntoView({ behavior: "smooth" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const payload = {
    origin: formData.get("origin"), city: formData.get("city"), startDate: formData.get("startDate"), days: Number(formData.get("days")), travelers: Number(formData.get("travelers")),
    outboundMode: formData.get("outboundMode"), returnMode: formData.get("returnMode"), budgetLimit: Number(formData.get("budgetLimit")),
    interests: formData.getAll("interests"), pace: formData.get("pace"), budget: formData.get("budget"),
  };
  submit.disabled = true;
  buttonLabel.innerHTML = `正在寻找灵感<span class="loading-dot">…</span>`;
  try {
    const response = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "暂时无法生成计划");
    renderPlan(data);
  } catch (error) { renderError(error.message); }
  finally { submit.disabled = false; buttonLabel.textContent = "生成我的旅行计划"; }
});

renderFavoriteCount();
