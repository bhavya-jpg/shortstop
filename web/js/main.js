// App shell: hash router, sticky header, service status, footer, scroll reveals.
import { api } from "./api.js";
import { h, closeDrawer, toast } from "./dom.js";
import { homeView, renderFooter } from "./landing.js";
import { commandView, decisionsView, runView, memoryView, systemView } from "./views.js";

const view = document.getElementById("view");
const header = document.getElementById("site-header");
const footer = document.getElementById("site-footer");
const ctx = { meta: null, onLeave: null };

function setStatus(id, state, title) {
  const el = document.getElementById(id);
  el.classList.remove("ok", "down", "idle");
  el.classList.add(state);
  el.title = title;
}

async function refreshHealth() {
  try {
    const hh = await api.health();
    const map = (x) => (x.status === "ok" ? "ok" : x.status === "not_used" ? "idle" : "down");
    setStatus("svc-zetaris", map(hh.zetaris), hh.zetaris.status === "ok" ? `Zetaris online · ${hh.zetaris.latency_ms} ms` : hh.zetaris.detail ?? hh.zetaris.status);
    setStatus("svc-nightshift", map(hh.nightshift), hh.nightshift.status === "ok" ? `Nightshift online · ${hh.nightshift.models} models` : hh.nightshift.detail ?? hh.nightshift.status);
    setStatus("svc-hmem", "ok", `H-MEM · ${hh.hmem.precedents} precedents`);
  } catch (err) {
    for (const id of ["svc-zetaris", "svc-nightshift", "svc-hmem"]) setStatus(id, "down", err.message);
  }
}

// Fades sections in as they scroll into view.
let observer = null;
function observeReveals() {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("shown"); observer.unobserve(e.target); }
  }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
  view.querySelectorAll(".inview").forEach((el) => observer.observe(el));
}

const routes = {
  home: () => homeView(ctx),
  command: () => commandView(ctx),
  decisions: () => decisionsView(ctx),
  memory: () => memoryView(ctx),
  system: () => systemView(ctx),
  run: (id) => runView(ctx, id),
};

async function render() {
  const [, name = "", arg] = location.hash.split("/");
  const route = routes[name] ? name : "home";
  const home = route === "home";
  document.body.classList.toggle("is-home", home);
  view.classList.toggle("home", home);
  renderFooter(footer, !home);
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === route || (route === "run" && a.dataset.route === "decisions")));
  ctx.onLeave?.();
  ctx.onLeave = null;
  const swap = async () => {
    try {
      const nodes = await routes[route](arg);
      view.classList.remove("view-enter");
      view.replaceChildren(...nodes);
      void view.offsetWidth;
      if (!home) view.classList.add("view-enter");
      observeReveals();
    } catch (err) {
      view.replaceChildren(h("div", { class: "glass panel" }, h("div", { class: "eyebrow" }, "Something went wrong"), h("p", {}, err.message)));
    }
  };
  if (document.startViewTransition) document.startViewTransition(swap);
  else await swap();
  window.scrollTo({ top: 0, behavior: "instant" });
}

async function boot() {
  try {
    ctx.meta = await api.meta();
  } catch (err) {
    view.replaceChildren(h("div", { class: "glass panel" }, h("p", {}, `Cannot reach the ShortStop server: ${err.message}`)));
    return;
  }
  const pill = document.getElementById("mode-pill");
  pill.textContent = ctx.meta.mode === "live" ? "Live" : "Sample mode";
  pill.classList.add(ctx.meta.mode);
  pill.title = ctx.meta.notice;
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeDrawer));
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());
  window.addEventListener("hashchange", render);
  await render();
  refreshHealth();
  setInterval(refreshHealth, 60_000);
  if (ctx.meta.mode === "sample") toast("Sample mode: no Zetaris or Nightshift call is made in this session.");
}

boot();
