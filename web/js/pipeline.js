// Animated agent pipeline (SVG). Driven by real trace events from a run; it
// never animates a step the trace has not reported.
import { s, fmtDuration } from "./dom.js";

const W = 160, H = 66;
const ROW1 = 46, ROW2 = 214;
const X = [16, 199, 382, 565, 748];

function nodeDefs(mode) {
  const live = mode === "live";
  return {
    zetaris: { x: X[0], y: ROW1, title: live ? "Zetaris" : "Sample data", sub: live ? "openFDA + PG · SQL" : "bundled snapshot", cls: "svc-zetaris" },
    match: { x: X[1], y: ROW1, title: "Match", sub: "exact package NDC" },
    exposure: { x: X[2], y: ROW1, title: "Exposure", sub: "days on hand" },
    hmem: { x: X[3], y: ROW1, title: "H-MEM", sub: "precedent recall", cls: "svc-hmem" },
    evidence: { x: X[4], y: ROW1, title: "Evidence", sub: "stable IDs" },
    planner: { x: X[4], y: ROW2, title: "Planner", sub: live ? "LLM via Nightshift" : "rule-based (sample)", cls: "model" },
    validator: { x: 534, y: ROW2, title: "Validator", sub: "deterministic policy" },
    critic: { x: 302, y: ROW2, title: "Critics", sub: live ? "rules + Nightshift" : "precedent rules", cls: "model" },
    decision: { x: 16, y: ROW2, title: "Decision", sub: "pharmacist review", cls: "decision" },
  };
}

const mid = (n, side) =>
  side === "r" ? [n.x + W, n.y + H / 2] : side === "l" ? [n.x, n.y + H / 2] : side === "b" ? [n.x + W / 2, n.y + H] : [n.x + W / 2, n.y];

function edgePaths(n) {
  const line = (a, b) => `M${a[0]},${a[1]} L${b[0]},${b[1]}`;
  const e1 = mid(n.evidence, "b"), p1 = mid(n.planner, "t");
  const cb = mid(n.critic, "b"), pb = mid(n.planner, "b");
  const ex = mid(n.exposure, "b"), dt = mid(n.decision, "t");
  return {
    "zetaris-match": line(mid(n.zetaris, "r"), mid(n.match, "l")),
    "match-exposure": line(mid(n.match, "r"), mid(n.exposure, "l")),
    "exposure-hmem": line(mid(n.exposure, "r"), mid(n.hmem, "l")),
    "hmem-evidence": line(mid(n.hmem, "r"), mid(n.evidence, "l")),
    "evidence-planner": line(e1, p1),
    "planner-validator": line(mid(n.planner, "l"), mid(n.validator, "r")),
    "validator-critic": line(mid(n.validator, "l"), mid(n.critic, "r")),
    "critic-decision": line(mid(n.critic, "l"), mid(n.decision, "r")),
    "revise": `M${cb[0]},${cb[1]} C${cb[0]},${cb[1] + 70} ${pb[0]},${pb[1] + 70} ${pb[0]},${pb[1]}`,
    "monitor": `M${ex[0]},${ex[1]} C${ex[0]},${ex[1] + 60} ${dt[0] + 40},${dt[1] - 70} ${dt[0]},${dt[1]}`,
  };
}

export function createPipeline(mode) {
  const nodes = nodeDefs(mode);
  const paths = edgePaths(nodes);
  const svg = s("svg", { class: "pipeline", viewBox: "0 0 920 360", role: "img", "aria-label": "Agent pipeline, updated live from the run trace" });

  svg.append(
    s("text", { class: "lane-label", x: 20, y: 28 }, "01 · Data and memory"),
    s("text", { class: "lane-label", x: 20, y: 196 }, "02 · Agents, bounded loop"),
  );

  const edgeEls = {};
  for (const [id, d] of Object.entries(paths)) {
    const loop = id === "revise" || id === "monitor";
    svg.append(s("path", { class: `edge${loop ? " loop" : ""}`, d, id: `edge-${id}` }));
    const flow = s("path", { class: `edge-flow${id === "revise" ? " loop-flow" : ""}`, d });
    svg.append(flow);
    edgeEls[id] = flow;
  }
  svg.append(
    s("text", { class: "lane-label", x: (nodes.critic.x + nodes.planner.x + W) / 2 - 40, y: ROW2 + H + 66 }, "revise ≤ 2"),
    s("text", { class: "lane-label", x: nodes.match.x + 30, y: ROW1 + H + 62 }, "adequate stock → monitor"),
  );

  const nodeEls = {};
  const timers = {};
  for (const [id, n] of Object.entries(nodes)) {
    const g = s("g", { class: `node ${n.cls ?? ""}`, transform: `translate(${n.x},${n.y})` },
      s("rect", { class: "ring", x: 0, y: 0, width: W, height: H, rx: 13 }),
      s("rect", { x: 0, y: 0, width: W, height: H, rx: 13 }),
      s("text", { x: 16, y: 27 }, n.title),
      s("text", { class: "sub", x: 16, y: 46 }, n.sub),
    );
    const timer = s("text", { class: "timer", x: W - 12, y: 27, "text-anchor": "end" }, "");
    g.append(timer);
    timers[id] = timer;
    svg.append(g);
    nodeEls[id] = g;
  }

  const particles = s("g", {});
  svg.append(particles);

  let tick = null;
  const startedAt = {};

  function setNode(id, state) {
    const g = nodeEls[id];
    if (!g) return;
    for (const c of ["active", "done", "fail", "warn", "skipped"]) g.classList.remove(c);
    if (state) g.classList.add(state);
    if (state === "active") {
      startedAt[id] = performance.now();
      if (!tick) tick = setInterval(updateTimers, 500);
    } else if (startedAt[id]) {
      const ms = performance.now() - startedAt[id];
      delete startedAt[id];
      timers[id].textContent = ms > 1500 ? fmtDuration(ms) : "";
    }
  }

  function updateTimers() {
    const ids = Object.keys(startedAt);
    if (ids.length === 0) {
      clearInterval(tick);
      tick = null;
      return;
    }
    for (const id of ids) timers[id].textContent = fmtDuration(performance.now() - startedAt[id]);
  }

  function setEdge(id, state) {
    const e = edgeEls[id];
    if (!e) return;
    e.classList.remove("on", "done");
    if (state) e.classList.add(state);
    particles.querySelectorAll(`[data-edge="${id}"]`).forEach((p) => p.remove());
    if (state === "on") {
      const dot = s("circle", { class: "pulse-dot", r: 3.5, "data-edge": id },
        s("animateMotion", { dur: id === "revise" || id === "monitor" ? "1.8s" : "1.1s", repeatCount: "indefinite", path: paths[id] }));
      particles.append(dot);
    }
  }

  function setDecision(status) {
    const g = nodeEls.decision;
    g.classList.remove("st-pending", "st-escalated", "st-monitor");
    const cls = status === "PENDING_APPROVAL" ? "st-pending" : status === "ESCALATED" ? "st-escalated" : "st-monitor";
    g.classList.add(cls, "done");
    g.querySelector(".sub").textContent = status === "PENDING_APPROVAL" ? "pending approval" : status === "ESCALATED" ? "escalated" : "monitor";
  }

  function reset() {
    for (const id of Object.keys(nodeEls)) setNode(id, null);
    for (const id of Object.keys(edgeEls)) setEdge(id, null);
    for (const t of Object.values(timers)) t.textContent = "";
    nodeEls.decision.classList.remove("st-pending", "st-escalated", "st-monitor");
    nodeEls.decision.querySelector(".sub").textContent = nodes.decision.sub;
  }

  // Interprets one trace event. Model calls only report when they return, so
  // the planner/critic are shown "active" from the step before them.
  let lastAgentStage = null;
  function onEvent(e) {
    const st = e.stage;
    switch (st) {
      case "START":
        reset();
        setNode("zetaris", "active");
        break;
      case "RETRIEVE_DATA":
        if (e.agent === "DataAgent") {
          setNode("zetaris", e.status === "failure" ? "fail" : "done");
          if (e.status !== "failure") { setNode("match", "active"); setEdge("zetaris-match", "on"); }
        }
        break;
      case "IDENTIFY_AFFECTED":
        setNode("match", "done"); setEdge("zetaris-match", "done");
        setNode("exposure", "active"); setEdge("match-exposure", "on");
        break;
      case "CALCULATE_EXPOSURE":
        setNode("exposure", e.status === "rejected" ? "warn" : "done"); setEdge("match-exposure", "done");
        setNode("hmem", "active"); setEdge("exposure-hmem", "on");
        break;
      case "RECALL_PRECEDENTS":
        setNode("hmem", "done"); setEdge("exposure-hmem", "done");
        setNode("evidence", "active"); setEdge("hmem-evidence", "on");
        break;
      case "BUILD_EVIDENCE":
        setNode("evidence", "done"); setEdge("hmem-evidence", "done");
        setNode("planner", "active"); setEdge("evidence-planner", "on");
        lastAgentStage = "BUILD_EVIDENCE";
        break;
      case "PLAN":
        setNode("planner", e.status === "failure" ? "fail" : "done"); setEdge("evidence-planner", "done"); setEdge("revise", null);
        if (e.status !== "failure") { setNode("validator", "active"); setEdge("planner-validator", "on"); }
        lastAgentStage = "PLAN";
        break;
      case "VALIDATE":
        setNode("validator", e.status === "rejected" ? "warn" : "done"); setEdge("planner-validator", "done");
        if (!/^0 valid/.test(e.summary ?? "")) { setNode("critic", "active"); setEdge("validator-critic", "on"); }
        lastAgentStage = "VALIDATE";
        break;
      case "CRITIQUE":
        setEdge("validator-critic", "done");
        setNode("critic", e.status === "success" ? "done" : e.status === "escalated" || e.status === "failure" ? "fail" : "warn");
        lastAgentStage = "CRITIQUE";
        break;
      case "REVISE":
        setEdge("revise", "on");
        setNode("planner", "active");
        if (lastAgentStage === "VALIDATE") setNode("validator", "warn");
        break;
      case "PACKAGE":
      case "ESCALATE": {
        const status = e.action === "monitor_only" ? "MONITOR_PENDING_ACKNOWLEDGEMENT" : st === "ESCALATE" ? "ESCALATED" : "PENDING_APPROVAL";
        if (e.action === "monitor_only") {
          for (const id of ["hmem", "evidence"]) setNode(id, "done");
          for (const id of ["planner", "validator", "critic"]) setNode(id, "skipped");
          setEdge("hmem-evidence", "done"); setEdge("monitor", "on");
          setTimeout(() => setEdge("monitor", "done"), 2400);
        } else {
          setEdge("revise", null);
          setEdge("critic-decision", "on");
          setTimeout(() => setEdge("critic-decision", "done"), 1800);
        }
        setDecision(status);
        break;
      }
      case "COMPLETE":
        for (const id of Object.keys(startedAt)) setNode(id, e.status === "failure" ? "fail" : "done");
        if (e.status === "failure") {
          for (const [id, g] of Object.entries(nodeEls)) if (g.classList.contains("active")) setNode(id, "fail");
        }
        break;
    }
  }

  return { el: svg, onEvent, reset, setNode, destroy: () => tick && clearInterval(tick) };
}
