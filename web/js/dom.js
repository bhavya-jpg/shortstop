// Tiny DOM helpers: element builders, animated numbers, toasts and the drawer.

const SVG_NS = "http://www.w3.org/2000/svg";

function apply(el, props) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  apply(el, props);
  append(el, children);
  return el;
}

export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, props);
  append(el, children);
  return el;
}

export const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Counts a number up from zero; decimals follow the target value.
export function countUp(el, target, { duration = 1100, decimals } = {}) {
  if (target === null || target === undefined || Number.isNaN(target)) {
    el.textContent = "—";
    return;
  }
  const d = decimals ?? (Number.isInteger(target) ? 0 : 2);
  if (reduceMotion()) {
    el.textContent = target.toFixed(d);
    return;
  }
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = (target * eased).toFixed(d);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function toast(message, kind = "info") {
  const stack = document.getElementById("toasts");
  const t = h("div", { class: `toast ${kind}` }, message);
  stack.append(t);
  setTimeout(() => {
    t.style.transition = "opacity .4s, transform .4s";
    t.style.opacity = "0";
    t.style.transform = "translateY(8px)";
    setTimeout(() => t.remove(), 420);
  }, kind === "err" ? 7000 : 4200);
}

export function openDrawer(content) {
  const drawer = document.getElementById("drawer");
  const body = document.getElementById("drawer-body");
  body.replaceChildren(content);
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  drawer.querySelector(".drawer-close").focus();
}

export function closeDrawer() {
  const drawer = document.getElementById("drawer");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
}

export function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export const STATUS = {
  PENDING_APPROVAL: { cls: "st-pending", label: "Pending approval", hint: "Validated candidates await a pharmacist." },
  ESCALATED: { cls: "st-escalated", label: "Escalated", hint: "A human must decide; reasons below." },
  MONITOR_PENDING_ACKNOWLEDGEMENT: { cls: "st-monitor", label: "Monitor", hint: "No action triggered; acknowledge to close." },
};

export function statusChip(status) {
  const st = STATUS[status];
  const kind = status === "ESCALATED" ? "unavail" : status === "PENDING_APPROVAL" ? "warn" : "ok";
  return h("span", { class: `chip ${kind}` }, st ? st.label : status);
}

export function modeChip(mode) {
  return h("span", { class: `chip ${mode === "live" ? "live" : "sample"}` }, mode === "live" ? "● Live" : "◌ Sample");
}

// Moves a radial highlight with the cursor on hover cards.
export function trackPointer(el) {
  el.addEventListener("pointermove", (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  });
}
