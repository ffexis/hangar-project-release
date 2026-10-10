// Hangar WebUI — 详情模态框：字段渲染 / 照片网格 / 上传删除 / 排序
import { $, api, apiKey, esc, thumbUrl, tagBadges, gradeCell, toast, ovOpen, ovClose, LOGGED_IN, uuidv4 } from "./core.js";
import { openLightbox } from "./lightbox.js";
import { loadList } from "./list.js";

const FIELD_LABELS = {
  id: "编号", name: "名称", category: "类别", grade: "级别", item_no: "官方货号",
  scale: "比例", limited: "限定类型", origin: "来源", status: "状态",
  storage: "存放位置", display: "展示", owner: "归属", purchase_date: "购买日期",
  done_date: "完成日期",
  comment: "评价 / 备注", photos: "照片", tags: "标签",
};

// 分块大小 1MB（服务端 CHUNK_MAX_BYTES=2MB 校验保持不变，留余量）；块越小单次失败重传代价越小
const CHUNK_SIZE = 1024 * 1024;
// 每文件内块并发数；文件之间仍逐张串行，避免浏览器连接被多文件抢满、状态文字混乱
const CONCURRENCY = 3;

let DETAIL_MODEL = null;
let UPLOAD = null; // 分块上传会话 {files, fi, done:Set, uploadId, ok, fail, paused}

export async function showDetail(id) {
  const m = await api("/api/v1/models/" + encodeURIComponent(id));
  DETAIL_MODEL = m;
  $("#detail-title").textContent = m.name;
  const box = $("#detail-body");
  box.innerHTML = "";
  Object.keys(FIELD_LABELS).forEach((k) => {
    if (k === "photos") return;
    const row = document.createElement("div");
    // 评价/备注：标题独立行，内容另起一行并保留换行
    row.className = k === "comment" ? "drow drow-block" : "drow";
    let v = m[k];
    if (k === "display") v = m.display ? "展示中" : "未展示";
    let html;
    if (k === "grade") html = gradeCell(v);
    else if (k === "tags") html = tagBadges(v);
    else if (k === "comment") html = v ? esc(v) : "";
    else html = esc(v == null ? "" : v);
    row.innerHTML = `<span class="dk">${FIELD_LABELS[k]}</span><span class="dv">${html}</span>`;
    box.appendChild(row);
  });
  renderPhotos(m);
  $("#detail-modal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  ovOpen(closeDetail);
}

export function closeDetail() {
  $("#detail-modal").classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function renderPhotos(m) {
  DETAIL_MODEL = m;
  const photos = m.photos || [];
  $("#photos-tools").classList.toggle("hidden", !LOGGED_IN);
  $("#upload-status").textContent = "";
  const g = $("#photos-grid");
  g.innerHTML = "";
  if (!photos.length) {
    g.innerHTML = '<span class="muted">暂无照片。</span>';
    return;
  }
  photos.forEach((p, i) => {
    const cell = document.createElement("div");
    cell.className = "photo-cell";
    const img = document.createElement("img");
    img.src = thumbUrl(p);
    img.alt = m.name;
    img.loading = "lazy";
    img.onclick = () => openLightbox(p, photos, m.id);
    cell.appendChild(img);
    if (LOGGED_IN) {
      const del = document.createElement("button");
      del.className = "photo-del";
      del.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><path fill="currentColor" d="m19.61 18l4.86-4.86a1 1 0 0 0-1.41-1.41l-4.86 4.81l-4.89-4.89a1 1 0 0 0-1.41 1.41L16.78 18L12 22.72a1 1 0 1 0 1.41 1.41l4.77-4.77l4.74 4.74a1 1 0 0 0 1.41-1.41Z"/><path fill="currentColor" d="M18 34a16 16 0 1 1 16-16a16 16 0 0 1-16 16m0-30a14 14 0 1 0 14 14A14 14 0 0 0 18 4"/></svg>';
      del.title = "删除这张";
      del.onclick = () => deletePhoto(m.id, p);
      cell.appendChild(del);
      // 上移/下移（首尾禁用对应方向）
      const mv = document.createElement("div");
      mv.className = "photo-move";
      const up = document.createElement("button");
      up.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path stroke-linejoin="round" d="M15 13.5L12 10.5L9 13.5"/></g></svg>';
      up.title = "上移";
      up.disabled = i === 0;
      up.onclick = () => movePhoto(i, i - 1);
      const dn = document.createElement("button");
      dn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path stroke-linejoin="round" d="M15 10.5L12 13.5L9 10.5"/></g></svg>';
      dn.title = "下移";
      dn.disabled = i === photos.length - 1;
      dn.onclick = () => movePhoto(i, i + 1);
      mv.appendChild(up);
      mv.appendChild(dn);
      cell.appendChild(mv);
    }
    g.appendChild(cell);
  });
}

async function movePhoto(from, to) {
  const photos = (DETAIL_MODEL.photos || []).slice();
  if (to < 0 || to >= photos.length) return;
  const [moved] = photos.splice(from, 1);
  photos.splice(to, 0, moved);
  try {
    const updated = await api(`/api/v1/models/${encodeURIComponent(DETAIL_MODEL.id)}/photos/order`, {
      method: "PUT",
      body: JSON.stringify({ order: photos }),
    });
    renderPhotos(updated);
    loadList();
  } catch (e) { /* api() 已 toast */ }
}

async function deletePhoto(id, url) {
  const fn = url.split("/").pop();
  if (!confirm(`确认删除 ${fn}？`)) return;
  const updated = await api(
    `/api/v1/models/${encodeURIComponent(id)}/photos/${encodeURIComponent(fn)}`,
    { method: "DELETE" }
  );
  toast("已删除照片");
  renderPhotos(updated);
  loadList();
}

async function uploadPhotos(files) {
  UPLOAD = { files: Array.from(files), fi: 0, done: new Set(), uploadId: null, ok: 0, fail: 0, paused: false };
  await runUpload();
}

// 原始请求（分块循环需要拿到 400 的 detail 对象做续传，不能走 api() 的 toast 路径）
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 当前文件已传字节（done 块的真实字节和，末块按实际长度计；在途块不计，保证单调不回跳）
function doneBytesOfCurrentFile(u) {
  const file = u.files[u.fi];
  const chunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
  let bytes = 0;
  for (const i of u.done) {
    bytes += (i === chunks - 1) ? file.size - i * CHUNK_SIZE : CHUNK_SIZE;
  }
  return bytes;
}

// 进度文字按字节聚合（并发后块号不再单调递增）
function progressText() {
  const u = UPLOAD;
  const totalBytes = u.files.reduce((s, f) => s + f.size, 0) || 1;
  const priorBytes = u.files.slice(0, u.fi).reduce((s, f) => s + f.size, 0);
  const doneBytes = priorBytes + doneBytesOfCurrentFile(u);
  const pct = Math.min(99, Math.round((doneBytes / totalBytes) * 100));
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  return `上传中 ${u.fi + 1}/${u.files.length} 张 · 已传 ${mb(doneBytes)}/${mb(totalBytes)}MB（${pct}%）`;
}

function setPaused(pause) {
  UPLOAD.paused = pause;
  const btn = $("#btn-upload");
  btn.querySelector(".up-label").textContent = pause ? "继续" : "上传照片";
}

async function runUpload() {
  const u = UPLOAD;
  const btn = $("#btn-upload");
  const status = $("#upload-status");
  btn.disabled = true;
  setPaused(false);
  while (u.fi < u.files.length) {
    const file = u.files[u.fi];
    if (!u.uploadId) u.uploadId = uuidv4();
    const chunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
    const id = encodeURIComponent(DETAIL_MODEL.id);
    const result = await uploadFileWithChunks(u, id, file, chunks);
    if (result === "authFail") {
      u.fail++; u.fi++; u.done = new Set(); u.uploadId = null;
      continue;
    }
    if (result === "paused") {
      status.textContent = "已暂停（网络中断），点击上传按钮续传";
      setPaused(true);
      btn.disabled = false;
      return;
    }
    // 全部块就绪 → complete；若服务端报缺块则补传缺失块后重试一次
    let done = await tryComplete(u, id);
    if (!done.ok && done.missing) {
      for (const i of done.missing) await sendOneChunk(u, id, i, chunks, file);
      done = await tryComplete(u, id);
    }
    if (done.ok && done.model) {
      DETAIL_MODEL = done.model;
      renderPhotosKeepStatus(done.model);
      u.ok++;
    } else {
      u.fail++;
    }
    u.fi++; u.done = new Set(); u.uploadId = null;
  }
  btn.disabled = false;
  setPaused(false);
  status.textContent = `完成：成功 ${u.ok}${u.fail ? "，失败 " + u.fail : ""}`;
  UPLOAD = null;
  loadList();
}

// worker pool：CONCURRENCY 个并发发送本文件的各块；文件之间仍逐张串行。
// 返回 "ok" | "paused" | "authFail"。
async function uploadFileWithChunks(u, id, file, chunks) {
  const queue = [];
  for (let i = 0; i < chunks; i++) if (!u.done.has(i)) queue.push(i);
  const flags = { paused: false, authFail: false };
  const status = $("#upload-status");
  const worker = async () => {
    while (!flags.paused && !flags.authFail && queue.length) {
      const i = queue.shift();
      let sent = false;
      for (let attempt = 0; attempt < 4 && !sent && !flags.authFail; attempt++) {
        if (attempt) await sleep(1000 * 2 ** (attempt - 1)); // 退避 1s/2s/4s
        status.textContent = progressText();
        const fd = new FormData();
        fd.append("upload_id", u.uploadId);
        fd.append("index", String(i));
        fd.append("total", String(chunks));
        fd.append("file", file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size)), file.name);
        const r = await rawReq(`/api/v1/models/${id}/photos/chunk`, { method: "POST", body: fd });
        if (r.status === 200) sent = true;
        else if (r.status === 401) flags.authFail = true;
      }
      if (sent) { u.done.add(i); status.textContent = progressText(); }
      else if (!flags.authFail) flags.paused = true; // 重试耗尽 → 该文件暂停
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks) }, worker));
  if (flags.authFail) return "authFail";
  if (flags.paused) return "paused";
  return "ok";
}

async function tryComplete(u, id) {
  const r = await rawReq(`/api/v1/models/${id}/photos/complete`, {
    method: "POST",
    body: JSON.stringify({ upload_id: u.uploadId, filename: u.files[u.fi].name }),
  });
  if (r.status === 200) return { ok: true, model: r.json };
  const d = r.json && r.json.detail;
  if (d && Array.isArray(d.missing)) return { ok: false, missing: d.missing };
  return { ok: false };
}

async function sendOneChunk(u, id, i, chunks, file) {
  const blob = file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size));
  const fd = new FormData();
  fd.append("upload_id", u.uploadId);
  fd.append("index", String(i));
  fd.append("total", String(chunks));
  fd.append("file", blob, file.name);
  await rawReq(`/api/v1/models/${id}/photos/chunk`, { method: "POST", body: fd });
}

function renderPhotosKeepStatus(m) {
  const status = $("#upload-status").textContent;
  renderPhotos(m);
  $("#upload-status").textContent = status;
}

// 详情模态框关闭交互（× / 点外部）
export function initDetail() {
  $("#btn-detail-close").onclick = () => ovClose(closeDetail);
  $("#detail-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) ovClose(closeDetail);
  });
  $("#btn-upload").onclick = () => {
    if (UPLOAD && UPLOAD.paused) { runUpload(); return; } // 续传
    $("#file-input").click();
  };
  $("#file-input").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) uploadPhotos(files);
    e.target.value = "";
  });
}
