import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const extension = path.join(root, "extension");
const required = [
  "manifest.json", "background.js", "scraper.js", "popup.html", "popup.js",
  "popup.css", "dashboard.html", "dashboard.js", "dashboard.css", "default-keywords.js"
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

for (const file of ["background.js", "scraper.js", "popup.js", "dashboard.js"]) {
  const source = fs.readFileSync(path.join(extension, file), "utf8")
    .replace(/^import .*?;\s*$/gm, "")
    .replace(/^export\s+/gm, "");
  new vm.Script(source, { filename: file });
}

console.log(`OK: Manifest V3, ${sourceKeywords.length} keywords, curl hợp lệ, JavaScript đúng cú pháp.`);
