import puppeteer from "puppeteer-core";
import { AxePuppeteer } from "@axe-core/puppeteer";

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-first-run", "--disable-gpu"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:8787/", { waitUntil: "networkidle0" });
  await page.evaluate(() => {
    const set = (selector, value) => { const input = document.querySelector(selector); input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); };
    set("#origin", "北京"); set("#city", "杭州"); set("#budget-limit", "5000");
    const date = new Date(); date.setDate(date.getDate() + 4); set("#start-date", `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);
  });
  await page.select("#days", "2");
  await page.select("#travelers", "2");
  await page.select("#outbound-mode", "train");
  await page.select("#return-mode", "flight");
  await Promise.all([
    page.click("button[type=submit]"),
    page.waitForResponse((response) => response.url().endsWith("/api/plan") && response.status() === 200),
  ]);
  await page.waitForSelector(".day-card", { timeout: 20000 });
  await page.waitForSelector("#route-map .leaflet-container, #route-map .leaflet-pane", { timeout: 20000 });

  const favoriteButton = await page.$(".recommend-card .favorite-button");
  await favoriteButton.click();
  await page.reload({ waitUntil: "networkidle0" });
  const persistedFavorites = await page.evaluate(() => JSON.parse(localStorage.getItem("xingji-favorites-v1") || "[]").length);
  if (persistedFavorites !== 1) throw new Error("收藏没有持久化");

  await page.evaluate(() => {
    const set = (selector, value) => { const input = document.querySelector(selector); input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); };
    set("#origin", "北京"); set("#city", "杭州"); set("#budget-limit", "5000");
    const date = new Date(); date.setDate(date.getDate() + 4); set("#start-date", `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);
    document.querySelector('[name=budget][value=comfort]').checked = true;
  });
  await page.select("#days", "2"); await page.select("#travelers", "2"); await page.select("#outbound-mode", "train"); await page.select("#return-mode", "flight");
  await Promise.all([page.click("button[type=submit]"), page.waitForResponse((response) => response.url().endsWith("/api/plan") && response.status() === 200)]);
  await page.waitForSelector(".day-card");
  await page.waitForSelector("#route-map .leaflet-pane", { timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll("#route-map .leaflet-tile-loaded")].some((image) => image.naturalWidth > 0), { timeout: 20000 });
  await page.screenshot({ path: "/tmp/travel-planner-v2.png", fullPage: true });

  const summary = await page.evaluate(() => ({
    title: document.title, heading: document.querySelector(".result-top h2")?.textContent.trim(),
    days: document.querySelectorAll(".day-card").length, stops: document.querySelectorAll(".stop").length,
    weatherChart: Boolean(document.querySelector(".weather-chart .temp-day")), weatherUnavailable: Boolean(document.querySelector(".weather-unavailable")), weatherPoints: document.querySelectorAll(".dot-day").length,
    transportLegs: document.querySelectorAll(".transport-leg").length, budgetTiers: document.querySelectorAll("[data-budget-tier]").length,
    restaurants: document.querySelectorAll(".recommend-section:nth-of-type(5) .recommend-card").length,
    recommendationCards: document.querySelectorAll(".recommend-card").length,
    mapLoaded: [...document.querySelectorAll("#route-map .leaflet-tile-loaded")].some((image) => image.naturalWidth > 0), mapMarkers: document.querySelectorAll(".route-marker").length,
    transportPriceText: document.querySelector(".live-price")?.textContent.trim(), pricingUnavailable: document.querySelectorAll(".price-unavailable").length, liveTickets: document.querySelectorAll(".ticket-option").length,
    favoriteCount: Number(document.querySelector("[data-favorite-count]")?.textContent || 0),
    errorVisible: Boolean(document.querySelector(".error-card")),
  }));
  const pricingRendered = summary.transportPriceText?.startsWith("¥") && summary.liveTickets >= 6 || summary.pricingUnavailable === 2 && summary.liveTickets === 0;
  const weatherRendered = summary.weatherChart && summary.weatherPoints >= 1 || summary.weatherUnavailable;
  if (summary.days !== 2 || summary.stops < 1 || !weatherRendered || summary.transportLegs !== 2 || summary.budgetTiers !== 3 || summary.recommendationCards < 4 || !summary.mapLoaded || summary.mapMarkers !== summary.stops || !pricingRendered || summary.favoriteCount !== 1 || summary.errorVisible || errors.length) throw new Error(JSON.stringify({ summary, errors }));
  const budgetBefore = await page.$eval(".budget-total b", (node) => node.textContent);
  await Promise.all([
    page.click('[data-budget-tier="value"]'),
    page.waitForResponse((response) => response.url().endsWith("/api/plan") && response.status() === 200),
  ]);
  await page.waitForFunction(() => document.querySelector('[data-budget-tier="value"]')?.classList.contains("active"));
  const budgetAfter = await page.$eval(".budget-total b", (node) => node.textContent);
  const budgetAdjusted = budgetBefore !== budgetAfter;
  if (!budgetAdjusted) throw new Error("预算档位切换后总价未变化");

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.screenshot({ path: "/tmp/travel-planner-v2-mobile.png", fullPage: true });
  const mobile = await page.evaluate(() => ({ viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth, noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1 }));
  if (!mobile.noHorizontalOverflow) throw new Error(JSON.stringify({ mobile }));
  const accessibility = await new AxePuppeteer(page).analyze();
  const seriousA11y = accessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact));
  if (seriousA11y.length) throw new Error(JSON.stringify({ accessibility: seriousA11y.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.length })) }));
  console.log(JSON.stringify({ ok: true, ...summary, persistedFavorites, budgetAdjusted, budgetBefore, budgetAfter, mobile, accessibilityViolations: accessibility.violations.length, seriousAccessibilityViolations: seriousA11y.length, consoleErrors: errors }, null, 2));
} finally {
  await browser.close();
}
