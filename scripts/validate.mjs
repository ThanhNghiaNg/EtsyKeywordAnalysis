import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const extension = path.join(root, "extension");
const required = [
  "manifest.json", "background.js", "scraper.js", "popup.html", "popup.js",
  "popup.css", "dashboard.html", "dashboard.js", "dashboard.css",
  "dashboard-settings.css", "dashboard-listing-modal.css", "default-keywords.js",
  "data-store.js", "table-sort.js", "listing-utils.js",
  "formula-sandbox.html", "formula-sandbox.js"
];

for (const file of required) {
  if (!fs.existsSync(path.join(extension, file))) throw new Error(`Thiếu file: ${file}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest phải là V3.");
for (const permission of ["storage", "tabs", "scripting"]) {
  if (!manifest.permissions.includes(permission)) throw new Error(`Thiếu permission: ${permission}`);
}
for (const host of ["https://www.etsy.com/*", "https://members.erank.com/*"]) {
  if (!manifest.host_permissions.includes(host)) throw new Error(`Thiếu host permission: ${host}`);
}

const sourceKeywords = fs.readFileSync(path.join(root, "keyworklist.txt"), "utf8")
  .split(/\r?\n/).map((line) => line.trim().replace(/^["']|["']$/g, "").trim()).filter(Boolean);
const generatedText = fs.readFileSync(path.join(extension, "default-keywords.js"), "utf8");
const generatedKeywords = JSON.parse(generatedText.match(/\[[\s\S]*\]/)?.[0] || "[]");
if (JSON.stringify(sourceKeywords) !== JSON.stringify(generatedKeywords)) {
  throw new Error("default-keywords.js không đồng bộ với keyworklist.txt.");
}

const curlText = fs.readFileSync(path.join(root, "curl.txt"), "utf8");
const curlUrl = curlText.match(/https?:\/\/[^'"\s]+/)?.[0];
if (!curlUrl?.startsWith("https://members.erank.com/")) throw new Error("curl.txt thiếu URL eRank.");
for (const header of ["authorization", "x-device-id", "x-signature", "x-timestamp"]) {
  if (!new RegExp(`(?:-H|--header)\\s+['"][^'"]*${header}:`, "i").test(curlText)) {
    throw new Error(`curl.txt thiếu header ${header}.`);
  }
}
if (!/"endpoint"\s*:\s*"ext\/listing-ids"/.test(curlText)) throw new Error("curl.txt sai endpoint.");

for (const file of [
  "background.js", "scraper.js", "popup.js", "dashboard.js",
  "data-store.js", "table-sort.js", "listing-utils.js",
  "formula-sandbox.js"
]) {
  const source = fs.readFileSync(path.join(extension, file), "utf8")
    .replace(/import[\s\S]*?from\s+["'][^"']+["'];\s*/g, "")
    .replace(/^export\s+/gm, "");
  new vm.Script(source, { filename: file });
}

const backgroundSource = fs.readFileSync(path.join(extension, "background.js"), "utf8");
if (/storageSet\s*\(\s*\{\s*results\b/.test(backgroundSource)) {
  throw new Error("Background vẫn đang ghi results lớn vào chrome.storage.local.");
}
if (!/putAnalysisResult\s*\(/.test(backgroundSource)) {
  throw new Error("Background chưa lưu kết quả theo keyword vào IndexedDB.");
}
if (!/DEFAULT_CACHE_MINUTES\s*=\s*10/.test(backgroundSource) || !/stored\.cacheMinutes/.test(backgroundSource)) {
  throw new Error("Cache keyword chưa đọc cấu hình với mặc định 10 phút.");
}
if (!/NETWORK_ATTEMPTS\s*=\s*3/.test(backgroundSource)) {
  throw new Error("Cơ chế retry mạng chưa được cấu hình 3 lần.");
}
if (!/queue\.push\(\{\s*keyword,\s*queueAttempt: queueAttempt \+ 1\s*\}\)/.test(backgroundSource)) {
  throw new Error("Keyword lỗi chưa được đẩy xuống cuối queue.");
}
if (!/status:\s*failed\.length\s*\?\s*"done_with_errors"\s*:\s*"done"/.test(backgroundSource)) {
  throw new Error("Tiến trình chưa hỗ trợ hoàn tất trong khi một số keyword bị lỗi.");
}
if (!/new AbortController\(\)/.test(backgroundSource) || !/activeTabIds/.test(backgroundSource)) {
  throw new Error("Nút dừng chưa hủy cả fetch và tab Etsy đang chạy.");
}
const dashboardHtml = fs.readFileSync(path.join(extension, "dashboard.html"), "utf8");
if (!/id="cacheMinutes"/.test(dashboardHtml) || !/id="stopBtn"/.test(dashboardHtml)) {
  throw new Error("Dashboard thiếu cấu hình cache hoặc nút dừng.");
}
const dashboardSource = fs.readFileSync(path.join(extension, "dashboard.js"), "utf8");
for (const tooltipKey of [
  "keyword", "score", "searches", "clicks", "competition", "ctr",
  "exactTag", "titleMatch", "revenue", "tag", "source",
  "tagOpportunity", "occurrences"
]) {
  if (!new RegExp(`\\n\\s*${tooltipKey}:\\s*\\x60`).test(dashboardSource)) {
    throw new Error(`Thiếu nội dung tooltip cho header ${tooltipKey}.`);
  }
}
if (!/function headerCell\(/.test(dashboardSource) || !/data-tooltip=/.test(dashboardSource)) {
  throw new Error("Header bảng chưa sử dụng tooltip dùng chung.");
}
if (!/data-sort-key=/.test(dashboardSource) || !/cycleHeaderSort/.test(dashboardSource)) {
  throw new Error("Header bảng chưa hỗ trợ tương tác multi-sort.");
}
if (!/id="listingDetailModal"/.test(dashboardHtml) || !/collectListingItems/.test(dashboardSource)) {
  throw new Error("Top Listings thiếu modal chi tiết hoặc cơ chế chống trùng.");
}
if (
  (dashboardHtml.match(/class="multi-combobox"/g) || []).length !== 2
  || !/aria-multiselectable="true"/.test(dashboardSource)
  || !/filterSelections/.test(dashboardSource)
) {
  throw new Error("Top Listings và Tags chưa dùng multi-select combobox.");
}
if (
  !manifest.sandbox?.pages?.includes("formula-sandbox.html")
  || !manifest.content_security_policy?.sandbox?.includes("'unsafe-eval'")
  || !manifest.content_security_policy?.sandbox?.includes("worker-src blob:")
) {
  throw new Error("Formula editor chưa chạy trong Manifest sandbox riêng.");
}
if (
  !/DEFAULT_KEYWORD_SCORE_FORMULA/.test(dashboardSource)
  || !/DEFAULT_TAG_SCORE_FORMULA/.test(dashboardSource)
  || !/discoverParamPaths/.test(dashboardSource)
  || !/id="keywordParamReference"/.test(dashboardHtml)
  || !/id="tagParamReference"/.test(dashboardHtml)
) {
  throw new Error("Formula editor thiếu hàm mặc định hoặc param discovery động.");
}
const formulaSandboxSource = fs.readFileSync(path.join(extension, "formula-sandbox.js"), "utf8");
if (
  !/new Blob\(\[workerSource\]/.test(formulaSandboxSource)
  || !/new Worker\(workerUrl\)/.test(formulaSandboxSource)
  || !/worker\?\.terminate\(\)/.test(formulaSandboxSource)
  || !/FORMULA_SANDBOX_READY/.test(formulaSandboxSource)
  || !/FORMULA_SANDBOX_READY/.test(dashboardSource)
) {
  throw new Error("Formula sandbox thiếu Worker có timeout/terminate.");
}

const { compactAnalysisRecord } = await import(path.join(extension, "data-store.js"));
const { cycleSortRules, sortRows } = await import(path.join(extension, "table-sort.js"));
const { collectListingItems } = await import(path.join(extension, "listing-utils.js"));

function extractFormula(constantName) {
  const marker = `const ${constantName} = \``;
  const start = dashboardSource.indexOf(marker);
  const end = start < 0 ? -1 : dashboardSource.indexOf("`;", start + marker.length);
  if (start < 0 || end < 0) throw new Error(`Không đọc được ${constantName}.`);
  return dashboardSource.slice(start + marker.length, end);
}

function executeFormula(formula, params) {
  return new Function(`"use strict"; return (${formula});`)()(params);
}

const keywordFormula = extractFormula("DEFAULT_KEYWORD_SCORE_FORMULA");
const tagFormula = extractFormula("DEFAULT_TAG_SCORE_FORMULA");
if (
  !keywordFormula.includes("Math.log10(")
  || !keywordFormula.includes("Math.min(")
  || !tagFormula.includes("Math.log10(")
) {
  throw new Error("Hàm mẫu phải sử dụng JavaScript chuẩn qua Math.");
}
const keywordFormulaResult = executeFormula(keywordFormula, {
  searches: 100, clicks: 80, competition: 10000, ctr: 50
});
const expectedKeywordFormula = 50
  + (Math.log10(190) - Math.log10(10010) * .58) * 19
  + Math.min(10, 50 / 15);
if (Math.abs(keywordFormulaResult - expectedKeywordFormula) > 1e-9) {
  throw new Error("Hàm mẫu Keyword Score không khớp công thức mặc định.");
}
const tagFormulaResult = executeFormula(tagFormula, {
  searches: 100, clicks: 80, competition: 10000
});
const expectedTagFormula = 55 + Math.log10(190) * 18 - Math.log10(10010) * 11;
if (Math.abs(tagFormulaResult - expectedTagFormula) > 1e-9) {
  throw new Error("Hàm mẫu Tag Opportunity không khớp công thức mặc định.");
}
const sampleRecord = {
  keyword: "sample keyword",
  listingIds: [1, 1, 2],
  collectedAt: Date.now(),
  data: {
    listings: [{
      listing_id: 1,
      title: "Sample",
      views: "1,200",
      tags: ["sample keyword"],
      est_sales: { value: 20, label: "20", computed_sales: 999999 },
      est_revenue: { value: 100, label: "$100", computed_revenue: 999999 }
    }],
    popular_tags: Array.from({ length: 300 }, (_, index) => ({
      keyword: index === 100 ? { invalid: true } : index === 299 ? "sample keyword" : `tag ${index}`,
      occurences: index,
      competition: { value: index * 100, gauge: { color: "red", width: "100%" } },
      avg_searches: { value: index * 10, gauge: { color: "green" } },
      avg_clicks: { value: index * 5 },
      ctr: { value: 50 },
      search_trend: { 202601: { value: index, color: "blue", height: "10px" } }
    }))
  }
};
const compact = compactAnalysisRecord(sampleRecord);
if (compact.data.popular_tags.length !== 250) throw new Error("Giới hạn popular tags không hoạt động.");
if (!compact.data.popular_tags.some((tag) => tag.keyword === "sample keyword")) {
  throw new Error("Keyword chính bị mất khi rút gọn popular tags.");
}
if (JSON.stringify(compact.data.popular_tags).includes("gauge")) {
  throw new Error("Dữ liệu gauge dư thừa của popular tags chưa được loại bỏ.");
}
if (compact.listingIds.length !== 2 || compact.data.listings[0].views !== 1200) {
  throw new Error("Chuẩn hóa dữ liệu listing không chính xác.");
}
if (compact.data.listings[0].est_revenue.computed_revenue !== 999999) {
  throw new Error("Dữ liệu chi tiết eRank của listing chưa được giữ đầy đủ.");
}

const mergedListings = collectListingItems([
  { keyword: "alpha", collectedAt: 100, data: { listings: [{ listing_id: 7, title: "Old" }] } },
  { keyword: "beta", collectedAt: 200, data: { listings: [{ listing_id: 7, title: "New" }, { listing_id: 8, title: "Other" }] } }
], true);
if (
  mergedListings.length !== 2
  || mergedListings[0].title !== "New"
  || mergedListings[0]._keywords.join(",") !== "alpha,beta"
) {
  throw new Error("Chống trùng Top Listings không gộp đúng listing_id, keyword hoặc dữ liệu mới nhất.");
}

let sortRules = cycleSortRules([], "a", "number");
sortRules = cycleSortRules(sortRules, "b", "number");
sortRules = cycleSortRules(sortRules, "b", "number");
const sorted = sortRows([
  { id: "first", a: 2, b: 1 },
  { id: "second", a: 1, b: 2 },
  { id: "third", a: 1, b: 5 },
  { id: "fourth", a: 2, b: 9 }
], sortRules);
if (sorted.map((row) => row.id).join(",") !== "third,second,fourth,first") {
  throw new Error("Multi-sort không giữ đúng ưu tiên A tăng dần rồi B giảm dần.");
}
sortRules = cycleSortRules(sortRules, "b", "number");
if (sortRules.length !== 1 || sortRules[0].key !== "a") {
  throw new Error("Chu kỳ sort không trở về idle hoặc không đánh lại thứ tự ưu tiên.");
}

console.log(`OK: Manifest V3, ${sourceKeywords.length} keywords, curl hợp lệ, JavaScript đúng cú pháp.`);
