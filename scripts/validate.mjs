import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const extension = path.join(root, "extension");
const required = [
  "manifest.json", "background.js", "scraper.js", "popup.html", "popup.js",
  "popup.css", "dashboard.html", "dashboard.js", "dashboard.css",
  "default-keywords.js", "data-store.js"
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

for (const file of ["background.js", "scraper.js", "popup.js", "dashboard.js", "data-store.js"]) {
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

const { compactAnalysisRecord } = await import(path.join(extension, "data-store.js"));
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
      keyword: index === 299 ? "sample keyword" : `tag ${index}`,
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
if (JSON.stringify(compact).includes("gauge") || JSON.stringify(compact).includes("computed_revenue")) {
  throw new Error("Dữ liệu trình bày dư thừa chưa được loại bỏ.");
}
if (compact.listingIds.length !== 2 || compact.data.listings[0].views !== 1200) {
  throw new Error("Chuẩn hóa dữ liệu listing không chính xác.");
}

console.log(`OK: Manifest V3, ${sourceKeywords.length} keywords, curl hợp lệ, JavaScript đúng cú pháp.`);
