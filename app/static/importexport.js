// Hangar WebUI — 导入/导出：右上角工具栏入口 + 通用 dialog 承载确认流程。
// 导出：勾选含照片/含高德 Key → GET /export 下载 ZIP（读 X-Export-Note 提示）。
// 导入：选 .zip → 分块并发上传（复用 1.2.1 机制）→ complete → 模式确认 → POST /imports。
import { $, api, apiKey, toast, uuidv4, esc, openLoginModal } from "./core.js";
import { openDialog } from "./dialog.js";

const CHUNK_SIZE = 1024 * 1024;
const CONCURRENCY = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 原始请求：导入流程需要拿到 400 的 detail 对象（缺块续传 / 校验错误列表），
// 不能走 api() 的统一 toast 路径。
async function rawReq(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  const key = apiKey();
  if (key) headers["X-API-Key"] = key;
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let json = null;
  try { json = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}

function detailText(d, fallback) {
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.join("；");
  return fallback;
}

// ---------- 导出（v1.3.2：预估 + 后台任务打包 + 轮询进度） ----------

const GB = 1024 ** 3;
const fmtSize = (n) =>
  n >= GB ? (n / GB).toFixed(2) + " GB"
  : n >= 1048576 ? (n / 1048576).toFixed(1) + " MB"
  : Math.max(1, Math.round(n / 1024)) + " KB";

// 弹窗保持打开直到下载完成（validate 恒返回 false）；失败时恢复可重试。
async function startExportJob(mask, promise, photos, amap) {
  const st = mask.querySelector("#dlg-export-status");
  const prog = mask.querySelector(".dlg-progress");
  const bar = mask.querySelector(".dlg-progress-bar");
  prog.classList.remove("hidden");
  // 进行中锁定：点外部/Esc/导出按钮均无效，只能取消（旧版 dialog.js 无此方法时跳过）
  if (typeof promise.setLocked === "function") promise.setLocked(true);
  const fail = (msg) => {
    st.innerHTML = `<span class="dlg-warn">${esc(msg)}</span>`;
    mask._exporting = false;
    if (typeof promise.setLocked === "function") promise.setLocked(false);
  };
  st.textContent = "创建导出任务…";
  const r = await rawReq("/api/v1/export/jobs", {
    method: "POST",
    body: JSON.stringify({ include_photos: photos ? 1 : 0, include_amap: amap ? 1 : 0 }),
  });
  if (r.status === 401) { fail("需要登录（API Key 无效）"); openLoginModal(); return; }
  let jobId = null;
  if (r.status === 200) jobId = r.json && r.json.job_id;
  else if (r.status === 409) {
    // 已有任务在打包（如另一页签发起）：直接续轮询该任务
    jobId = r.json && r.json.detail && r.json.detail.job_id;
  }
  if (!jobId) { fail("创建任务失败，请重试"); return; }
  st.textContent = "任务已创建，等待打包…";

  let netFails = 0;
  for (;;) {
    await sleep(1000);
    if (promise.closed) return; // 用户已关窗，任务交由服务端 TTL 清理
    let s;
    try {
      s = await rawReq(`/api/v1/export/jobs/${jobId}`);
    } catch (e) {
      // 慢链路偶发网络错误：容忍连续 4 次，避免轮询静默死亡导致 UI 卡死
      if (++netFails >= 5) { fail("网络中断，进度查询失败。包可能仍在后台打包，稍后可重新导出"); return; }
      continue;
    }
    netFails = 0;
    if (s.status === 404) { fail("任务已失效（服务可能已重启），请重新导出"); return; }
    const j = s.json || {};
    if (j.status === "error") { fail("打包失败：" + (j.error || "未知错误")); return; }
    if (j.status === "ready") break;
    bar.style.width = (j.progress || 0) + "%";
    st.textContent = `打包中 ${j.progress || 0}%（${fmtSize(j.bytes_done || 0)}/${fmtSize(j.bytes_total || 0)}）`;
  }

  // 下载：流式读取并显示字节进度（大包经慢链路要几分钟，不能只写"开始下载"）
  let res;
  try {
    res = await fetch(`/api/v1/export/jobs/${jobId}/download`,
      { headers: { "X-API-Key": apiKey() } });
  } catch (e) { /* 按失败处理 */ }
  if (!res || !res.ok) {
    fail("下载失败" + (res ? `（${res.status}）` : "") + "，包已就绪，可重新导出");
    return;
  }
  const note = res.headers.get("X-Export-Note");
  const total = Number(res.headers.get("Content-Length")) || 0;
  const dl = async () => {
    // 有 body 流则边读边更新进度；不支持则退回一次性 blob
    if (!res.body || !res.body.getReader) return res.blob();
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total) {
        const pct = Math.min(99, Math.round((got / total) * 100));
        bar.style.width = pct + "%";
        st.textContent = `下载中 ${pct}%（${fmtSize(got)}/${fmtSize(total)}）`;
      } else {
        st.textContent = `下载中 ${fmtSize(got)}…`;
      }
      if (promise.closed) return null; // 用户中途取消
    }
    return new Blob(chunks, { type: "application/zip" });
  };
  const blob = await dl();
  if (!blob) return; // 下载途中关窗
  bar.style.width = "100%";
  if (note) {
    try { toast(decodeURIComponent(note), true); }
    catch (e) { toast(note, true); }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const m = (res.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/);
  a.download = m ? m[1] : "hangar-export.zip";
  a.click();
  URL.revokeObjectURL(url);
  rawReq(`/api/v1/export/jobs/${jobId}`, { method: "DELETE" }); // 服务端清理临时包
  st.textContent = "导出完成：" + a.download;
  if (typeof promise.setLocked === "function") promise.setLocked(false);
  setTimeout(() => promise.dismiss(), 1500);
}

async function openExportDialog() {
  let pv;
  try { pv = await api("/api/v1/export/preview"); }
  catch (e) { return; } // api() 已 toast（含 401 登录引导）
  const promise = openDialog({
    title: "导出数据",
    body:
      `<p class="muted" id="dlg-export-est"></p>` +
      `<label class="dlg-check"><input type="checkbox" id="dlg-photos" checked> 包含照片（原图，包体较大）</label>` +
      `<label class="dlg-check"><input type="checkbox" id="dlg-amap"> 包含高德 Key（导出包将加密）</label>` +
      `<div class="dlg-progress hidden"><div class="dlg-progress-bar"></div></div>` +
      `<p class="dlg-status muted" id="dlg-export-status"></p>`,
    actions: [
      { label: "取消", value: "cancel" },
      { label: "导出", value: "export", primary: true },
    ],
    onOpen: (mask) => {
      const est = mask.querySelector("#dlg-export-est");
      const sync = () => {
        const withPhotos = mask.querySelector("#dlg-photos").checked;
        const total = withPhotos ? pv.total_bytes : pv.json_bytes;
        let t = withPhotos
          ? `导出包约 ${fmtSize(total)}（含 ${pv.photo_count} 张原图）`
          : `导出包约 ${fmtSize(total)}（仅档案 JSON，不含照片）`;
        if (total > 2 * GB) t += " · 包较大，导出期间请保持页面打开";
        est.textContent = t;
      };
      mask.querySelector("#dlg-photos").onchange = sync;
      sync();
    },
    validate: (mask) => {
      if (mask._exporting) return false; // 进行中，禁止重复提交
      mask._exporting = true;
      // fire-and-forget 的 async 调用：必须兜住异常，否则静默死亡无从排查
      startExportJob(mask, promise,
        mask.querySelector("#dlg-photos").checked,
        mask.querySelector("#dlg-amap").checked).catch((e) => {
        console.error("[export]", e);
        const st = mask.querySelector("#dlg-export-status");
        st.innerHTML = `<span class="dlg-warn">导出流程异常：${esc(String((e && e.message) || e))}</span>`;
        mask._exporting = false;
        if (typeof promise.setLocked === "function") promise.setLocked(false);
      });
      return false; // 保持弹窗展示进度，下载完成后自动关闭
    },
  });
}

// ---------- 导入：分块上传 ----------

async function uploadImportZip(file, statusEl) {
  const u = { done: new Set(), uploadId: uuidv4() };
  const chunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
  const totalBytes = file.size || 1;
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  const doneBytes = () => {
    let b = 0;
    for (const i of u.done) b += (i === chunks - 1) ? file.size - i * CHUNK_SIZE : CHUNK_SIZE;
    return b;
  };
  const showProgress = () => {
    const pct = Math.min(99, Math.round((doneBytes() / totalBytes) * 100));
    statusEl.textContent = `上传中 · 已传 ${mb(doneBytes())}/${mb(totalBytes)}MB（${pct}%）`;
  };

  // 返回 "ok" | "authFail" | "fail"（401 立即中止，其余退避重试 4 次）
  const sendOne = async (i) => {
    const fd = new FormData();
    fd.append("upload_id", u.uploadId);
    fd.append("index", String(i));
    fd.append("total", String(chunks));
    fd.append("file", file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size)), file.name);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(1000 * 2 ** (attempt - 1));
      const r = await rawReq("/api/v1/imports/chunk", { method: "POST", body: fd });
      if (r.status === 200) return "ok";
      if (r.status === 401) return "authFail";
    }
    return "fail";
  };

  const queue = [];
  for (let i = 0; i < chunks; i++) queue.push(i);
  const flags = { authFail: false, failed: false };
  const worker = async () => {
    while (!flags.authFail && !flags.failed && queue.length) {
      const i = queue.shift();
      const r = await sendOne(i);
      if (r === "ok") { u.done.add(i); showProgress(); }
      else if (r === "authFail") flags.authFail = true;
      else flags.failed = true;
    }
  };
  showProgress();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks) }, worker));

  if (flags.authFail) return { error: "需要登录（API Key 无效）" };
  if (flags.failed) return { error: "有分块上传失败，请重试" };

  // complete：服务端报缺块则补传后重试一次
  let r = await rawReq("/api/v1/imports/complete", {
    method: "POST", body: JSON.stringify({ upload_id: u.uploadId }),
  });
  const d = r.json && r.json.detail;
  if (r.status === 400 && d && Array.isArray(d.missing)) {
    for (const i of d.missing) {
      const rr = await sendOne(i);
      if (rr !== "ok") return { error: "补传失败，请重试" };
    }
    r = await rawReq("/api/v1/imports/complete", {
      method: "POST", body: JSON.stringify({ upload_id: u.uploadId }),
    });
  }
  if (r.status !== 200) return { error: detailText(r.json && r.json.detail, "合并失败，请重试") };
  return { token: r.json.import_token };
}

// ---------- 导入：执行 ----------

// 返回 true=成功（窗口已关），false=失败（错误已写入 statusEl，窗口保持打开）
async function runImport(token, mode, statusEl, dlgPromise) {
  statusEl.textContent = "导入中…";
  const r = await rawReq("/api/v1/imports", {
    method: "POST", body: JSON.stringify({ import_token: token, mode }),
  });
  if (r.status === 401) {
    statusEl.innerHTML = `<span class="dlg-warn">需要登录（API Key 无效）</span>`;
    openLoginModal();
    return false;
  }
  if (r.status === 200) {
    const rep = r.json;
    statusEl.textContent =
      `完成：导入 ${rep.imported} 台` +
      (rep.skipped ? `，跳过 ${rep.skipped}` : "") +
      (rep.photos_imported ? `，照片 ${rep.photos_imported}` : "") +
      (rep.photos_missing ? `，缺失 ${rep.photos_missing}` : "");
    if (rep.warnings && rep.warnings.length) {
      statusEl.innerHTML += "<br>" +
        rep.warnings.map((w) => `<span class="dlg-warn">${esc(w)}</span>`).join("<br>");
    }
    setTimeout(() => dlgPromise.dismiss(), 2600);
    const { refreshAll } = await import("./main.js");
    refreshAll();
    return true;
  }
  // 结构性校验失败：整包拒绝，服务端已消费 token，必须重新选文件
  const detail = r.json && r.json.detail;
  const list = Array.isArray(detail) ? detail : [detailText(detail, "导入失败")];
  statusEl.innerHTML = `<span class="dlg-warn">整包被拒绝（未做任何改动）：</span><br>` +
    list.slice(0, 8).map((e) => `<span class="dlg-warn">${esc(String(e))}</span>`).join("<br>") +
    (list.length > 8 ? `<br><span class="dlg-warn">…共 ${list.length} 项</span>` : "") +
    `<br><span class="dlg-warn">请修正后重新选择文件导入。</span>`;
  return false;
}

// 模式确认对话框；replace 硬门禁（必须勾选确认清空后才放行）
function openModeDialog(token, count) {
  const promise = openDialog({
    title: "导入数据",
    body:
      `<p class="muted">包内含 <b>${count}</b> 台机体记录 · 当前库有 <b>${count}</b> 台。</p>` +
      `<label class="dlg-radio"><input type="radio" name="dlg-mode" value="replace" checked> 覆盖（清空现有数据后导入）</label>` +
      `<label class="dlg-radio"><input type="radio" name="dlg-mode" value="merge"> 合并（按编号 upsert，不动其余数据）</label>` +
      `<label class="dlg-check" id="dlg-hard"><input type="checkbox" id="dlg-hard-chk"> 我已确认：现有数据将被全部清空</label>` +
      `<p class="dlg-status" id="dlg-import-status"></p>`,
    actions: [
      { label: "取消", value: "cancel" },
      { label: "开始导入", value: "import", primary: true },
    ],
    validate: (m) => {
      const st = m.querySelector("#dlg-import-status");
      if (st.textContent.indexOf("导入中") === 0) return false;
      const mode = m.querySelector('input[name="dlg-mode"]:checked').value;
      if (mode === "replace" && !m.querySelector("#dlg-hard-chk").checked) {
        st.innerHTML = `<span class="dlg-warn">请先勾选确认「清空现有数据」</span>`;
        return false;
      }
      st.textContent = "";
      return true;
    },
    onOpen: (m) => {
      const hard = m.querySelector("#dlg-hard");
      const sync = () => {
        const mode = m.querySelector('input[name="dlg-mode"]:checked').value;
        hard.classList.toggle("hidden", mode !== "replace");
        if (mode !== "replace") m.querySelector("#dlg-hard-chk").checked = false;
      };
      m.querySelectorAll('input[name="dlg-mode"]').forEach((r) => { r.onchange = sync; });
      sync();
    },
  });
  promise.then(async (v) => {
    if (v !== "import") return;
    const m = promise.root;
    const mode = m.querySelector('input[name="dlg-mode"]:checked').value;
    await runImport(token, mode, m.querySelector("#dlg-import-status"), promise);
  });
  return promise;
}

async function openImportFlow() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip";
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { toast("仅支持 .zip 导出包", true); return; }

    // 阶段一：分块上传（进度显示在对话框内）
    const upPromise = openDialog({
      title: "导入数据",
      body: `<p class="muted">${esc(file.name)}（${(file.size / 1048576).toFixed(1)} MB）</p>` +
        `<p class="dlg-status" id="dlg-up-status">准备上传…</p>`,
      actions: [{ label: "取消", value: "cancel" }],
    });
    const statusEl = upPromise.root.querySelector("#dlg-up-status");
    const res = await uploadImportZip(file, statusEl);
    if (upPromise.closed) return; // 用户已取消
    if (res.error) {
      statusEl.innerHTML = `<span class="dlg-warn">${esc(res.error)}</span>`;
      setTimeout(() => upPromise.dismiss(), 2200);
      return;
    }
    upPromise.dismiss();

    // 阶段二：空库直接 replace（无需确认覆盖）；有数据弹模式确认
    let count = 0;
    try { count = (await api("/api/v1/models")).length; } catch (e) { /* toast 已提示 */ }
    if (count === 0) {
      const promise = openDialog({
        title: "导入数据",
        body: `<p class="muted">当前库为空，直接以覆盖模式导入。</p>` +
          `<p class="dlg-status" id="dlg-import-status"></p>`,
        actions: [{ label: "关闭", value: "cancel" }],
      });
      await runImport(res.token, "replace",
        promise.root.querySelector("#dlg-import-status"), promise);
    } else {
      openModeDialog(res.token, count);
    }
  };
  input.click();
}

// ---------- 入口 ----------

export function initImportExport() {
  const btn = $("#btn-io");
  const menu = $("#io-menu");
  if (!btn || !menu) return;
  btn.onclick = (e) => {
    e.stopPropagation();
    // 与主题菜单互斥：trigger 的 click 已 stopPropagation，需手动收起另一个菜单
    const themeMenu = $("#theme-menu");
    if (themeMenu) themeMenu.classList.add("hidden");
    menu.classList.toggle("hidden");
  };
  menu.addEventListener("click", (e) => {
    const act = e.target.closest("button[data-io]");
    if (!act) return;
    menu.classList.add("hidden");
    if (!apiKey()) { toast("请先登录", true); openLoginModal(); return; }
    if (act.dataset.io === "export") openExportDialog();
    else openImportFlow();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#io-picker")) menu.classList.add("hidden");
  });
}
