import { DEFAULT_KEYWORDS } from "./default-keywords.js";
import {
  clearAnalysisResults,
  getAllAnalysisResults,
  migrateLegacyResults
} from "./data-store.js";
import { cycleSortRules, sortRows } from "./table-sort.js";
import { collectListingItems } from "./listing-utils.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const number = (value) => Number(String(value ?? 0).replace(/[,$%]/g, "")) || 0;
const fmt = (value, digits = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value || 0);
const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value || 0);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const DEFAULT_KEYWORD_SCORE_FORMULA = `function score(params) {
  const {
    searches,
    clicks,
    competition,
    ctr,
    listingCount,
    views,
    favorers,
    sales,
    revenue,
    avgPrice,
    avgConversionRate,
    exactTag,
    titleMatch,
    convertedCount,
    is_converted
  } = params;

  const demand = Math.log10(searches + clicks + 10);
  const difficulty = Math.log10(competition + 10);

  return 50
    + (demand - difficulty * 0.58) * 19
    + Math.min(10, ctr / 15);
}`;

const DEFAULT_TAG_SCORE_FORMULA = `function score(params) {
  const {
    searches,
    clicks,
    competition,
    ctr,
    occurrences,
    sourceCount,
    trendAverage
  } = params;

  return 55
    + Math.log10(searches + clicks + 10) * 18
    - Math.log10(competition + 10) * 11;
}`;

const LEGACY_DEFAULT_KEYWORD_SCORE_FORMULA = DEFAULT_KEYWORD_SCORE_FORMULA.replaceAll("Math.", "");
const LEGACY_DEFAULT_TAG_SCORE_FORMULA = DEFAULT_TAG_SCORE_FORMULA.replaceAll("Math.", "");

function loadStoredFormula(value, defaultFormula, legacyDefaultFormula) {
  if (typeof value !== "string" || !value.trim()) return defaultFormula;
  return value.trim() === legacyDefaultFormula.trim() ? defaultFormula : value;
}

function isLegacyStoredFormula(value, legacyDefaultFormula) {
  return typeof value === "string" && value.trim() === legacyDefaultFormula.trim();
}

let scoreFormulas = {
  keyword: DEFAULT_KEYWORD_SCORE_FORMULA,
  tag: DEFAULT_TAG_SCORE_FORMULA
};
let keywordScoreOverrides = new Map();
let formulaSandboxFrame;
let formulaSandboxReady;
let formulaSandboxReadyResolve;
let formulaSandboxReadyTimer;
const formulaRequests = new Map();

function ensureFormulaSandbox() {
  if (formulaSandboxReady) return formulaSandboxReady;
  formulaSandboxReady = new Promise((resolve, reject) => {
    formulaSandboxReadyResolve = resolve;
    const failStartup = (message) => {
      clearTimeout(formulaSandboxReadyTimer);
      formulaSandboxFrame?.remove();
      formulaSandboxFrame = undefined;
      formulaSandboxReady = undefined;
      formulaSandboxReadyResolve = undefined;
      reject(new Error(message));
    };
    formulaSandboxReadyTimer = setTimeout(() => {
      failStartup("Formula Sandbox không khởi tạo được.");
    }, 3500);
    formulaSandboxFrame = document.createElement("iframe");
    formulaSandboxFrame.hidden = true;
    formulaSandboxFrame.src = chrome.runtime.getURL("formula-sandbox.html");
    formulaSandboxFrame.addEventListener("error", () => {
      failStartup("Không tải được Formula Sandbox.");
    }, { once: true });
    document.body.appendChild(formulaSandboxFrame);
  });
  return formulaSandboxReady;
}

window.addEventListener("message", (event) => {
  if (event.source !== formulaSandboxFrame?.contentWindow) return;
  if (event.data?.type === "FORMULA_SANDBOX_READY") {
    clearTimeout(formulaSandboxReadyTimer);
    formulaSandboxReadyResolve?.();
    formulaSandboxReadyResolve = undefined;
    return;
  }
  if (event.data?.type !== "SCORE_FORMULA_RESULT") return;
  const pending = formulaRequests.get(event.data.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  formulaRequests.delete(event.data.requestId);
  if (event.data.ok) pending.resolve(event.data.results);
  else pending.reject(new Error(event.data.error || "Công thức score gặp lỗi."));
});

async function evaluateScoreFormula(formula, paramsList) {
  if (!paramsList.length) return [];
  await ensureFormulaSandbox();
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      formulaRequests.delete(requestId);
      reject(new Error("Formula Sandbox không phản hồi."));
    }, 3500);
    formulaRequests.set(requestId, { resolve, reject, timer });
    formulaSandboxFrame.contentWindow.postMessage({
      type: "EVALUATE_SCORE_FORMULA",
      requestId,
      formula,
      paramsList
    }, "*");
  });
}

function clampScore(value) {
  return Math.max(1, Math.min(100, Math.round(number(value))));
}

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

const tableSortStates = {
  overviewTable: [],
  keywordTable: [],
  tagTable: []
};

const keywordSortAccessors = {
  keyword: (row) => row.keyword,
  score: (row) => row.score,
  searches: (row) => row.searches,
  clicks: (row) => row.clicks,
  competition: (row) => row.competition,
  ctr: (row) => row.ctr,
  exactTag: (row) => row.exactTag,
  titleMatch: (row) => row.titleMatch,
  revenue: (row) => row.revenue
};

const tagSortAccessors = {
  keyword: (row) => row.keyword,
  source: (row) => row._source,
  opportunity: (row) => row.opportunity,
  occurrences: (row) => number(row.occurences),
  searches: (row) => row.searches,
  clicks: (row) => row.clicks,
  competition: (row) => row.competition,
  ctr: (row) => number(row.ctr?.value)
};

function headerCell(label, tooltipKey, numeric = false, tableId = "", sortKey = "") {
  const rules = tableSortStates[tableId] || [];
  const ruleIndex = rules.findIndex((rule) => rule.key === sortKey);
  const rule = rules[ruleIndex];
  const tooltip = `${HEADER_TOOLTIPS[tooltipKey] || ""}

Sắp xếp: Bấm để chuyển Idle → Tăng dần → Giảm dần → Idle. Có thể chọn nhiều cột; số hiển thị là thứ tự ưu tiên.`;
  const sortMarkup = sortKey
    ? `<span class="sort-control" aria-hidden="true"><b>${rule?.direction === "asc" ? "↑" : rule?.direction === "desc" ? "↓" : "↕"}</b>${rule ? `<em>${ruleIndex + 1}</em>` : ""}</span>`
    : "";
  const ariaSort = rule ? (rule.direction === "asc" ? "ascending" : "descending") : "none";
  return `<th class="${numeric ? "num " : ""}${sortKey ? "sortable" : ""}" tabindex="0" data-tooltip="${escapeHtml(tooltip)}" data-sort-table="${tableId}" data-sort-key="${sortKey}" data-sort-type="${numeric ? "number" : "string"}" aria-sort="${ariaSort}"><span>${escapeHtml(label)}</span><i class="info-icon" aria-hidden="true">i</i>${sortMarkup}</th>`;
}

let allResults = {};
let listingDetailsByKey = new Map();
let tagRenderVersion = 0;
let latestTagScoreParams = [];
const filterSelections = {
  listingFilter: new Set(),
  tagFilter: new Set()
};

async function reloadResults() {
  const records = await getAllAnalysisResults();
  allResults = Object.fromEntries(records.map((record) => [record.keyword, record]));
  await refreshKeywordFormulaScores();
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

function trendStats(trend) {
  const values = Object.entries(trend || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => number(value));
  if (!values.length) return { average: 0, latest: 0, min: 0, max: 0 };
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    latest: values.at(-1),
    min: Math.min(...values),
    max: Math.max(...values)
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function keywordMetrics(record) {
  const data = record.data || {};
  const listings = data.listings || [];
  const keyword = record.keyword.toLowerCase();
  const tagKeyword = (tag) => typeof tag?.keyword === "string" ? tag.keyword.toLowerCase() : "";
  const popular = (data.popular_tags || []).find((tag) => tagKeyword(tag) === keyword)
    || (data.popular_tags || []).find((tag) => keyword.includes(tagKeyword(tag)));
  const searches = number(popular?.avg_searches?.value);
  const clicks = number(popular?.avg_clicks?.value);
  const competition = number(popular?.competition?.value);
  const ctr = number(popular?.ctr?.value);
  const exactTag = listings.filter((item) => (item.tags || []).some((tag) => String(tag).toLowerCase() === keyword)).length;
  const titleMatch = listings.filter((item) => item.title?.toLowerCase().includes(keyword)).length;
  const views = listings.reduce((sum, item) => sum + number(item.views), 0);
  const favorers = listings.reduce((sum, item) => sum + number(item.favorers), 0);
  const sales = listings.reduce((sum, item) => sum + number(item.est_sales?.value), 0);
  const revenue = listings.reduce((sum, item) => sum + number(item.est_revenue?.value), 0);
  const prices = listings.map((item) => number(item.listing_price?.value));
  const conversionRates = listings.map((item) => number(item.est_conversion_rate?.value));
  const convertedCount = listings.filter((item) => item.is_converted).length;
  const listingCount = listings.length;
  const avgPrice = average(prices);
  const trend = trendStats(popular?.search_trend);
  const demand = Math.log10(searches + clicks + 10);
  const difficulty = Math.log10(competition + 10);
  const rawScore = 50 + (demand - difficulty * .58) * 19 + Math.min(10, ctr / 15);
  const scoreParams = {
    keyword: record.keyword,
    searches,
    clicks,
    competition,
    ctr,
    listingCount,
    views,
    favorers,
    sales,
    revenue,
    avgViews: listingCount ? views / listingCount : 0,
    avgFavorers: listingCount ? favorers / listingCount : 0,
    avgSales: listingCount ? sales / listingCount : 0,
    avgRevenue: listingCount ? revenue / listingCount : 0,
    avgPrice,
    minPrice: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    avgConversionRate: average(conversionRates),
    exactTag,
    exactTagRate: listingCount ? exactTag / listingCount * 100 : 0,
    titleMatch,
    titleMatchRate: listingCount ? titleMatch / listingCount * 100 : 0,
    convertedCount,
    convertedRate: listingCount ? convertedCount / listingCount * 100 : 0,
    is_converted: convertedCount,
    trendAverage: trend.average,
    trendLatest: trend.latest,
    trendMin: trend.min,
    trendMax: trend.max,
    listings,
    popularTag: popular || null,
    response: data,
    record
  };
  const score = keywordScoreOverrides.has(record.keyword)
    ? keywordScoreOverrides.get(record.keyword)
    : clampScore(rawScore);
  return {
    keyword: record.keyword,
    listings: listingCount,
    searches,
    clicks,
    competition,
    ctr,
    exactTag,
    titleMatch,
    views,
    favorers,
    sales,
    revenue,
    avgPrice,
    score,
    popular,
    scoreParams
  };
}

function metrics() {
  return Object.values(allResults).map(keywordMetrics);
}

function setFormulaStatus(message, isError = false) {
  const element = $("#formulaStatus");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("error-text", isError);
}

function sampleParamValue(value) {
  if (value == null) return String(value);
  if (typeof value === "string") return value.length > 42 ? `${value.slice(0, 42)}…` : value;
  if (typeof value === "number") return fmt(value, 2);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  return "object";
}

function discoverParamPaths(value, path = "params", depth = 0, entries = []) {
  if (entries.length >= 350) return entries;
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  entries.push({ path, type, sample: sampleParamValue(value) });
  if (depth >= 5 || value == null) return entries;
  if (Array.isArray(value)) {
    if (value.length) discoverParamPaths(value[0], `${path}[]`, depth + 1, entries);
  } else if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      discoverParamPaths(child, `${path}.${key}`, depth + 1, entries);
      if (entries.length >= 350) break;
    }
  }
  return entries;
}

function renderParamReference(containerId, paramsList) {
  const container = $(`#${containerId}`);
  if (!container) return;
  if (!paramsList?.length) {
    container.innerHTML = '<div class="param-empty">Chưa có response. Chạy phân tích để khám phá params thực tế.</div>';
    return;
  }
  const uniqueEntries = new Map();
  for (const params of paramsList) {
    for (const entry of discoverParamPaths(params)) {
      if (!uniqueEntries.has(entry.path)) uniqueEntries.set(entry.path, entry);
    }
  }
  container.innerHTML = [...uniqueEntries.values()].map((entry) => `<div class="param-item">
    <code>${escapeHtml(entry.path)}</code><span>${escapeHtml(entry.type)}</span><span>${escapeHtml(entry.sample)}</span>
  </div>`).join("");
}

async function refreshKeywordFormulaScores() {
  const rows = Object.values(allResults).map(keywordMetrics);
  renderParamReference("keywordParamReference", rows.map((row) => row.scoreParams));
  if (!rows.length) {
    keywordScoreOverrides = new Map();
    return;
  }
  try {
    const scores = await evaluateScoreFormula(scoreFormulas.keyword, rows.map((row) => row.scoreParams));
    keywordScoreOverrides = new Map(rows.map((row, index) => [row.keyword, clampScore(scores[index])]));
  } catch (error) {
    keywordScoreOverrides = new Map();
    setFormulaStatus(`Keyword Score lỗi, đang dùng công thức mặc định: ${error.message}`, true);
  }
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
  $("#overviewTable").innerHTML = tableMarkup(
    rows.slice().sort((a, b) => b.score - a.score),
    true,
    "overviewTable"
  );
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

function tableMarkup(rows, compact = false, tableId = "keywordTable") {
  const sortedRows = sortRows(rows, tableSortStates[tableId], keywordSortAccessors);
  const body = sortedRows.map((row) => `<tr>
    <td><b>${escapeHtml(row.keyword)}</b></td>
    <td class="num"><span class="score ${scoreClass(row.score)}">${row.score}</span></td>
    <td class="num">${fmt(row.searches)}</td><td class="num">${fmt(row.clicks)}</td>
    <td class="num">${fmt(row.competition)}</td><td class="num">${fmt(row.ctr, 1)}%</td>
    ${compact ? "" : `<td class="num">${row.exactTag}/${row.listings}</td><td class="num">${row.titleMatch}/${row.listings}</td><td class="num">${money(row.revenue)}</td>`}
  </tr>`).join("");
  const headers = [
    headerCell("Keyword", "keyword", false, tableId, "keyword"),
    headerCell("Score", "score", true, tableId, "score"),
    headerCell("Searches", "searches", true, tableId, "searches"),
    headerCell("Clicks", "clicks", true, tableId, "clicks"),
    headerCell("Competition", "competition", true, tableId, "competition"),
    headerCell("CTR", "ctr", true, tableId, "ctr"),
    ...(compact ? [] : [
      headerCell("Exact tag", "exactTag", true, tableId, "exactTag"),
      headerCell("Title match", "titleMatch", true, tableId, "titleMatch"),
      headerCell("Est. revenue", "revenue", true, tableId, "revenue")
    ])
  ].join("");
  return `<thead><tr>${headers}</tr></thead><tbody>${body || '<tr><td colspan="9">Chưa có dữ liệu.</td></tr>'}</tbody>`;
}

function renderKeywordTable() {
  $("#keywordTable").innerHTML = tableMarkup(
    metrics().sort((a, b) => b.score - a.score),
    false,
    "keywordTable"
  );
}

function selectedRecords(filterId) {
  const selected = filterSelections[filterId];
  if (!selected?.size) return Object.values(allResults);
  return [...selected].map((keyword) => allResults[keyword]).filter(Boolean);
}

function comboboxLabel(selected) {
  if (!selected.size) return "Tất cả keywords";
  if (selected.size === 1) return [...selected][0];
  return `${selected.size} keywords đã chọn`;
}

function renderCombobox(element) {
  const keys = Object.keys(allResults);
  const selected = filterSelections[element.id];
  for (const keyword of [...selected]) {
    if (!allResults[keyword]) selected.delete(keyword);
  }
  const menuId = `${element.id}Menu`;
  element.innerHTML = `
    <button type="button" class="combo-trigger" role="combobox" aria-expanded="false" aria-controls="${menuId}">
      <span>${escapeHtml(comboboxLabel(selected))}</span><b aria-hidden="true">⌄</b>
    </button>
    <div id="${menuId}" class="combo-menu" role="listbox" aria-multiselectable="true" hidden>
      <label class="combo-option combo-all"><input type="checkbox" data-filter-all ${selected.size ? "" : "checked"}><span>Tất cả keywords</span></label>
      <div class="combo-divider"></div>
      ${keys.map((key, index) => `<label class="combo-option" role="option" aria-selected="${selected.has(key)}"><input type="checkbox" value="${escapeHtml(key)}" data-filter-keyword ${selected.has(key) ? "checked" : ""}><span>${escapeHtml(key)}</span></label>`).join("") || '<div class="combo-empty">Chưa có dữ liệu keyword.</div>'}
    </div>`;
}

function renderListings() {
  const selected = filterSelections.listingFilter;
  const records = selectedRecords("listingFilter");
  const listings = collectListingItems(records, selected.size !== 1)
    .sort((a, b) => number(b.est_sales?.value) - number(a.est_sales?.value)).slice(0, 100);
  listingDetailsByKey = new Map();
  $("#listingGrid").innerHTML = listings.map((item, index) => {
    const detailKey = `${number(item.listing_id) || "listing"}-${index}`;
    listingDetailsByKey.set(detailKey, item);
    return `<div class="listing" role="button" tabindex="0" data-listing-detail="${detailKey}" aria-label="Xem chi tiết eRank của ${escapeHtml(item.title)}">
    <img src="${escapeHtml(item.listing_image)}" alt="" loading="lazy">
    <div class="listing-body"><h3 title="${escapeHtml(item.title)}"><a data-etsy-link href="https://www.etsy.com/listing/${number(item.listing_id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h3>
    <p class="muted">${escapeHtml(item.shop_name)} · ${escapeHtml(item._keywords.join(", "))}</p>
    <div class="listing-meta"><div><small>SALES</small><b>${fmt(number(item.est_sales?.value))}</b></div><div><small>REVENUE</small><b>${money(number(item.est_revenue?.value))}</b></div><div><small>PRICE</small><b>$${fmt(number(item.listing_price?.value), 2)}</b></div></div></div>
  </div>`;
  }).join("") || '<div class="empty">Chưa có dữ liệu listing.</div>';
}

function metricLabel(metricValue, formatter = fmt) {
  if (metricValue?.label) return String(metricValue.label);
  return formatter(number(metricValue?.value));
}

function detailMetric(label, value) {
  return `<div class="detail-metric"><small>${escapeHtml(label)}</small><b>${escapeHtml(value ?? "—")}</b></div>`;
}

function openListingDetail(detailKey) {
  const item = listingDetailsByKey.get(detailKey);
  if (!item) return;
  const listingId = number(item.listing_id);
  const etsyUrl = `https://www.etsy.com/listing/${listingId}`;
  const rawListing = Object.fromEntries(
    Object.entries(item).filter(([key]) => !key.startsWith("_"))
  );
  const computedSales = item.est_sales?.computed_sales;
  const computedRevenue = item.est_revenue?.computed_revenue;
  const computedRate = item.est_conversion_rate?.computed_rate;
  const metrics = [
    ["Views", fmt(number(item.views))],
    ["Favorers", fmt(number(item.favorers))],
    ["Estimated sales", metricLabel(item.est_sales)],
    ["Computed sales", computedSales == null ? "—" : fmt(number(computedSales))],
    ["Estimated revenue", metricLabel(item.est_revenue, money)],
    ["Computed revenue", computedRevenue == null ? "—" : money(number(computedRevenue))],
    ["Conversion rate", metricLabel(item.est_conversion_rate)],
    ["Computed conversion", computedRate == null ? "—" : `${fmt(number(computedRate), 2)}%`],
    ["Listing price", metricLabel(item.listing_price, (value) => `$${fmt(value, 2)}`)],
    ["Original price", metricLabel(item.orig_listing_price, (value) => `$${fmt(value, 2)}`)],
    ["is_converted", item.is_converted ? "true" : "false"],
    ["Listing ID", String(listingId)]
  ];
  $("#listingDetailContent").innerHTML = `
    <div class="detail-hero">
      <img src="${escapeHtml(item.listing_image)}" alt="">
      <div>
        <small>ERANK LISTING DETAIL</small>
        <h2 id="listingDetailTitle"><a href="${etsyUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h2>
        <p><b>${escapeHtml(item.shop_name)}</b></p>
        <p class="muted">Xuất hiện trong: ${escapeHtml(item._keywords.join(", "))}</p>
        <p class="muted">Thu thập lúc: ${item._collectedAt ? escapeHtml(new Date(item._collectedAt).toLocaleString("vi-VN")) : "—"}</p>
      </div>
    </div>
    <div class="detail-metrics">${metrics.map(([label, value]) => detailMetric(label, value)).join("")}</div>
    <div class="detail-section">
      <h3>Tags (${item.tags?.length || 0})</h3>
      <div class="tag-chips">${(item.tags || []).map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join("") || '<span class="muted">Không có tags.</span>'}</div>
    </div>
    <div class="detail-section raw-details">
      <details>
        <summary>Xem toàn bộ dữ liệu eRank đã lưu</summary>
        <pre>${escapeHtml(JSON.stringify(rawListing, null, 2))}</pre>
      </details>
    </div>`;
  $("#listingDetailModal").showModal();
}

async function renderTags() {
  const renderVersion = ++tagRenderVersion;
  const records = selectedRecords("tagFilter");
  const tags = records.flatMap((record) => (record.data?.popular_tags || []).map((tag) => ({ ...tag, _source: record.keyword })));
  const deduped = new Map();
  for (const tag of tags) {
    const key = tag.keyword?.toLowerCase();
    if (!key) continue;
    const prior = deduped.get(key);
    if (!prior) {
      deduped.set(key, { ...tag, _sources: [tag._source] });
      continue;
    }
    const sources = [...new Set([...prior._sources, tag._source])];
    if (number(tag.avg_searches?.value) > number(prior.avg_searches?.value)) {
      deduped.set(key, { ...tag, _sources: sources });
    } else {
      prior._sources = sources;
    }
  }
  const rows = [...deduped.values()].map((tag) => {
    const searches = number(tag.avg_searches?.value), clicks = number(tag.avg_clicks?.value), competition = number(tag.competition?.value);
    const trend = trendStats(tag.search_trend);
    const scoreParams = {
      keyword: tag.keyword,
      occurrences: number(tag.occurences),
      searches,
      clicks,
      competition,
      ctr: number(tag.ctr?.value),
      sourceCount: tag._sources.length,
      trendAverage: trend.average,
      trendLatest: trend.latest,
      trendMin: trend.min,
      trendMax: trend.max,
      searchTrend: tag.search_trend || {},
      tag
    };
    const defaultOpportunity = clampScore(
      55 + Math.log10(searches + clicks + 10) * 18 - Math.log10(competition + 10) * 11
    );
    return {
      ...tag,
      _source: tag._sources.join(", "),
      searches,
      clicks,
      competition,
      opportunity: defaultOpportunity,
      scoreParams
    };
  });
  latestTagScoreParams = rows.map((row) => row.scoreParams);
  renderParamReference("tagParamReference", rows.map((row) => row.scoreParams));
  try {
    const scores = await evaluateScoreFormula(scoreFormulas.tag, rows.map((row) => row.scoreParams));
    if (renderVersion !== tagRenderVersion) return;
    rows.forEach((row, index) => { row.opportunity = clampScore(scores[index]); });
  } catch (error) {
    if (renderVersion !== tagRenderVersion) return;
    setFormulaStatus(`Tag Opportunity lỗi, đang dùng công thức mặc định: ${error.message}`, true);
  }
  const visibleRows = rows
    .sort((a, b) => b.opportunity - a.opportunity || b.searches - a.searches)
    .slice(0, 150);
  const sortedRows = sortRows(visibleRows, tableSortStates.tagTable, tagSortAccessors);
  const headers = [
    headerCell("Tag", "tag", false, "tagTable", "keyword"),
    headerCell("Nguồn", "source", false, "tagTable", "source"),
    headerCell("Opportunity", "tagOpportunity", true, "tagTable", "opportunity"),
    headerCell("Occurrences", "occurrences", true, "tagTable", "occurrences"),
    headerCell("Searches", "searches", true, "tagTable", "searches"),
    headerCell("Clicks", "clicks", true, "tagTable", "clicks"),
    headerCell("Competition", "competition", true, "tagTable", "competition"),
    headerCell("CTR", "ctr", true, "tagTable", "ctr")
  ].join("");
  $("#tagTable").innerHTML = `<thead><tr>${headers}</tr></thead><tbody>${sortedRows.map((tag) => `<tr>
    <td><b>${escapeHtml(tag.keyword)}</b></td><td>${escapeHtml(tag._source)}</td><td class="num"><span class="score ${scoreClass(tag.opportunity)}">${tag.opportunity}</span></td>
    <td class="num">${fmt(number(tag.occurences))}</td><td class="num">${fmt(tag.searches)}</td><td class="num">${fmt(tag.clicks)}</td><td class="num">${fmt(tag.competition)}</td><td class="num">${fmt(number(tag.ctr?.value), 1)}%</td>
  </tr>`).join("") || '<tr><td colspan="8">Chưa có dữ liệu tag.</td></tr>'}</tbody>`;
}

function renderAll() {
  renderOverview();
  renderKeywordTable();
  renderCombobox($("#listingFilter"));
  renderCombobox($("#tagFilter"));
  renderListings();
  renderTags();
}

function updateComboboxDisplay(element) {
  const selected = filterSelections[element.id];
  element.querySelector(".combo-trigger span").textContent = comboboxLabel(selected);
  const allInput = element.querySelector("[data-filter-all]");
  if (allInput) allInput.checked = selected.size === 0;
  element.querySelectorAll("[data-filter-keyword]").forEach((input) => {
    input.checked = selected.has(input.value);
    input.closest("[role='option']")?.setAttribute("aria-selected", String(input.checked));
  });
}

function closeCombobox(element) {
  const trigger = element.querySelector(".combo-trigger");
  const menu = element.querySelector(".combo-menu");
  if (!trigger || !menu) return;
  trigger.setAttribute("aria-expanded", "false");
  menu.hidden = true;
}

function closeOtherComboboxes(current) {
  $$(".multi-combobox").forEach((element) => {
    if (element !== current) closeCombobox(element);
  });
}

function setupCombobox(element, onChange) {
  element.addEventListener("click", (event) => {
    const trigger = event.target.closest(".combo-trigger");
    if (!trigger) return;
    const menu = element.querySelector(".combo-menu");
    const opening = menu.hidden;
    closeOtherComboboxes(element);
    menu.hidden = !opening;
    trigger.setAttribute("aria-expanded", String(opening));
  });
  element.addEventListener("change", (event) => {
    const selected = filterSelections[element.id];
    if (event.target.matches("[data-filter-all]")) {
      selected.clear();
    } else if (event.target.matches("[data-filter-keyword]")) {
      if (event.target.checked) selected.add(event.target.value);
      else selected.delete(event.target.value);
    } else {
      return;
    }
    updateComboboxDisplay(element);
    onChange();
  });
  element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCombobox(element);
      element.querySelector(".combo-trigger")?.focus();
    }
  });
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

function renderSortedTable(tableId) {
  if (tableId === "overviewTable") renderOverview();
  else if (tableId === "keywordTable") renderKeywordTable();
  else if (tableId === "tagTable") renderTags();
}

function cycleHeaderSort(header) {
  const tableId = header?.dataset.sortTable;
  const sortKey = header?.dataset.sortKey;
  if (!tableId || !sortKey || !tableSortStates[tableId]) return;
  tableSortStates[tableId] = cycleSortRules(
    tableSortStates[tableId],
    sortKey,
    header.dataset.sortType || "string"
  );
  hideFieldTooltip();
  renderSortedTable(tableId);
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
document.addEventListener("click", (event) => {
  const header = event.target.closest?.("th[data-sort-key]");
  if (header) cycleHeaderSort(header);
});
document.addEventListener("keydown", (event) => {
  const header = event.target.closest?.("th[data-sort-key]");
  if (header && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    cycleHeaderSort(header);
  }
});
window.addEventListener("scroll", hideFieldTooltip, true);
window.addEventListener("resize", hideFieldTooltip);

function paintParallelAnalysis(enabled) {
  const input = $("#parallelAnalysis");
  input.checked = enabled;
  $("#parallelAnalysisState").textContent = enabled ? "Bật" : "Tắt";
}

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
  $("#parallelAnalysis").disabled = state.status === "running";
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
  const stored = await chrome.storage.local.get([
    "keywords", "results", "apiConfig", "jobState", "cacheMinutes", "parallelAnalysis", "scoreFormulas"
  ]);
  if (stored.results) {
    await migrateLegacyResults(stored.results);
    await chrome.storage.local.remove("results");
  }
  const records = await getAllAnalysisResults();
  allResults = Object.fromEntries(records.map((record) => [record.keyword, record]));
  scoreFormulas = {
    keyword: loadStoredFormula(
      stored.scoreFormulas?.keyword,
      DEFAULT_KEYWORD_SCORE_FORMULA,
      LEGACY_DEFAULT_KEYWORD_SCORE_FORMULA
    ),
    tag: loadStoredFormula(
      stored.scoreFormulas?.tag,
      DEFAULT_TAG_SCORE_FORMULA,
      LEGACY_DEFAULT_TAG_SCORE_FORMULA
    )
  };
  if (
    isLegacyStoredFormula(stored.scoreFormulas?.keyword, LEGACY_DEFAULT_KEYWORD_SCORE_FORMULA)
    || isLegacyStoredFormula(stored.scoreFormulas?.tag, LEGACY_DEFAULT_TAG_SCORE_FORMULA)
  ) {
    await chrome.storage.local.set({ scoreFormulas });
  }
  $("#keywordScoreFormula").value = scoreFormulas.keyword;
  $("#tagScoreFormula").value = scoreFormulas.tag;
  $("#keywordInput").value = (stored.keywords?.length ? stored.keywords : DEFAULT_KEYWORDS).join("\n");
  $("#cacheMinutes").value = Number.isFinite(Number(stored.cacheMinutes)) ? Number(stored.cacheMinutes) : 10;
  paintParallelAnalysis(stored.parallelAnalysis === true);
  $("#configState").textContent = stored.apiConfig?.accessToken
    ? `Đã nhập curl lúc ${new Date(stored.apiConfig.importedAt || Date.now()).toLocaleString("vi-VN")}.`
    : "Chưa nhập curl. Extension sẽ thử dùng phiên đăng nhập eRank trong trình duyệt.";
  paintJob(stored.jobState);
  await refreshKeywordFormulaScores();
  renderAll();
}

function fallbackKeywordParams() {
  return {
    keyword: "sample", searches: 0, clicks: 0, competition: 0, ctr: 0,
    listingCount: 0, views: 0, favorers: 0, sales: 0, revenue: 0,
    avgViews: 0, avgFavorers: 0, avgSales: 0, avgRevenue: 0,
    avgPrice: 0, minPrice: 0, maxPrice: 0, avgConversionRate: 0,
    exactTag: 0, exactTagRate: 0, titleMatch: 0, titleMatchRate: 0,
    convertedCount: 0, convertedRate: 0, is_converted: 0,
    trendAverage: 0, trendLatest: 0, trendMin: 0, trendMax: 0,
    listings: [], popularTag: null, response: {}, record: {}
  };
}

function fallbackTagParams() {
  return {
    keyword: "sample", occurrences: 0, searches: 0, clicks: 0,
    competition: 0, ctr: 0, sourceCount: 1,
    trendAverage: 0, trendLatest: 0, trendMin: 0, trendMax: 0,
    searchTrend: {}, tag: {}
  };
}

async function saveScoreFormulaEditors() {
  const button = $("#saveScoreFormulas");
  const keywordFormula = $("#keywordScoreFormula").value.trim();
  const tagFormula = $("#tagScoreFormula").value.trim();
  if (!keywordFormula || !tagFormula) {
    setFormulaStatus("Cả hai editor phải có function score(params).", true);
    return;
  }
  button.disabled = true;
  setFormulaStatus("Đang kiểm tra công thức trong sandbox…");
  try {
    const keywordParams = metrics().map((row) => row.scoreParams);
    await evaluateScoreFormula(keywordFormula, keywordParams.length ? keywordParams : [fallbackKeywordParams()]);
    await evaluateScoreFormula(tagFormula, latestTagScoreParams.length ? latestTagScoreParams : [fallbackTagParams()]);
    scoreFormulas = { keyword: keywordFormula, tag: tagFormula };
    await chrome.storage.local.set({ scoreFormulas });
    await refreshKeywordFormulaScores();
    renderAll();
    setFormulaStatus("Công thức hợp lệ, đã lưu và áp dụng cho toàn bộ dashboard.");
  } catch (error) {
    setFormulaStatus(`Không thể lưu: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
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
$("#saveScoreFormulas").addEventListener("click", saveScoreFormulaEditors);
$("#resetKeywordFormula").addEventListener("click", () => {
  $("#keywordScoreFormula").value = DEFAULT_KEYWORD_SCORE_FORMULA;
  setFormulaStatus("Đã khôi phục hàm mẫu Keyword Score trong editor. Bấm Kiểm tra & lưu để áp dụng.");
});
$("#resetTagFormula").addEventListener("click", () => {
  $("#tagScoreFormula").value = DEFAULT_TAG_SCORE_FORMULA;
  setFormulaStatus("Đã khôi phục hàm mẫu Tag Opportunity trong editor. Bấm Kiểm tra & lưu để áp dụng.");
});
[$("#keywordScoreFormula"), $("#tagScoreFormula")].forEach((editor) => {
  editor.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const start = editor.selectionStart;
    editor.setRangeText("  ", start, editor.selectionEnd, "end");
  });
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
$("#parallelAnalysis").addEventListener("change", async (event) => {
  const parallelAnalysis = event.target.checked;
  paintParallelAnalysis(parallelAnalysis);
  await chrome.storage.local.set({ parallelAnalysis });
  $("#notice").hidden = false;
  $("#notice").className = "notice";
  $("#notice").textContent = parallelAnalysis
    ? "Đã bật phân tích song song, tối đa 3 keyword cùng lúc."
    : "Đã chuyển sang chạy tuần tự từng keyword.";
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
  allResults = {};
  await refreshKeywordFormulaScores();
  renderAll();
});
setupCombobox($("#listingFilter"), renderListings);
setupCombobox($("#tagFilter"), renderTags);
document.addEventListener("click", (event) => {
  if (!event.target.closest(".multi-combobox")) {
    $$(".multi-combobox").forEach(closeCombobox);
  }
});
$("#listingGrid").addEventListener("click", (event) => {
  if (event.target.closest("[data-etsy-link]")) return;
  const card = event.target.closest("[data-listing-detail]");
  if (card) openListingDetail(card.dataset.listingDetail);
});
$("#listingGrid").addEventListener("keydown", (event) => {
  if (event.target.closest("[data-etsy-link]")) return;
  const card = event.target.closest("[data-listing-detail]");
  if (card && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openListingDetail(card.dataset.listingDetail);
  }
});
$("#closeListingDetail").addEventListener("click", () => $("#listingDetailModal").close());
$("#listingDetailModal").addEventListener("click", (event) => {
  if (event.target === $("#listingDetailModal")) $("#listingDetailModal").close();
});
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
$("#keywordScoreFormula").value = DEFAULT_KEYWORD_SCORE_FORMULA;
$("#tagScoreFormula").value = DEFAULT_TAG_SCORE_FORMULA;
renderParamReference("keywordParamReference", []);
renderParamReference("tagParamReference", []);
loadState();
