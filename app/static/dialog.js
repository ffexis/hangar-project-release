// Hangar WebUI — 通用对话框：标题 + 自定义 body（HTML）+ 按钮组。
// 承载确认通知 / 复选 / 单选等交互；Promise resolve 被点按钮的 value，
// 点外部 / Esc / 系统返回视为取消（resolve null）。
// 返回值除 Promise 外还挂 root（DOM 节点，供调用方实时刷新内容）与
// setLocked（进行中锁定，仅取消可退出）。
import { ovOpen, ovClose, esc } from "./core.js";

export function openDialog({ title, body = "", actions = [], validate, onOpen }) {
  let dismiss = () => {};
  let mask = null;
  let setLocked = () => {}; // executor 内赋值，构造后再挂到 promise（避免 TDZ）
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
    let locked = false; // 锁定态：进行中禁止点外部/Esc/主按钮关闭，只能点取消
    const closeNow = () => {
      if (closed) return;
      closed = true;
      promise.closed = true;
      mask.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    // 浮层栈入口：锁定态下系统返回无效（重新压入哨兵抵消这次 popstate）
    const guardedClose = () => {
      if (locked && !closed) { ovOpen(guardedClose); return; }
      closeNow();
    };
    dismiss = guardedClose;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (locked) return;
      result = null;
      ovClose(guardedClose);
    };
    document.addEventListener("keydown", onKey, true);
    mask.addEventListener("click", (e) => {
      if (e.target !== mask) return;
      if (locked) return;
      result = null;
      ovClose(guardedClose);
    });
    const buttons = Array.from(mask.querySelectorAll("button[data-i]"));
    buttons.forEach((b) => {
      const a = actions[Number(b.dataset.i)];
      b.onclick = () => {
        if (locked && a.primary) return; // 锁定态禁用主按钮
        // validate 只约束主操作（确认类按钮），取消按钮始终放行
        if (a.primary && validate && !validate(mask)) return;
        result = a.value;
        ovClose(guardedClose);
      };
    });
    // 锁定/解锁：进行中禁止关闭弹窗（点外部/Esc/系统返回/主按钮），仅取消可退出
    setLocked = (v) => {
      locked = !!v;
      buttons.forEach((b) => {
        const a = actions[Number(b.dataset.i)];
        if (a.primary) b.disabled = locked;
      });
    };
    if (onOpen) onOpen(mask);
    ovOpen(guardedClose);
  });
  promise.root = mask;
  promise.dismiss = () => dismiss();
  promise.setLocked = (v) => setLocked(v);
  return promise;
}
