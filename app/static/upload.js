// Hangar WebUI — 分块断点续传引擎（详情页 / 表单页共用）
// 从 detail.js 提取：把 UI 耦合（按钮 / 状态文字 / 重渲染）改为回调注入，
// 使两条上传路径共享同一套「1MB 分块 + 3 并发 + 指数退避重试 + 续传」逻辑。

import { apiKey, uuidv4 } from "./core.js";

// 分块大小 1MB（服务端 CHUNK_MAX_BYTES=2MB 校验保持不变，留余量）；块越小单次失败重传代价越小
export const CHUNK_SIZE = 1024 * 1024;
// 每文件内块并发数；文件之间仍逐张串行，避免浏览器连接被多文件抢满、状态文字混乱
const CONCURRENCY = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 原始请求（分块循环需要拿到 400 的 detail 对象做续传，不能走 api() 的 toast 路径）
export async function rawReq(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  const key = apiKey();
  if (key) headers["X-API-Key"] = key;
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let json = null;
  try { json = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}

// 上传会话：files 为待传 File 列表；pauseOnFail=true 时网络重试耗尽会暂停（详情页续传），
// false 时该文件计失败并继续下一张（表单页）。
export function createSession(modelId, files, pauseOnFail) {
  return {
    modelId, files: Array.from(files), fi: 0, done: new Set(),
    uploadId: null, ok: 0, fail: 0, paused: false,
    pauseOnFail: pauseOnFail !== false,
    aborted: false,
  };
}

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
export function progressOf(u) {
  const totalBytes = u.files.reduce((s, f) => s + f.size, 0) || 1;
  const priorBytes = u.files.slice(0, u.fi).reduce((s, f) => s + f.size, 0);
  const doneBytes = priorBytes + doneBytesOfCurrentFile(u);
  const pct = Math.min(99, Math.round((doneBytes / totalBytes) * 100));
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  return {
    pct,
    text: `上传中 ${u.fi + 1}/${u.files.length} 张 · 已传 ${mb(doneBytes)}/${mb(totalBytes)}MB（${pct}%）`,
  };
}

// worker pool：CONCURRENCY 个并发发送本文件的各块；文件之间仍逐张串行。
// 返回 "ok" | "paused" | "authFail"。
async function uploadFileWithChunks(u, id, file, chunks, cb) {
  const queue = [];
  for (let i = 0; i < chunks; i++) if (!u.done.has(i)) queue.push(i);
  const flags = { paused: false, authFail: false };
  const worker = async () => {
    while (!flags.paused && !flags.authFail && !u.aborted && queue.length) {
      const i = queue.shift();
      let sent = false;
      for (let attempt = 0; attempt < 4 && !sent && !flags.authFail && !u.aborted; attempt++) {
        if (attempt) await sleep(1000 * 2 ** (attempt - 1)); // 退避 1s/2s/4s
        cb.onProgress(progressOf(u));
        const fd = new FormData();
        fd.append("upload_id", u.uploadId);
        fd.append("index", String(i));
        fd.append("total", String(chunks));
        fd.append("file", file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size)), file.name);
        const r = await rawReq(`/api/v1/models/${id}/photos/chunk`, { method: "POST", body: fd });
        if (r.status === 200) sent = true;
        else if (r.status === 401) flags.authFail = true;
      }
      if (sent) { u.done.add(i); cb.onProgress(progressOf(u)); }
      else if (!flags.authFail && !u.aborted) flags.paused = true; // 重试耗尽
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks) }, worker));
  if (flags.authFail) return "authFail";
  if (u.aborted) return "aborted";
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

// 驱动整个上传会话。cb 回调：
//   onProgress(text)        —— 每块进度文字（含百分比），调用方更新状态区
//   onFileComplete(model)   —— 单张文件完成，调用方据此重渲染（携带最新 model）
//   onStateChange(paused)   —— 暂停/恢复态变化（详情页切换按钮文字）
//   onDone(summary)         —— 全部结束 { ok, fail, aborted, paused }
// 返回会话对象 u（调用方可保存用于续传）。
export async function runUpload(u, cb) {
  const id = encodeURIComponent(u.modelId);
  cb.onStateChange && cb.onStateChange(false);
  while (u.fi < u.files.length && !u.aborted) {
    const file = u.files[u.fi];
    if (!u.uploadId) u.uploadId = uuidv4();
    const chunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
    const result = await uploadFileWithChunks(u, id, file, chunks, cb);
    if (result === "aborted") break;
    if (result === "authFail") {
      u.fail++; u.fi++; u.done = new Set(); u.uploadId = null;
      continue;
    }
    if (result === "paused") {
      if (u.pauseOnFail) {
        u.paused = true;
        cb.onStateChange && cb.onStateChange(true);
        return u; // 详情页：等待续传
      }
      // 表单页：该文件计失败，重置会话继续下一张
      u.fail++; u.fi++; u.done = new Set(); u.uploadId = null;
      continue;
    }
    // 全部块就绪 → complete；若服务端报缺块则补传缺失块后重试一次
    let done = await tryComplete(u, id);
    if (!done.ok && done.missing) {
      for (const i of done.missing) await sendOneChunk(u, id, i, chunks, file);
      done = await tryComplete(u, id);
    }
    if (done.ok && done.model) {
      u.model = done.model;
      cb.onFileComplete && cb.onFileComplete(done.model);
      u.ok++;
    } else {
      u.fail++;
    }
    u.fi++; u.done = new Set(); u.uploadId = null;
  }
  cb.onStateChange && cb.onStateChange(false);
  cb.onDone && cb.onDone({ ok: u.ok, fail: u.fail, aborted: u.aborted, paused: u.paused });
  return u;
}

// 中断一个进行中的会话：置位后各 worker 在下一次循环退出，已传照片保留。
export function abortSession(u) {
  if (u) u.aborted = true;
}
