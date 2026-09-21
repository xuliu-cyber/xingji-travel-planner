import assert from "node:assert/strict";

const endpoint = "http://127.0.0.1:8787/api/plan";
const dateFromToday = (offset) => { const value = new Date(); value.setDate(value.getDate() + offset); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; };
const base = { origin: "北京", city: "杭州", startDate: dateFromToday(4), days: 2, travelers: 2, outboundMode: "train", returnMode: "flight", interests: ["culture", "nature"], pace: "balanced", budget: "comfort" };

async function post(overrides, expectedStatus = 200) {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, ...overrides }) });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return body;
}

const oneDay = await post({ days: 1 });
assert.equal(oneDay.budgetSummary.selected.breakdown.accommodation, 0);
assert.equal(oneDay.recommendations.hotels.length, 0);
assert.equal(oneDay.budgetSummary.hotelPricing, undefined);

const sameCity = await post({ origin: "杭州市西湖区", city: "杭州", travelers: 1, outboundMode: "auto", returnMode: "auto" });
assert.equal(sameCity.transport.localTrip, true);
assert.equal(sameCity.transport.pricing.status, "not_required");
assert.equal(sameCity.transport.pricing.total, 0);

const slow = await post({ pace: "slow" });
assert.deepEqual(slow.itinerary.map((day) => day.items.length), [2, 2]);

const farFuture = await post({ startDate: dateFromToday(30), days: 3 });
assert.equal(farFuture.weather.length, 0);
assert.equal(farFuture.weatherStatus.status, "unavailable");

const past = await post({ startDate: dateFromToday(-1) }, 400);
assert.match(past.error, /不能早于今天/);
const invalidDate = await post({ startDate: "2026-02-31" }, 400);
assert.match(invalidDate.error, /有效日期/);

const normal = await post({});
assert.ok(["live", "partial", "unavailable"].includes(normal.transport.pricing.status));
if (normal.transport.pricing.status === "live") {
  assert.ok(normal.transport.outbound.options.length >= 3);
  assert.equal(normal.transport.outbound.options[0].bookingUrl, normal.transport.outbound.bookingUrl);
  assert.equal(normal.budgetSummary.hotelPricing.status, "live");
  assert.equal(normal.budgetSummary.selected.breakdown.accommodation, normal.budgetSummary.hotelPricing.total);
  const expectedTransit = normal.localTransit.legs.reduce((sum, leg) => sum + leg.costPerPerson, 0) * normal.travelers;
  assert.equal(normal.budgetSummary.selected.breakdown.localTransit, expectedTransit);
} else if (normal.transport.pricing.status === "unavailable") {
  assert.equal(normal.transport.outbound.price, null);
  assert.equal(normal.transport.inbound.price, null);
} else {
  assert.ok(normal.transport.outbound.price !== null || normal.transport.inbound.price !== null);
}
assert.equal(normal.mapDays.length, normal.days);
assert.equal(normal.itinerary.length, normal.days);
if (normal.transport.pricing.status === "live") assert.ok(normal.scheduleAdjustment);
for (const day of normal.itinerary) {
  for (let index = 1; index < day.items.length; index += 1) assert.ok(day.items[index].time > day.items[index - 1].time);
}

console.log(JSON.stringify({ ok: true, externalPricing: normal.transport.pricing.status, cases: ["one-day", "same-city", "slow-pace", "far-future-weather", "past-date", "invalid-date", "pricing-degradation"] }, null, 2));
