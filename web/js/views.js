// Views: Command, Decisions, Run detail, Memory, System.
import { api } from "./api.js";
import { h, s, toast, fmtTime, fmtDate, fmtDuration, statusChip, modeChip, trackPointer, countUp } from "./dom.js";
import { createPipeline } from "./pipeline.js";
import { renderDecision } from "./decision.js";

const titleOf = (id) => id.replace(/^scenario-\d+-/, "").split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// ------------------------------------------------------------------ trace feed
function feedItem(e) {
  const ext = e.external;
  const tags = [];
  if (ext) tags.push(h("span", { class: `tag ${ext.service}` }, `${ext.service} ${ext.http_status ?? ""}`.trim()));
  if (e.model) tags.push(h("span", { class: "tag model" }, e.model.reported ?? e.model.requested));
  return h("div", { class: `ev st-${e.status}` },
    h("time", {}, fmtTime(e.timestamp)),
    h("div", {},
      h("div", { class: "ev-head" }, `${e.stage} · ${e.agent}`, tags),
      h("div", { class: "ev-sum" }, e.summary)));
}

function makeFeed() {
  const list = h("div", { class: "feed", role: "log", "aria-live": "polite" }, h("div", { class: "feed-empty" }, "Trace events appear here as the agents work. Every line is a real event from the run."));
  let empty = true;
  return {
    el: list,
    push(e) {
      if (e.stage === "MODEL_CALL" && e.agent === "NightshiftAdapter" && e.external?.endpoint === "GET /v1/models") return;
      if (empty) { list.replaceChildren(); empty = false; }
      list.append(feedItem(e));
      list.scrollTop = list.scrollHeight;
    },
    clear() { list.replaceChildren(h("div", { class: "feed-empty" }, "Waiting for the first event…")); empty = true; },
  };
}

// ------------------------------------------------------------------- command
export async function commandView(ctx) {
  const { meta } = ctx;
  const [scenarios, health] = await Promise.all([api.scenarios(), api.health().catch(() => null)]);
  let selected = { scenario_id: scenarios[0]?.scenario_id };

  const pipeline = createPipeline(meta.mode);
  const feed = makeFeed();
  const result = h("div", { class: "result" });
  const runState = h("div", { class: "run-state" }, h("span", { class: "muted" }, "Select a shortage alert, then run the analysis."));
  const runBtn = h("button", { class: "btn btn-primary btn-block", type: "button" }, "Run analysis", h("span", { "aria-hidden": "true" }, "→"));

  const alertEls = scenarios.map((sc, i) => {
    const el = h("button", { class: `alert reveal ${i === 0 ? "selected" : ""}`, type: "button", style: { "--i": i }, onclick: () => select(el, { scenario_id: sc.scenario_id }) },
      h("div", { class: "alert-top" }, h("span", { class: "chip" }, `S${i + 1} · NDC ${sc.input.trigger.package_ndc}`), h("span", { class: "alert-date", title: "analysis date" }, sc.input.as_of)),
      h("p", { class: "alert-title" }, titleOf(sc.scenario_id)),
      h("p", { class: "alert-desc" }, sc.description));
    trackPointer(el);
    return el;
  });
  const ndc = h("input", { class: "input", placeholder: "Package NDC, e.g. 0409-6102-26", "aria-label": "Custom package NDC" });
  const ndcBtn = h("button", { class: "btn btn-ghost", type: "button", onclick: () => {
    if (!/^\d{4,5}-\d{3,4}-\d{1,2}$/.test(ndc.value.trim())) return toast("Use the hyphenated package NDC, e.g. 0409-6102-26.", "err");
    select(null, { package_ndc: ndc.value.trim(), as_of: scenarios[0]?.input.as_of });
    toast(`Custom alert set: NDC ${ndc.value.trim()}`, "ok");
  } }, "Use");

  function select(el, sel) {
    selected = sel;
    alertEls.forEach((a) => a.classList.toggle("selected", a === el));
  }

  let es = null;
  let t0 = 0;
  let clock = null;
  async function follow(runId) {
    runBtn.disabled = true;
    result.replaceChildren();
    feed.clear();
    pipeline.reset();
    t0 = performance.now();
    const tickState = () => {
      runState.replaceChildren(h("span", { class: "spinner" }), h("span", {}, `Running · ${meta.mode === "live" ? "live services" : "sample mode"} · ${fmtDuration(performance.now() - t0)}`), h("span", { class: "chip" }, runId));
    };
    tickState();
    clock = setInterval(tickState, 1000);
    es = api.events(runId);
    es.addEventListener("trace", (m) => {
      const e = JSON.parse(m.data);
      feed.push(e);
      pipeline.onEvent(e);
    });
    es.addEventListener("complete", async (m) => {
      const info = JSON.parse(m.data);
      es.close();
      clearInterval(clock);
      runBtn.disabled = false;
      const dur = fmtDuration(performance.now() - t0);
      try {
        const run = await api.run(runId);
        runState.replaceChildren(
          h("span", { class: `chip ${run.status === "success" ? "ok" : "unavail"}` }, run.status === "success" ? "Run complete" : "Run failed"),
          h("span", {}, `${run.decisions.length} decision package(s) · ${dur}`),
          h("a", { class: "chip info", href: `#/run/${runId}` }, "Open run →"));
        if (run.error) {
          result.replaceChildren(h("div", { class: "glass panel reveal" }, h("div", { class: "eyebrow" }, "Run error"), h("p", {}, `${run.error.type}: ${run.error.message}`)));
          return;
        }
        if (run.decisions.length === 0) result.replaceChildren(h("div", { class: "glass panel reveal" }, h("p", {}, "No formulary item matches this NDC exactly. Nothing to decide.")));
        else result.replaceChildren(...run.decisions.map((d) => renderDecision(run, d, run.reviews?.[d.decision_id] ?? null)));
        result.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (err) {
        runState.replaceChildren(h("span", { class: "chip unavail" }, "Run failed"), h("span", {}, info.error ?? err.message));
      }
    });
    es.onerror = () => { /* the browser reconnects; the server replays events */ };
  }

  runBtn.addEventListener("click", async () => {
    try {
      const { run_id } = await api.start(selected);
      follow(run_id);
    } catch (err) {
      toast(err.message, "err");
    }
  });
  if (meta.active_run) follow(meta.active_run);

  const metaBox = h("div", { class: "hero-meta" },
    h("div", {}, h("b", {}, meta.mode === "live" ? "Live" : "Sample"), h("span", {}, meta.mode === "live" ? "Zetaris + Nightshift" : "no sponsor calls")),
    h("div", {}, h("b", { id: "m-prec" }, String(health?.hmem?.precedents ?? "—")), h("span", {}, "precedents in H-MEM")),
    h("div", {}, h("b", {}, `≤ ${meta.max_revisions}`), h("span", {}, "revisions, then escalate")));
  if (typeof health?.hmem?.precedents === "number") setTimeout(() => countUp(metaBox.querySelector("#m-prec"), health.hmem.precedents), 300);

  ctx.onLeave = () => { es?.close(); clearInterval(clock); pipeline.destroy(); };

  return [
    h("section", { class: "hero" },
      h("div", {},
        h("div", { class: "eyebrow" }, `Command · ${new Date().toLocaleDateString([], { day: "2-digit", month: "long", year: "numeric" })}`),
        h("h1", {}, "Shortages, ", h("em", {}, "answered"), " with evidence.")),
      h("div", {},
        h("p", {}, "Pick an incoming shortage alert. ShortStop matches it to your formulary, measures days of stock, recalls precedents, and proposes only what your policy permits. A pharmacist always makes the call."),
        h("div", { style: { height: "18px" } }), metaBox)),
    h("section", { class: "command-grid" },
      h("div", { class: "glass panel corner" },
        h("div", { class: "panel-head" }, h("h2", {}, "Incoming shortage alerts"), h("span", { class: "chip" }, `${scenarios.length}`)),
        h("div", { class: "alert-list" }, alertEls),
        h("div", { class: "custom" }, ndc, ndcBtn),
        runBtn),
      h("div", { class: "command-main" },
        h("div", { class: "glass corner" },
          h("div", { class: "pipeline-wrap" },
            h("div", { class: "panel-head", style: { padding: "4px 6px 0" } }, h("h2", {}, "Agent pipeline"), h("span", { class: "chip info" }, "driven by the run trace")),
            pipeline.el),
          h("div", { class: "run-bar" }, runState)),
        h("div", { class: "glass panel feed-col" },
          h("div", { class: "panel-head" }, h("h2", {}, "Trace"), h("span", { class: "chip" }, "JSONL · redacted")),
          feed.el))),
    result,
  ];
}

// ----------------------------------------------------------------- decisions
export async function decisionsView() {
  const runs = await api.runs();
  let filter = "all";
  const list = h("div", { class: "runs" });
  const draw = () => {
    const rows = runs.filter((r) => filter === "all" || r.mode === filter);
    list.replaceChildren(...(rows.length ? rows.map((r, i) =>
      h("a", { class: "run-row reveal", href: `#/run/${r.run_id}`, style: { "--i": Math.min(i, 12) } },
        h("div", {}, modeChip(r.mode)),
        h("div", {}, h("b", {}, r.scenario_id ? titleOf(r.scenario_id) : "Custom alert"), h("div", { class: "run-id" }, `${fmtDate(r.started_at)} · ${r.run_id}`)),
        h("div", { class: "dec-mini" }, r.status === "running" ? h("span", { class: "chip warn" }, "running…") :
          r.error ? h("span", { class: "chip unavail" }, `error: ${r.error.type}`) :
          r.decisions.length ? r.decisions.map((d) => h("div", {}, statusChip(d.status), " ", h("span", { class: "muted" }, d.item_id), d.review ? h("span", { class: "muted" }, ` · ${d.review.outcome} by ${d.review.reviewer}`) : h("span", { class: "muted" }, " · awaiting review"))) :
          h("span", { class: "muted" }, "no affected item")),
        h("div", { class: "muted mono", style: { fontSize: "12px" } }, r.execution_time_seconds ? fmtDuration(r.execution_time_seconds * 1000) : ""),
        h("span", { class: "arrow" }, "→"))) : [h("p", { class: "muted" }, "No runs yet. Start one from Command.")]));
  };
  const filters = h("div", { class: "filters" }, ["all", "live", "sample"].map((f) =>
    h("button", { type: "button", class: f === filter ? "on" : "", onclick: (e) => { filter = f; e.currentTarget.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.currentTarget)); draw(); } }, f[0].toUpperCase() + f.slice(1))));
  draw();
  const pending = runs.flatMap((r) => r.decisions ?? []).filter((d) => !d.review).length;
  return [
    h("section", { class: "hero" },
      h("div", {}, h("div", { class: "eyebrow" }, "Decisions"), h("h1", {}, "Every run, ", h("em", {}, "on the record."))),
      h("div", {}, h("p", {}, "Runs are stored with their full trace. Live runs used Zetaris and Nightshift; sample runs used bundled data and rule-based agents, and are labelled so."),
        h("div", { style: { height: "18px" } }),
        h("div", { class: "hero-meta" },
          h("div", {}, h("b", {}, String(runs.length)), h("span", {}, "runs")),
          h("div", {}, h("b", {}, String(runs.filter((r) => r.mode === "live").length)), h("span", {}, "live runs")),
          h("div", {}, h("b", {}, String(pending)), h("span", {}, "awaiting review"))))),
    h("div", { class: "glass panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Run history"), filters), list),
  ];
}

// ------------------------------------------------------------------ run view
export async function runView(ctx, runId) {
  const run = await api.run(runId);
  if (run.status === "running") { location.hash = "#/command"; return []; }
  const pipeline = createPipeline(run.mode);
  const feed = makeFeed();
  // Replay the recorded trace through the diagram, quickly but visibly.
  const es = api.events(runId);
  const queue = [];
  let timer = null;
  const drain = () => {
    const e = queue.shift();
    if (!e) { timer = null; return; }
    feed.push(e);
    pipeline.onEvent(e);
    timer = setTimeout(drain, 140);
  };
  es.addEventListener("trace", (m) => { queue.push(JSON.parse(m.data)); if (!timer) drain(); });
  es.addEventListener("complete", () => es.close());
  ctx.onLeave = () => { es.close(); clearTimeout(timer); pipeline.destroy(); };

  return [
    h("section", { class: "hero" },
      h("div", {},
        h("a", { class: "eyebrow", href: "#/decisions" }, "← Decisions"),
        h("h1", {}, run.scenario_id ? titleOf(run.scenario_id) : "Custom alert", h("em", {}, ".")),
        h("div", { class: "dp-meta", style: { marginTop: "14px" } }, modeChip(run.mode), h("span", { class: "chip" }, run.run_id), h("span", { class: "chip info" }, `data: ${run.data_source}`))),
      h("div", {}, h("p", {}, run.notice),
        h("div", { style: { height: "18px" } }),
        h("div", { class: "hero-meta" },
          h("div", {}, h("b", {}, String(run.decisions.length)), h("span", {}, "decisions")),
          h("div", {}, h("b", {}, fmtDuration(run.execution_time_seconds * 1000)), h("span", {}, "run time")),
          h("div", {}, h("b", {}, String(run.decisions.reduce((n, d) => n + d.model_calls.length, 0))), h("span", {}, "model calls"))))),
    h("section", { class: "command-grid", style: { gridTemplateColumns: "1fr 380px" } },
      h("div", { class: "glass corner" }, h("div", { class: "pipeline-wrap" }, h("div", { class: "panel-head", style: { padding: "4px 6px 0" } }, h("h2", {}, "Replay of the recorded trace"), h("span", { class: "chip" }, "recorded, not re-run")), pipeline.el)),
      h("div", { class: "glass panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Trace")), feed.el)),
    h("div", { class: "result" },
      run.error ? h("div", { class: "glass panel" }, h("p", {}, `${run.error.type}: ${run.error.message}`)) : null,
      run.decisions.map((d) => renderDecision(run, d, run.reviews?.[d.decision_id] ?? null))),
  ];
}

// -------------------------------------------------------------------- memory
function precedentGraph(list) {
  const W = 860, rowH = 74;
  const order = [...list].sort((a, b) => (a.decided_at ?? "").localeCompare(b.decided_at ?? "") || a.memory_id.localeCompare(b.memory_id, undefined, { numeric: true }));
  const pos = new Map(order.map((p, i) => [p.memory_id, { x: 40 + (i % 2) * 380, y: 20 + i * rowH }]));
  const svg = s("svg", { class: "graph", viewBox: `0 0 ${W} ${Math.max(120, order.length * rowH + 30)}`, role: "img", "aria-label": "Precedent graph: supersession and conflicts" });
  for (const p of order) {
    if (p.supersedes && pos.has(p.supersedes)) {
      const a = pos.get(p.supersedes), b = pos.get(p.memory_id);
      svg.append(s("path", { class: "g-edge", d: `M${a.x + 170},${a.y + 46} C${a.x + 170},${a.y + 90} ${b.x + 170},${b.y - 30} ${b.x + 170},${b.y}` }));
    }
  }
  const live = order.filter((p) => !p.superseded_by);
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j];
    if (a.action === b.action && a.outcome !== b.outcome && a.policy_id === b.policy_id) {
      const pa = pos.get(a.memory_id), pb = pos.get(b.memory_id);
      svg.append(s("path", { class: "g-conflict", d: `M${pa.x + 340},${pa.y + 23} C${pa.x + 420},${pa.y + 23} ${pb.x + 420},${pb.y + 23} ${pb.x + 340},${pb.y + 23}` }));
    }
  }
  order.forEach((p, i) => {
    const { x, y } = pos.get(p.memory_id);
    // Position on the outer group; animate the inner one. A CSS transform on the
    // positioned element would override its SVG transform attribute.
    svg.append(s("g", { class: `g-node ${p.superseded_by ? "superseded" : ""} ${p.outcome === "rejected" ? "rejected" : ""}`, transform: `translate(${x},${y})` },
      s("g", { style: `animation:rise .6s cubic-bezier(.2,.8,.2,1) ${i * 90}ms both` },
        s("rect", { width: 340, height: 46, rx: 10 }),
        s("text", { x: 14, y: 20 }, `${p.memory_id} · ${p.outcome} ${p.action}`),
        s("text", { class: "sub", x: 14, y: 36 }, `${p.decided_at ?? ""} · conf ${p.confidence}${p.superseded_by ? ` · superseded by ${p.superseded_by}` : ""}`))));
  });
  return svg;
}

export async function memoryView() {
  const all = await api.precedents();
  // Items with the richest history first (supersessions, conflicts).
  const items = [...new Set(all.map((p) => p.item_id))].sort((a, b) => all.filter((p) => p.item_id === b).length - all.filter((p) => p.item_id === a).length || a.localeCompare(b));
  let current = items[0];
  const right = h("div", {});
  const draw = () => {
    const list = all.filter((p) => p.item_id === current);
    right.replaceChildren(
      h("div", { class: "glass panel corner reveal" },
        h("div", { class: "panel-head" }, h("h2", {}, `Precedent graph · ${current}`), h("span", { class: "dp-meta" }, h("span", { class: "chip mem" }, "— supersedes"), h("span", { class: "chip unavail" }, "··· conflict"))),
        precedentGraph(list)),
      h("div", { style: { height: "16px" } }),
      ...list.map((p, i) => h("div", { class: "glass panel reveal", style: { "--i": i, marginBottom: "12px" } },
        h("div", { class: "tl-meta" }, h("b", { style: { color: "var(--ink)" } }, p.memory_id), h("span", { class: `chip ${p.outcome === "approved" ? "ok" : "unavail"}` }, p.outcome), h("span", {}, p.action), p.policy_id ? h("span", { class: "chip warn" }, p.policy_id) : null,
          h("span", { class: "conf", title: `confidence ${p.confidence}` }, h("i", { style: { width: `${p.confidence * 100}%` } })), h("span", {}, p.confidence.toFixed(2)),
          p.synthetic ? h("span", { class: "chip mem" }, "synthetic") : h("span", { class: "chip ok" }, "recorded review")),
        h("p", { class: "tl-text", style: p.superseded_by ? { textDecoration: "line-through" } : {} }, p.content),
        h("div", { class: "muted", style: { fontSize: "12px" } }, `${p.provenance_label} · ${p.source_ref}`),
        h("div", { class: "ledger" }, p.history.map((e) => h("div", {}, h("span", {}, fmtDate(new Date(e.timestamp).toISOString())), h("span", { class: "act" }, e.action), h("span", {}, e.details ? JSON.stringify(e.details).slice(0, 120) : e.actor)))))),
    );
  };
  const tabs = h("div", { class: "item-tabs" }, items.map((it) => {
    const n = all.filter((p) => p.item_id === it);
    return h("button", { type: "button", class: `item-tab ${it === current ? "on" : ""}`, onclick: (e) => { current = it; tabs.querySelectorAll(".item-tab").forEach((t) => t.classList.toggle("on", t === e.currentTarget)); draw(); } },
      h("b", {}, it), h("span", {}, `${n.length} precedent(s) · ${n.filter((p) => p.superseded_by).length} superseded`));
  }));
  if (items.length) draw();
  return [
    h("section", { class: "hero" },
      h("div", {}, h("div", { class: "eyebrow" }, "Memory · Meterless H-MEM"), h("h1", {}, "Institutional memory, ", h("em", {}, "audited."))),
      h("div", {}, h("p", {}, "Each pharmacist decision becomes a precedent with provenance. Replaced precedents are kept and penalised, never deleted. Every change is in the append-only trust ledger."),
        h("div", { style: { height: "18px" } }),
        h("div", { class: "hero-meta" },
          h("div", {}, h("b", {}, String(all.length)), h("span", {}, "precedents")),
          h("div", {}, h("b", {}, String(all.filter((p) => p.superseded_by).length)), h("span", {}, "superseded")),
          h("div", {}, h("b", {}, String(all.reduce((n, p) => n + p.history.length, 0))), h("span", {}, "ledger entries"))))),
    items.length ? h("section", { class: "mem-grid" }, h("div", { class: "glass panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Formulary items")), tabs), right)
      : h("div", { class: "glass panel" }, h("p", { class: "muted" }, "No precedents yet. Run a scenario: sample and live modes seed the synthetic history.")),
  ];
}

// -------------------------------------------------------------------- system
function architecture(mode) {
  const live = mode === "live";
  const svg = s("svg", { class: "arch", viewBox: "0 0 1000 390", role: "img", "aria-label": "Architecture: data, agents, memory and model gateway" });
  const box = (cls, x, y, w, title, sub) => s("g", { class: `a-box ${cls}`, transform: `translate(${x},${y})`, style: cls !== "core" && !live && (cls === "z" || cls === "n") ? "opacity:.55" : "" },
    s("rect", { width: w, height: 70, rx: 14 }), s("text", { x: 18, y: 30 }, title), s("text", { class: "sub", x: 18, y: 50 }, sub));
  // In sample mode the Zetaris and Nightshift paths carry nothing, so they are dimmed.
  const flow = (d, color, dim) => [s("path", { class: "a-edge", d }), s("path", { class: "a-flow", d, stroke: color, style: dim ? "opacity:.15" : "" })];
  const label = (x, y, text) => s("text", { x, y, fill: "#747f79", style: "font:500 10px var(--f-mono);letter-spacing:.12em" }, text);
  svg.append(
    ...flow("M220,70 C300,70 290,150 370,150", "#4f7f9f", !live),
    ...flow("M220,230 C300,230 290,172 370,172", "#4f7f9f", !live),
    ...flow("M580,160 L640,160", "#b4883f", !live),
    ...flow("M725,195 L725,285", "#6b4a6e", false),
    ...flow("M810,142 C832,142 826,76 850,76", "#3f5c78", !live),
    ...flow("M810,180 C832,180 826,276 850,276", "#3f7a5c", false),
    box("z", 20, 35, 200, "openFDA API", "REST tables · 1,142 rows"),
    box("z", 20, 195, 200, "PostgreSQL", "SYNTHETIC hospital"),
    box("z", 370, 125, 210, "Zetaris", live ? "one SQL access point" : "not used in sample"),
    box("core", 640, 125, 170, "ShortStop core", "bounded agent loop"),
    box("m", 640, 285, 170, "Meterless H-MEM", "precedents · ledger"),
    box("n", 850, 41, 136, "Nightshift", live ? "auto routing" : "not used"),
    box("v", 850, 241, 136, "Pharmacist", "approve · reject"),
    label(640, 112, "PLAN ⇄ VALIDATE ⇄ CRITIQUE"),
    label(850, 28, live ? "→ NVIDIA NEMOTRON" : "SAMPLE: NOT CALLED"),
    label(20, 312, live ? "LIVE: ALL DATA VIA ZETARIS" : "SAMPLE: BUNDLED FILES INSTEAD"),
  );
  return svg;
}

export async function systemView(ctx) {
  const { meta } = ctx;
  const healthBox = h("div", { class: "health-grid" }, [0, 1, 2].map(() => h("div", { class: "glass health" }, h("div", { class: "skel", style: { width: "60%" } }), h("div", { class: "skel", style: { width: "40%", marginTop: "14px" } }))));
  const facts = h("div", { class: "facts" });
  const load = async () => {
    try {
      const hh = await api.health();
      const card = (name, x, detail) => {
        const cls = x?.status === "ok" ? "ok" : x?.status === "not_used" ? "idle" : "down";
        return h("div", { class: `glass health ${cls} reveal` }, h("div", { class: "eyebrow" }, name),
          h("div", { class: "h-state" }, h("i", {}), x?.status === "ok" ? "Online" : x?.status === "not_used" ? "Not used" : x?.status ?? "Unknown"),
          h("p", {}, detail(x)));
      };
      healthBox.replaceChildren(
        card("Zetaris", hh.zetaris, (x) => x.status === "ok" ? `SELECT 1 answered in ${x.latency_ms} ms.` : x.detail ?? ""),
        card("Meterless Nightshift", hh.nightshift, (x) => x.status === "ok" ? `${x.models} model ids listed · ${x.nemotron_models} Nemotron. Discovery in ${x.latency_ms} ms (no model call).` : x.detail ?? ""),
        card("H-MEM", hh.hmem, (x) => `${x.precedents} precedents · ${x.ledger_entries} ledger entries in the ${meta.mode} store.`));
      facts.replaceChildren(
        h("div", {}, h("b", { "data-n": hh.hmem.precedents }, "0"), h("span", {}, "precedents")),
        h("div", {}, h("b", { "data-n": hh.hmem.ledger_entries }, "0"), h("span", {}, "ledger entries")),
        h("div", {}, h("b", { "data-n": meta.max_revisions }, "0"), h("span", {}, "max revisions")),
        h("div", {}, h("b", { "data-n": meta.max_candidates }, "0"), h("span", {}, "max candidates")));
      facts.querySelectorAll("b[data-n]").forEach((b) => countUp(b, Number(b.dataset.n)));
    } catch (err) {
      toast(err.message, "err");
    }
  };
  load();

  // Cross-source query panel: one real SQL join through Zetaris (live only).
  const qOut = h("div", { class: "q-out" }, h("p", { class: "muted" }, meta.mode === "live" ? "Runs one SQL statement through Zetaris and shows exactly what came back." : "Live mode only: sample mode makes no Zetaris call."));
  const qBtn = h("button", { class: "btn btn-dark", type: "button", disabled: meta.mode !== "live" }, "Run cross-source query", h("span", { "aria-hidden": "true" }, "→"));
  qBtn.addEventListener("click", async () => {
    qBtn.disabled = true;
    const t0 = performance.now();
    qOut.replaceChildren(h("div", { class: "run-state" }, h("span", { class: "spinner" }), "Querying Zetaris…"));
    try {
      const r = await api.zetarisJoin();
      qOut.replaceChildren(
        h("pre", { class: "q-sql" }, r.sql),
        h("div", { class: "dp-meta", style: { margin: "14px 0" } },
          h("span", { class: "chip ok" }, `HTTP ${r.http_status}`), h("span", { class: "chip" }, `${r.row_count} rows`),
          h("span", { class: "chip" }, `${fmtDuration(r.duration_ms)} in Zetaris`), h("span", { class: "chip info" }, `${r.attempts} attempt(s)`),
          ...r.sources.map((src) => h("span", { class: "chip mem" }, src))),
        h("table", { class: "q-table" },
          h("thead", {}, h("tr", {}, ["item_id", "ndc", "openFDA availability", "openFDA updated", "manufacturer", "on hand (synthetic)"].map((c) => h("th", {}, c)))),
          h("tbody", {}, r.rows.map((row, i) => h("tr", { class: "reveal", style: { "--i": i } },
            h("td", {}, row.item_id), h("td", {}, row.ndc),
            h("td", {}, h("span", { class: `chip ${/^unavail/i.test(row.availability) ? "unavail" : /^limited/i.test(row.availability) ? "warn" : "ok"}` }, row.availability)),
            h("td", {}, row.update_date), h("td", {}, row.company_name), h("td", {}, String(Number(row.on_hand))))))));
    } catch (err) {
      qOut.replaceChildren(h("p", { class: "muted" }, `Query failed after ${fmtDuration(performance.now() - t0)}: ${err.message}`));
    } finally {
      qBtn.disabled = meta.mode !== "live";
    }
  });
  const queryPanel = h("div", { class: "glass panel", style: { marginTop: "18px" } },
    h("div", { class: "panel-head" }, h("h2", {}, "Cross-source query · Zetaris"), qBtn),
    h("p", { class: "muted", style: { margin: "0 0 14px", fontSize: "13.5px" } }, "Public openFDA shortage records (Zetaris REST tables) joined to the synthetic hospital formulary and inventory (PostgreSQL datasource), in one SQL statement."),
    qOut);

  return [
    h("section", { class: "hero" },
      h("div", {}, h("div", { class: "eyebrow" }, "System"), h("h1", {}, "How the pieces ", h("em", {}, "connect."))),
      h("div", {}, h("p", {}, meta.notice), h("div", { style: { height: "18px" } }),
        h("button", { class: "btn btn-ghost", type: "button", onclick: load }, "Re-check services"))),
    h("div", { class: "glass arch-wrap corner" }, architecture(meta.mode)),
    healthBox,
    queryPanel,
    facts,
  ];
}
