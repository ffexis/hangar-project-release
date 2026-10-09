// Hangar WebUI — 通用对话框：标题 + 自定义 body（HTML）+ 按钮组。
// 承载确认通知 / 复选 / 单选等交互；Promise resolve 被点按钮的 value，
// 点外部 / Esc / 系统返回视为取消（resolve null）。
// 返回值除 Promise 外还挂 root（DOM 节点，供调用方实时刷新内容）。
import { ovOpen, ovClose, esc } from "./core.js";

export function openDialog({ title, body = "", actions = [], validate, onOpen }) {
  let dismiss = () => {};
  let mask = null;
  const promise = new Promise((resolve) => {
    mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML =
      `<div class="modal dlg-modal" role="dialog" aria-modal="true">` +
      `<h3>${esc(title)}</h3>` +
      `<div class="dlg-body">${body}</div>` +
      `<div class="form-actions">` +
      actions.map((a, i) =>
        `<button type="button" class="btn${a.primary ? " primary" : ""}${a.danger ? " danger" : ""}" data-i="${i}">${esc(a.label)}</button>`
      ).join("") +
      `</div></div>`;
    document.body.appendChild(mask);
    document.body.classList.add("modal-open");

    let result = null;
    let closed = false;
    dismiss = () => {
      if (closed) return;
      closed = true;
      promise.closed = true;
      mask.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      result = null;
      ovClose(dismiss);
    };
    document.addEventListener("keydown", onKey, true);
    mask.addEventListener("click", (e) => {
      if (e.target === mask) { result = null; ovClose(dismiss); }
    });
    Array.from(mask.querySelectorAll("button[data-i]")).forEach((b) => {
      const a = actions[Number(b.dataset.i)];
      b.onclick = () => {
        // validate 只约束主操作（确认类按钮），取消按钮始终放行
        if (a.primary && validate && !validate(mask)) return;
        result = a.value;
        ovClose(dismiss);
      };
    });
    if (onOpen) onOpen(mask);
    ovOpen(dismiss);
  });
  promise.root = mask;
  promise.dismiss = () => dismiss();
  return promise;
}
