import { DEFAULT_KEYWORDS } from "./default-keywords.js";
import {
  clearAnalysisResults,
  getAllAnalysisResults,
  migrateLegacyResults
} from "./data-store.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const number = (value) => Number(String(value ?? 0).replace(/[,$%]/g, "")) || 0;
const fmt = (value, digits = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value || 0);
const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value || 0);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const HEADER_TOOLTIPS = {
  keyword: `Từ khóa gốc được dùng để mở trang tìm kiếm Etsy và lấy dữ liệu thị trường.

Ảnh hưởng SEO: Xác định cụm truy vấn mà title và tags cần liên quan. Từ khóa đúng ý định mua giúp listing xuất hiện trước đúng nhóm khách hàng và hỗ trợ chuyển đổi.`,
  score: `Điểm Opportunity 1–100 do extension tự tính từ Searches, Clicks, Competition và CTR; đây không phải chỉ số chính thức của Etsy hoặc eRank.

Ảnh hưởng SEO: Điểm cao gợi ý nhu cầu tốt so với cạnh tranh. Nó giúp ưu tiên keyword để thử nghiệm, nhưng không đảm bảo thứ hạng hoặc doanh số.`,
  searches: `Số lượt tìm kiếm trung bình của keyword theo dữ liệu eRank.

Ảnh hưởng SEO: Search cao cho thấy nhu cầu lớn và tiềm năng impressions cao hơn. Tuy nhiên, chuyển đổi chỉ tốt khi keyword khớp chính xác sản phẩm và ý định mua.`,
  clicks: `Số lượt click trung bình phát sinh từ các lượt tìm kiếm keyword theo dữ liệu eRank.

Ảnh hưởng SEO: Click cao cho thấy kết quả tìm kiếm tạo được sự quan tâm. Thumbnail, title, giá và độ liên quan quyết định listing có nhận được phần click và chuyển đổi hay không.`,
  competition: `Số lượng listing cạnh tranh cho keyword theo dữ liệu eRank.

Ảnh hưởng SEO: Competition cao thường khiến việc đạt vị trí nổi bật khó hơn. Thị trường ngách cạnh tranh thấp có thể dễ lấy impressions và đơn hàng hơn nếu vẫn có đủ nhu cầu.`,
  ctr: `Tỷ lệ Clicks so với Searches. Chỉ số có thể vượt 100% khi một lượt tìm kiếm tạo nhiều click.

Ảnh hưởng SEO: CTR cao thể hiện người tìm kiếm thường tương tác với kết quả. Đây là tín hiệu về ý định và sức hút thị trường, nhưng không đồng nghĩa trực tiếp với tỷ lệ mua hàng.`,
  exactTag: `Số listing trong mẫu kết quả sử dụng chính xác keyword trong danh sách tags, hiển thị theo dạng số khớp / tổng listing.

Ảnh hưởng SEO: Tỷ lệ cao cho thấy đối thủ xem keyword là tag quan trọng và mức tối ưu trực tiếp cao. Điều này tăng độ liên quan nhưng cũng báo hiệu cạnh tranh SEO mạnh hơn.`,
  titleMatch: `Số listing trong mẫu có chứa nguyên cụm keyword trong title, hiển thị theo dạng số khớp / tổng listing.

Ảnh hưởng SEO: Title match giúp Etsy và người mua hiểu nhanh độ liên quan. Title tự nhiên, đúng sản phẩm có thể cải thiện click và chuyển đổi; nhồi từ khóa có thể làm title khó đọc và giảm click.`,
  revenue: `Tổng doanh thu ước tính của các listing được phân tích cho keyword, dựa trên dữ liệu eRank.

Ảnh hưởng SEO: Không tác động trực tiếp tới thứ hạng. Nó phản ánh giá trị thương mại và bằng chứng chuyển đổi của thị trường; đây là số ước tính, không phải doanh thu xác nhận.`,
  tag: `Cụm từ liên quan xuất hiện trong tags của các listing thuộc kết quả phân tích.

Ảnh hưởng SEO: Tag sát sản phẩm giúp Etsy kết nối listing với nhiều truy vấn liên quan. Chỉ dùng tag phù hợp ý định; tag rộng nhưng không liên quan có thể tạo traffic kém chuyển đổi.`,
  source: `Keyword gốc mà từ đó extension phát hiện tag liên quan.

Ảnh hưởng SEO: Không phải chỉ số xếp hạng. Nó cung cấp ngữ cảnh để đánh giá tag có thực sự liên quan tới thị trường và sản phẩm mục tiêu hay không.`,
  tagOpportunity: `Điểm 1–100 do extension tự tính cho tag từ Searches, Clicks và Competition.

Ảnh hưởng SEO: Điểm cao gợi ý tag có nhu cầu tốt so với cạnh tranh. Cần kết hợp độ liên quan sản phẩm vì traffic sai ý định thường không tạo chuyển đổi.`,
  occurrences: `Số lần tag xuất hiện trong các listing thuộc mẫu kết quả eRank.

Ảnh hưởng SEO: Occurrences cao cho thấy tag phổ biến và đã được nhiều đối thủ xác nhận. Đồng thời, nó có thể báo hiệu mức cạnh tranh tối ưu cao hơn; không nên sao chép nếu tag không đúng sản phẩm.`
};

function headerCell(label, tooltipKey, numeric = false) {
  const tooltip = HEADER_TOOLTIPS[tooltipKey] || "";
  return `<th class="${numeric ? "num" : ""}" tabindex="0" data-tooltip="${escapeHtml(tooltip)}"><span>${escapeHtml(label)}</span><i class="info-icon" aria-hidden="true">i</i></th>`;
}

let allResults = {};

async function reloadResults() {
  const records = await getAllAnalysisResults();
  allResults = Object.fromEntries(records.map((record) => [record.keyword, record]));
  renderAll();
}

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
    <td class="num"><span class="score ${scoreClass(row.score)}">${row.score}</span></td>
    <td class="num">${fmt(row.searches)}</td><td class="num">${fmt(row.clicks)}</td>
    <td class="num">${fmt(row.competition)}</td><td class="num">${fmt(row.ctr, 1)}%</td>
    ${compact ? "" : `<td class="num">${row.exactTag}/${row.listings}</td><td class="num">${row.titleMatch}/${row.listings}</td><td class="num">${money(row.revenue)}</td>`}
  </tr>`).join("");
  const headers = [
    headerCell("Keyword", "keyword"),
    headerCell("Score", "score", true),
    headerCell("Searches", "searches", true),
    headerCell("Clicks", "clicks", true),
    headerCell("Competition", "competition", true),
    headerCell("CTR", "ctr", true),
    ...(compact ? [] : [
      headerCell("Exact tag", "exactTag", true),
      headerCell("Title match", "titleMatch", true),
      headerCell("Est. revenue", "revenue", true)
    ])
  ].join("");
  return `<thead><tr>${headers}</tr></thead><tbody>${body || '<tr><td colspan="9">Chưa có dữ liệu.</td></tr>'}</tbody>`;
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
    <a href="https://www.etsy.com/listing/${number(item.listing_id)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(item.listing_image)}" alt="" loading="lazy"></a>
    <div class="listing-body"><h3 title="${escapeHtml(item.title)}"><a href="https://www.etsy.com/listing/${number(item.listing_id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h3>
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
  const headers = [
    headerCell("Tag", "tag"),
    headerCell("Nguồn", "source"),
    headerCell("Opportunity", "tagOpportunity", true),
    headerCell("Occurrences", "occurrences", true),
    headerCell("Searches", "searches", true),
    headerCell("Clicks", "clicks", true),
    headerCell("Competition", "competition", true),
    headerCell("CTR", "ctr", true)
  ].join("");
  $("#tagTable").innerHTML = `<thead><tr>${headers}</tr></thead><tbody>${rows.map((tag) => `<tr>
    <td><b>${escapeHtml(tag.keyword)}</b></td><td>${escapeHtml(tag._source)}</td><td class="num"><span class="score ${scoreClass(tag.opportunity)}">${tag.opportunity}</span></td>
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

const fieldTooltip = document.createElement("div");
fieldTooltip.className = "field-tooltip";
fieldTooltip.setAttribute("role", "tooltip");
fieldTooltip.hidden = true;
document.body.appendChild(fieldTooltip);

function showFieldTooltip(header) {
  const text = header?.dataset.tooltip;
  if (!text) return;
  fieldTooltip.textContent = text;
  fieldTooltip.hidden = false;
  fieldTooltip.dataset.owner = header.textContent.trim();
  const rect = header.getBoundingClientRect();
  const tooltipRect = fieldTooltip.getBoundingClientRect();
  const margin = 10;
  let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin));
  let top = rect.bottom + 9;
  if (top + tooltipRect.height > window.innerHeight - margin) top = rect.top - tooltipRect.height - 9;
  fieldTooltip.style.left = `${left}px`;
  fieldTooltip.style.top = `${Math.max(margin, top)}px`;
}

function hideFieldTooltip() {
  fieldTooltip.hidden = true;
  delete fieldTooltip.dataset.owner;
}

document.addEventListener("pointerover", (event) => {
  const header = event.target.closest?.("th[data-tooltip]");
  if (header) showFieldTooltip(header);
});
document.addEventListener("pointerout", (event) => {
  const header = event.target.closest?.("th[data-tooltip]");
  if (header && !header.contains(event.relatedTarget)) hideFieldTooltip();
});
document.addEventListener("focusin", (event) => {
  const header = event.target.closest?.("th[data-tooltip]");
  if (header) showFieldTooltip(header);
});
document.addEventListener("focusout", (event) => {
  if (event.target.closest?.("th[data-tooltip]")) hideFieldTooltip();
});
window.addEventListener("scroll", hideFieldTooltip, true);
window.addEventListener("resize", hideFieldTooltip);

function paintJob(state = {}) {
  const dot = $("#statusDot");
  const hasErrors = state.status === "error" || state.status === "done_with_errors";
  dot.className = state.status === "running" ? "running" : hasErrors ? "error" : "";
  $("#sideStatus").textContent = state.status === "running" ? `${state.current || 0}/${state.total || 0} · ${state.message}` :
    state.status === "error" ? "Có lỗi cần xử lý" :
    state.status === "done_with_errors" ? `Hoàn tất · ${state.failures?.length || 0} keyword lỗi` :
    state.status === "done" ? "Phân tích hoàn tất" : "Sẵn sàng";
  $("#runBtn").disabled = state.status === "running";
  $("#stopBtn").hidden = state.status !== "running";
  const notice = $("#notice");
  if (state.status === "running" || state.status === "error" || state.status === "done_with_errors") {
    notice.hidden = false;
    notice.className = hasErrors ? "notice error" : "notice";
    const failureDetail = state.status === "done_with_errors"
      ? ` ${state.failures.map((failure) => `“${failure.keyword}”: ${failure.message}`).join(" · ")}`
      : "";
    notice.textContent = `${state.message || ""}${failureDetail}`;
  } else notice.hidden = true;
}

async function loadState() {
  const stored = await chrome.storage.local.get(["keywords", "results", "apiConfig", "jobState", "cacheMinutes"]);
  if (stored.results) {
    await migrateLegacyResults(stored.results);
    await chrome.storage.local.remove("results");
  }
  const records = await getAllAnalysisResults();
  allResults = Object.fromEntries(records.map((record) => [record.keyword, record]));
  $("#keywordInput").value = (stored.keywords?.length ? stored.keywords : DEFAULT_KEYWORDS).join("\n");
  $("#cacheMinutes").value = Number.isFinite(Number(stored.cacheMinutes)) ? Number(stored.cacheMinutes) : 10;
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
$("#stopBtn").addEventListener("click", async () => {
  $("#stopBtn").disabled = true;
  await chrome.runtime.sendMessage({ type: "STOP_ANALYSIS" });
  $("#stopBtn").disabled = false;
});
$("#saveCache").addEventListener("click", async () => {
  const value = Number($("#cacheMinutes").value);
  if (!Number.isFinite(value) || value < 0 || value > 43200) {
    $("#notice").hidden = false;
    $("#notice").className = "notice error";
    $("#notice").textContent = "Thời gian cache phải từ 0 đến 43.200 phút.";
    return;
  }
  const cacheMinutes = Math.round(value);
  $("#cacheMinutes").value = cacheMinutes;
  await chrome.storage.local.set({ cacheMinutes });
  $("#notice").hidden = false;
  $("#notice").className = "notice";
  $("#notice").textContent = cacheMinutes
    ? `Đã đặt cache ${cacheMinutes} phút.`
    : "Đã tắt cache; mọi keyword sẽ được tải lại.";
});
$("#clearResults").addEventListener("click", async () => {
  if (!confirm("Xóa toàn bộ kết quả phân tích đã lưu?")) return;
  await clearAnalysisResults();
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
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "RESULT_UPDATED") reloadResults();
});
loadState();
