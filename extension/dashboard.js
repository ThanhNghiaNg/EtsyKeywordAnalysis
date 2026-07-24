import { DEFAULT_KEYWORDS } from "./default-keywords.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const number = (value) => Number(String(value ?? 0).replace(/[,$%]/g, "")) || 0;
const fmt = (value, digits = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value || 0);
const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value || 0);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

let allResults = {};

function parseKeywords(text) {
  return [...new Set(text.split(/\r?\n/)
    .map((line) => line.trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean))];
}

function parseCurl(text) {
  const url = text.match(/https?:\/\/[^'"\s]+/)?.[0];
  if (!url || !url.startsWith("https://members.erank.com/")) throw new Error("Không tìm thấy URL members.erank.com hợp lệ.");
  const headers = {};
  for (const match of text.matchAll(/(?:-H|--header)\s+(['"])([\s\S]*?)\1/g)) {
    const index = match[2].indexOf(":");
    if (index > 0) headers[match[2].slice(0, index).trim().toLowerCase()] = match[2].slice(index + 1).trim();
  }
  const bearer = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) throw new Error("Curl thiếu Authorization: Bearer.");
  const deviceId = headers["x-device-id"];
  if (!deviceId) throw new Error("Curl thiếu X-Device-Id.");
  return { url, accessToken: bearer, sourceDeviceId: deviceId, importedAt: Date.now(), registered: false };
}

function keywordMetrics(record) {
  const data = record.data || {};
  const listings = data.listings || [];
  const keyword = record.keyword.toLowerCase();
  const popular = (data.popular_tags || []).find((tag) => tag.keyword?.toLowerCase() === keyword)
    || (data.popular_tags || []).find((tag) => keyword.includes(tag.keyword?.toLowerCase()));
  const searches = number(popular?.avg_searches?.value);
  const clicks = number(popular?.avg_clicks?.value);
  const competition = number(popular?.competition?.value);
  const ctr = number(popular?.ctr?.value);
  const exactTag = listings.filter((item) => (item.tags || []).some((tag) => tag.toLowerCase() === keyword)).length;
  const titleMatch = listings.filter((item) => item.title?.toLowerCase().includes(keyword)).length;
  const views = listings.reduce((sum, item) => sum + number(item.views), 0);
  const sales = listings.reduce((sum, item) => sum + number(item.est_sales?.value), 0);
  const revenue = listings.reduce((sum, item) => sum + number(item.est_revenue?.value), 0);
  const avgPrice = listings.length ? listings.reduce((sum, item) => sum + number(item.listing_price?.value), 0) / listings.length : 0;
  const demand = Math.log10(searches + clicks + 10);
  const difficulty = Math.log10(competition + 10);
  const rawScore = 50 + (demand - difficulty * .58) * 19 + Math.min(10, ctr / 15);
  const score = Math.max(1, Math.min(100, Math.round(rawScore)));
  return { keyword: record.keyword, listings: listings.length, searches, clicks, competition, ctr, exactTag, titleMatch, views, sales, revenue, avgPrice, score, popular };
}

function metrics() {
  return Object.values(allResults).map(keywordMetrics);
}

function scoreClass(score) {
  return score >= 70 ? "" : score >= 45 ? "mid" : "low";
}

function renderOverview() {
  const rows = metrics();
  const totals = rows.reduce((sum, row) => ({
    listings: sum.listings + row.listings, views: sum.views + row.views,
    sales: sum.sales + row.sales, revenue: sum.revenue + row.revenue
  }), { listings: 0, views: 0, sales: 0, revenue: 0 });
  const best = [...rows].sort((a, b) => b.score - a.score)[0];
  $("#summaryCards").innerHTML = [
    ["Keywords", rows.length, best ? `Tốt nhất: ${escapeHtml(best.keyword)}` : "Chưa phân tích"],
    ["Listings đã quét", fmt(totals.listings), `${rows.length} thị trường tìm kiếm`],
    ["Ước tính sales", fmt(totals.sales), `${fmt(totals.views)} lượt xem`],
    ["Ước tính revenue", money(totals.revenue), "Tổng listings trong kết quả"]
  ].map(([label, value, note]) => `<div class="card"><small>${label}</small><b>${value}</b><span>${note}</span></div>`).join("");
  const chart = $("#scoreChart");
  if (!rows.length) chart.innerHTML = "Chưa có dữ liệu";
  else {
    chart.classList.remove("empty");
    chart.innerHTML = [...rows].sort((a, b) => b.score - a.score).map((row) =>
      `<div class="bar-row"><label title="${escapeHtml(row.keyword)}">${escapeHtml(row.keyword)}</label><div class="bar-track"><i style="width:${row.score}%"></i></div><b>${row.score}</b></div>`
    ).join("");
  }
  renderScatter(rows);
  $("#overviewTable").innerHTML = tableMarkup(rows.slice().sort((a, b) => b.score - a.score), true);
}

function renderScatter(rows) {
  const chart = $("#demandChart");
  if (!rows.length) { chart.innerHTML = "Chưa có dữ liệu"; return; }
  chart.classList.remove("empty");
  const xValues = rows.map((row) => Math.log10(row.competition + 1));
  const yValues = rows.map((row) => Math.log10(row.searches + 1));
  const xMax = Math.max(...xValues, 1), yMax = Math.max(...yValues, 1);
  chart.innerHTML = rows.map((row, index) => {
    const left = 5 + (xValues[index] / xMax) * 88;
    const bottom = 4 + (yValues[index] / yMax) * 84;
    const size = 23 + Math.min(23, row.clicks ? Math.log10(row.clicks + 1) * 7 : 0);
    return `<div class="bubble" title="${escapeHtml(row.keyword)} · ${fmt(row.searches)} searches · ${fmt(row.competition)} competition" style="left:${left}%;bottom:${bottom}%;width:${size}px;height:${size}px">${row.score}</div>`;
  }).join("") + '<span class="axis-label x">Competition →</span><span class="axis-label y">Search volume →</span>';
}

function tableMarkup(rows, compact = false) {
  const body = rows.map((row) => `<tr>
    <td><b>${escapeHtml(row.keyword)}</b></td>
    <td><span class="score ${scoreClass(row.score)}">${row.score}</span></td>
    <td class="num">${fmt(row.searches)}</td><td class="num">${fmt(row.clicks)}</td>
    <td class="num">${fmt(row.competition)}</td><td class="num">${fmt(row.ctr, 1)}%</td>
    ${compact ? "" : `<td class="num">${row.exactTag}/${row.listings}</td><td class="num">${row.titleMatch}/${row.listings}</td><td class="num">${money(row.revenue)}</td>`}
  </tr>`).join("");
  return `<thead><tr><th>Keyword</th><th>Score</th><th>Searches</th><th>Clicks</th><th>Competition</th><th>CTR</th>${compact ? "" : "<th>Exact tag</th><th>Title match</th><th>Est. revenue</th>"}</tr></thead><tbody>${body || '<tr><td colspan="9">Chưa có dữ liệu.</td></tr>'}</tbody>`;
}

function renderKeywordTable() {
  $("#keywordTable").innerHTML = tableMarkup(metrics().sort((a, b) => b.score - a.score));
}

function setSelectOptions(element, includeAll = false) {
  const keys = Object.keys(allResults);
  element.innerHTML = (includeAll ? '<option value="">Tất cả keywords</option>' : "") +
    keys.map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(key)}</option>`).join("");
}

function renderListings() {
  const filter = $("#listingFilter").value;
  const records = filter ? [allResults[filter]].filter(Boolean) : Object.values(allResults);
  const listings = records.flatMap((record) => (record.data?.listings || []).map((listing) => ({ ...listing, _keyword: record.keyword })))
    .sort((a, b) => number(b.est_sales?.value) - number(a.est_sales?.value)).slice(0, 100);
  $("#listingGrid").innerHTML = listings.map((item) => `<div class="listing">
    <img src="${escapeHtml(item.listing_image)}" alt="" loading="lazy">
    <div class="listing-body"><h3 title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
    <p class="muted">${escapeHtml(item.shop_name)} · ${escapeHtml(item._keyword)}</p>
    <div class="listing-meta"><div><small>SALES</small><b>${fmt(number(item.est_sales?.value))}</b></div><div><small>REVENUE</small><b>${money(number(item.est_revenue?.value))}</b></div><div><small>PRICE</small><b>$${fmt(number(item.listing_price?.value), 2)}</b></div></div></div>
  </div>`).join("") || '<div class="empty">Chưa có dữ liệu listing.</div>';
}

function renderTags() {
  const selected = $("#tagFilter").value;
  const records = selected ? [allResults[selected]].filter(Boolean) : Object.values(allResults);
  const tags = records.flatMap((record) => (record.data?.popular_tags || []).map((tag) => ({ ...tag, _source: record.keyword })));
  const deduped = new Map();
  for (const tag of tags) {
    const key = tag.keyword?.toLowerCase();
    if (!key) continue;
    const prior = deduped.get(key);
    if (!prior || number(tag.avg_searches?.value) > number(prior.avg_searches?.value)) deduped.set(key, tag);
  }
  const rows = [...deduped.values()].map((tag) => {
    const searches = number(tag.avg_searches?.value), clicks = number(tag.avg_clicks?.value), competition = number(tag.competition?.value);
    const opportunity = Math.max(1, Math.min(100, Math.round(55 + Math.log10(searches + clicks + 10) * 18 - Math.log10(competition + 10) * 11)));
    return { ...tag, searches, clicks, competition, opportunity };
  }).sort((a, b) => b.opportunity - a.opportunity || b.searches - a.searches).slice(0, 150);
  $("#tagTable").innerHTML = `<thead><tr><th>Tag</th><th>Nguồn</th><th>Opportunity</th><th>Occurrences</th><th>Searches</th><th>Clicks</th><th>Competition</th><th>CTR</th></tr></thead><tbody>${rows.map((tag) => `<tr>
    <td><b>${escapeHtml(tag.keyword)}</b></td><td>${escapeHtml(tag._source)}</td><td><span class="score ${scoreClass(tag.opportunity)}">${tag.opportunity}</span></td>
    <td class="num">${fmt(number(tag.occurences))}</td><td class="num">${fmt(tag.searches)}</td><td class="num">${fmt(tag.clicks)}</td><td class="num">${fmt(tag.competition)}</td><td class="num">${fmt(number(tag.ctr?.value), 1)}%</td>
  </tr>`).join("") || '<tr><td colspan="8">Chưa có dữ liệu tag.</td></tr>'}</tbody>`;
}

function renderAll() {
  renderOverview();
  renderKeywordTable();
  const previousListing = $("#listingFilter").value;
  const previousTag = $("#tagFilter").value;
  setSelectOptions($("#listingFilter"), true);
  setSelectOptions($("#tagFilter"), true);
  $("#listingFilter").value = previousListing;
  $("#tagFilter").value = previousTag;
  renderListings();
  renderTags();
}

function paintJob(state = {}) {
  const dot = $("#statusDot");
  dot.className = state.status === "running" ? "running" : state.status === "error" ? "error" : "";
  $("#sideStatus").textContent = state.status === "running" ? `${state.current || 0}/${state.total || 0} · ${state.message}` :
    state.status === "error" ? "Có lỗi cần xử lý" : state.status === "done" ? "Phân tích hoàn tất" : "Sẵn sàng";
  $("#runBtn").disabled = state.status === "running";
  const notice = $("#notice");
  if (state.status === "running" || state.status === "error") {
    notice.hidden = false;
    notice.className = state.status === "error" ? "notice error" : "notice";
    notice.textContent = state.message;
  } else notice.hidden = true;
}

async function loadState() {
  const stored = await chrome.storage.local.get(["keywords", "results", "apiConfig", "jobState"]);
  allResults = stored.results || {};
  $("#keywordInput").value = (stored.keywords?.length ? stored.keywords : DEFAULT_KEYWORDS).join("\n");
  $("#configState").textContent = stored.apiConfig?.accessToken
    ? `Đã nhập curl lúc ${new Date(stored.apiConfig.importedAt || Date.now()).toLocaleString("vi-VN")}.`
    : "Chưa nhập curl. Extension sẽ thử dùng phiên đăng nhập eRank trong trình duyệt.";
  paintJob(stored.jobState);
  renderAll();
}

$$("nav button").forEach((button) => button.addEventListener("click", () => {
  $$("nav button").forEach((item) => item.classList.toggle("active", item === button));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === button.dataset.view));
  $("#pageTitle").textContent = ({
    overview: "Tổng quan SEO", keywords: "So sánh keyword", listings: "Benchmark listings",
    tags: "Cơ hội tag", settings: "Cấu hình phân tích"
  })[button.dataset.view];
}));

$("#keywordFile").addEventListener("change", async (event) => { $("#keywordInput").value = await event.target.files[0].text(); });
$("#curlFile").addEventListener("change", async (event) => { $("#curlInput").value = await event.target.files[0].text(); });
$("#saveKeywords").addEventListener("click", async () => {
  const keywords = parseKeywords($("#keywordInput").value);
  await chrome.storage.local.set({ keywords });
  $("#notice").hidden = false; $("#notice").className = "notice"; $("#notice").textContent = `Đã lưu ${keywords.length} keywords.`;
});
$("#saveCurl").addEventListener("click", async () => {
  try {
    const apiConfig = parseCurl($("#curlInput").value);
    await chrome.storage.local.set({ apiConfig });
    $("#curlInput").value = "";
    $("#configState").textContent = "Đã lưu cấu hình curl cục bộ. Sẵn sàng tạo phiên ký mới.";
    $("#notice").hidden = false; $("#notice").className = "notice"; $("#notice").textContent = "Curl hợp lệ đã được lưu.";
  } catch (error) {
    $("#notice").hidden = false; $("#notice").className = "notice error"; $("#notice").textContent = error.message;
  }
});
$("#runBtn").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "START_ANALYSIS" });
  if (!response?.ok) { $("#notice").hidden = false; $("#notice").className = "notice error"; $("#notice").textContent = response?.error; }
});
$("#clearResults").addEventListener("click", async () => {
  if (!confirm("Xóa toàn bộ kết quả phân tích đã lưu?")) return;
  await chrome.storage.local.remove("results");
  allResults = {}; renderAll();
});
$("#listingFilter").addEventListener("change", renderListings);
$("#tagFilter").addEventListener("change", renderTags);
$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(allResults, null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
  link.download = `etsy-seo-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.jobState) paintJob(changes.jobState.newValue);
  if (changes.results) { allResults = changes.results.newValue || {}; renderAll(); }
});
loadState();
