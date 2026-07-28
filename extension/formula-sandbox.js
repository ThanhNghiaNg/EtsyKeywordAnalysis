function formulaWorkerMain() {
  self.onmessage = ({ data }) => {
    try {
      const score = new Function(`"use strict"; return (${data.formula});`)();
      if (typeof score !== "function") throw new Error("Editor phải trả về một function score(params).");
      const results = data.paramsList.map((params, index) => {
        const result = Number(score(params));
        if (!Number.isFinite(result)) {
          throw new Error("Kết quả tại item " + (index + 1) + " không phải số hữu hạn.");
        }
        return result;
      });
      self.postMessage({ ok: true, results });
    } catch (error) {
      self.postMessage({ ok: false, error: error.message || String(error) });
    }
  };
}

const workerSource = `(${formulaWorkerMain.toString()})();`;

window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.type !== "EVALUATE_SCORE_FORMULA") return;
  const { requestId, formula, paramsList } = event.data;
  let worker;
  let workerUrl;
  let timer;
  let settled = false;
  const finish = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    worker?.terminate();
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    parent.postMessage({ type: "SCORE_FORMULA_RESULT", requestId, ...payload }, "*");
  };
  try {
    workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    worker = new Worker(workerUrl);
    timer = setTimeout(() => finish({
      ok: false,
      error: "Công thức chạy quá 2 giây và đã bị dừng."
    }), 2000);
    worker.onmessage = ({ data }) => finish(data);
    worker.onerror = (error) => finish({
      ok: false,
      error: error.message || "Formula Worker gặp lỗi."
    });
    worker.postMessage({ formula, paramsList });
  } catch (error) {
    finish({
      ok: false,
      error: `Không khởi tạo được Formula Worker: ${error.message || error}`
    });
  }
});

parent.postMessage({ type: "FORMULA_SANDBOX_READY" }, "*");
