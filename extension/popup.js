const $ = (selector) => document.querySelector(selector);
const statusEl = $("#status");
const detailEl = $("#detail");
const barEl = $("#bar");
const startEl = $("#start");
const stopEl = $("#stop");

function paint(state = {}) {
  const running = state.status === "running";
  const total = state.total || 0;
  const current = state.current || 0;
  statusEl.textContent = running ? `Đang xử lý ${current}/${total}` :
    state.status === "error" ? "Cần cập nhật cấu hình" :
    state.status === "done_with_errors" ? "Hoàn tất, có keyword lỗi" :
    state.status === "done" ? "Đã hoàn tất" : "Sẵn sàng";
  detailEl.textContent = state.message || "Mở dashboard để kiểm tra keyword và cấu hình curl.";
  barEl.style.width = total ? `${Math.round((current / total) * 100)}%` : "0%";
  startEl.disabled = running;
  stopEl.hidden = !running;
}

async function refresh() {
  const { jobState } = await chrome.storage.local.get("jobState");
  paint(jobState);
}

startEl.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "START_ANALYSIS" });
  if (!response?.ok) paint({ status: "error", message: response?.error || "Không thể bắt đầu." });
  else refresh();
});
stopEl.addEventListener("click", () => chrome.runtime.sendMessage({ type: "STOP_ANALYSIS" }));
$("#dashboard").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }));
chrome.storage.onChanged.addListener((changes) => changes.jobState && paint(changes.jobState.newValue));
refresh();
