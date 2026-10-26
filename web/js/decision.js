// Renders one decision package and its pharmacist review controls.
import { api } from "./api.js";
import { h, s, countUp, toast, openDrawer, STATUS, fmtDuration, fmtDate, modeChip } from "./dom.js";

const ACTION_LABEL = {
  SWITCH_PRESENTATION: "Switch presentation",
  APPROVED_INTERCHANGE: "Approved interchange",
  RESTRICT_PER_POLICY: "Restrict per policy",
  ALTERNATE_SOURCING: "Alternate sourcing",
  ESCALATE: "Escalate to pharmacist",
};

function availabilityChip(sh) {
  const kind = sh.availability === "UNAVAILABLE" ? "unavail" : sh.availability === "LIMITED" ? "warn" : sh.availability === "AVAILABLE" ? "ok" : "info";
  return h("span", { class: `chip ${kind}` }, sh.availability_raw || sh.availability);
}

function evidenceDrawer(ev) {
  return h("div", {},
    h("div", { class: "eyebrow" }, ev.kind),
    h("h3", {}, ev.evidence_id),
    h("p", { class: "muted" }, ev.summary),
    h("div", { class: "dp-meta", style: { margin: "12px 0" } },
      h("span", { class: `chip ${ev.synthetic ? "mem" : "ok"}` }, ev.synthetic ? "Synthetic" : "Public record"),
      h("span", { class: "chip info" }, `via ${ev.provenance?.retrieved_via ?? "?"}`),
      ev.provenance?.dataset ? h("span", { class: "chip" }, ev.provenance.dataset) : null,
    ),
    h("pre", {}, JSON.stringify(ev.data, null, 2)),
  );
}

function evChips(ids, byId) {
  return h("div", { class: "ev-chips" }, ids.map((id) =>
    h("button", { class: "ev-chip", type: "button", title: byId.get(id)?.summary ?? "", onclick: () => byId.get(id) && openDrawer(evidenceDrawer(byId.get(id))) }, id)));
}

const RING_COLORS = ["#b4883f", "#3f5c78", "#3f7a5c", "#6b4a6e", "#b5502f", "#4f7f9f"];

// Two rings: share of on-hand stock and share of daily use, per location.
// A location that holds little stock but uses a lot shows up immediately.
function ring(values, label, total, unit) {
  const r = 46, c = 2 * Math.PI * r;
  const svgEl = s("svg", { viewBox: "0 0 120 120", width: 132, height: 132, class: "ring-chart", role: "img", "aria-label": label });
  svgEl.append(s("circle", { cx: 60, cy: 60, r, fill: "none", stroke: "rgba(20,32,28,.08)", "stroke-width": 12 }));
  let offset = 0;
  values.forEach((v, i) => {
    const frac = total > 0 ? v.value / total : 0;
    const seg = s("circle", {
      cx: 60, cy: 60, r, fill: "none", stroke: RING_COLORS[i % RING_COLORS.length], "stroke-width": 12,
      "stroke-dasharray": `0 ${c}`, "stroke-dashoffset": -offset * c, transform: "rotate(-90 60 60)", "stroke-linecap": "butt",
      style: "transition: stroke-dasharray 1.3s cubic-bezier(.2,.8,.2,1)",
    });
    svgEl.append(seg);
    requestAnimationFrame(() => requestAnimationFrame(() => seg.setAttribute("stroke-dasharray", `${Math.max(0, frac * c - 2)} ${c}`)));
    offset += frac;
  });
  svgEl.append(
    s("text", { x: 60, y: 58, "text-anchor": "middle", style: "fill:var(--ink);font:400 22px var(--f-display)" }, String(Math.round(total * 100) / 100)),
    s("text", { x: 60, y: 76, "text-anchor": "middle", style: "fill:var(--mute);font:500 8.5px var(--f-mono);letter-spacing:.1em" }, unit));
  return h("figure", { class: "ring-fig" }, svgEl, h("figcaption", {}, label));
}

function distribution(ex) {
  const locs = ex.locations;
  const stock = locs.map((l) => ({ loc: l.location_id, value: l.on_hand_units ?? 0 }));
  const use = locs.map((l) => ({ loc: l.location_id, value: l.avg_daily_usage ?? 0 }));
  const totalStock = stock.reduce((a, b) => a + b.value, 0);
  const totalUse = use.reduce((a, b) => a + b.value, 0);
  if (totalStock === 0 && totalUse === 0) return null;
  return h("div", { class: "distribution" },
    h("div", { class: "sec-title", style: { marginTop: "26px" } }, h("h3", {}, "Where stock sits vs where it is used")),
    h("div", { class: "rings" },
      ring(stock, "On hand", totalStock, "UNITS"),
      ring(use, "Daily use", totalUse, "PER DAY"),
      h("ul", { class: "ring-legend" }, locs.map((l, i) =>
        h("li", {}, h("i", { style: { background: RING_COLORS[i % RING_COLORS.length] } }), h("b", {}, l.location_id),
          h("span", {}, `${l.on_hand_units ?? "?"} on hand · ${l.avg_daily_usage ?? "no usage data"}${l.avg_daily_usage !== null ? "/day" : ""}`))))));
}

function exposureSection(d) {
  const ex = d.exposure;
  const max = Math.max(21, ...ex.locations.map((l) => l.days_on_hand ?? 0).filter((v) => v < 60));
  const big = h("b", {}, "0");
  const sec = h("section", {},
    h("div", { class: "sec-title" }, h("h3", {}, "Stock exposure"), h("span", { class: `chip ${ex.status === "CRITICAL" ? "unavail" : ex.status === "WARNING" ? "warn" : ex.status === "UNKNOWN" ? "mem" : "ok"}` }, ex.status)),
    h("div", { class: "doh" }, big, h("span", {}, ex.days_on_hand === null ? "days on hand: not computable" : `days on hand${ex.complete ? "" : " (partial)"}`)),
    h("div", { class: "calc" }, ex.calculation),
    h("div", { class: "bars" }, ex.locations.map((l) => {
      const v = l.days_on_hand;
      const cls = v === null ? "unknown" : v <= 7 ? "crit" : v <= 14 ? "warn" : "ok";
      const fill = h("div", { class: `bar-fill ${cls}` });
      const pct = v === null ? 1 : Math.min(1, v / max);
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.transform = `scaleX(${Math.max(0.02, pct)})`; }));
      return h("div", { class: "bar-row", title: l.notes.join("; ") },
        h("span", { class: "loc" }, l.location_id),
        h("div", { class: "bar-track" }, fill,
          h("i", { class: "bar-mark", style: { left: `${(7 / max) * 100}%` } }),
          h("i", { class: "bar-mark", style: { left: `${(14 / max) * 100}%` } })),
        h("span", { class: "val" }, v === null ? (l.status === "USAGE_MISSING" ? "no usage" : l.status.toLowerCase().replace("_", " ")) : `${v} d`));
    })),
    h("div", { class: "thresholds" }, h("span", {}, "| 7 d critical"), h("span", {}, "| 14 d warning"), h("span", {}, `window ${ex.window.start} → ${ex.window.end}`)),
    distribution(ex),
  );
  setTimeout(() => countUp(big, ex.days_on_hand, { decimals: ex.days_on_hand !== null && !Number.isInteger(ex.days_on_hand) ? 2 : 0 }), 150);
  return sec;
}

function candidatesSection(d, byId) {
  const checksFor = (c) => d.candidate_checks.find((x) => x.candidate.action === c.action && x.candidate.policy_id === c.policy_id)?.checks ?? [];
  return h("section", {},
    h("div", { class: "sec-title" }, h("h3", {}, "Validated candidates"), h("span", { class: "chip" }, `${d.candidates.length} passed · ${d.rejected_candidates.length} rejected`)),
    d.candidates.length === 0
      ? h("p", { class: "muted" }, d.status === "MONITOR_PENDING_ACKNOWLEDGEMENT" ? "No planning needed: stock is above every policy trigger." : "No candidate passed the deterministic validator.")
      : h("div", { class: "cands" }, d.candidates.map((c, i) =>
          h("div", { class: `cand reveal ${c.action === "ESCALATE" ? "esc" : ""}`, style: { "--i": i } },
            h("div", { class: "cand-head" },
              h("span", { class: "cand-action" }, ACTION_LABEL[c.action] ?? c.action),
              h("span", { class: "dp-meta" }, c.policy_id ? h("span", { class: "chip warn" }, c.policy_id) : null, c.target_item_id ? h("span", { class: "chip info" }, `→ ${c.target_item_id}`) : null)),
            h("p", {}, c.rationale),
            evChips(c.evidence_ids, byId),
            h("ul", { class: "checks" }, checksFor(c).map((t) => h("li", {}, t))),
          ))),
    d.rejected_candidates.length
      ? h("details", { style: { marginTop: "14px" } },
          h("summary", { class: "muted", style: { cursor: "pointer", fontSize: "12.5px" } }, `Validator rejected ${d.rejected_candidates.length} candidate(s) — show why`),
          h("ul", { class: "checks rejected-li" }, d.rejected_candidates.map((r) =>
            h("li", {}, `rev ${r.revision} · ${r.candidate?.action ?? "?"} ${r.candidate?.policy_id ?? ""}: ${r.issues.map((x) => x.code).join(", ")}`))))
      : null,
  );
}

function precedentsSection(d) {
  const all = [...d.precedents, ...d.superseded_precedents];
  return h("section", {},
    h("div", { class: "sec-title" }, h("h3", {}, "Precedents · H-MEM"), h("span", { class: "chip mem" }, `${d.precedents.length} recalled${d.superseded_precedents.length ? ` · ${d.superseded_precedents.length} superseded` : ""}`)),
    all.length === 0 ? h("p", { class: "muted" }, "No precedent recalled for this item.") :
      h("div", { class: "timeline" }, all.map((p, i) =>
        h("div", { class: `tl-item reveal ${p.superseded_by ? "superseded" : ""}`, style: { "--i": i } },
          h("div", { class: "tl-meta" },
            h("b", { style: { color: "var(--ink)" } }, p.memory_id),
            h("span", { class: `chip ${p.outcome === "approved" ? "ok" : "unavail"}` }, p.outcome),
            h("span", {}, p.action),
            p.decided_at ? h("span", {}, p.decided_at) : null,
            h("span", { class: "conf", title: `confidence ${p.confidence}` }, h("i", { style: { width: `${Math.round(p.confidence * 100)}%` } })),
            p.superseded_by ? h("span", { class: "chip mem" }, `superseded by ${p.superseded_by}`) : null),
          h("div", { class: "tl-text" }, p.content),
        ))),
    d.precedent_conflicts.length ? h("ul", { class: "reasons", style: { marginTop: "14px" } }, d.precedent_conflicts.map((c) => h("li", {}, `Conflict: ${c.reason}`))) : null,
  );
}

function receiptsSection(d) {
  if (!d.model_calls.length) return null;
  const maxMs = Math.max(...d.model_calls.map((m) => m.duration_ms));
  return h("section", {},
    h("div", { class: "sec-title" }, h("h3", {}, "Model calls · Nightshift receipts"), h("span", { class: "chip info" }, "automatic routing")),
    h("div", { class: "receipts" }, d.model_calls.map((m) => {
      const r = m.meterless ?? {};
      const route = r.winning_route ?? {};
      return h("div", { class: "receipt" },
        h("span", {}, h("b", {}, m.agent.replace("PrecedentCritic+", "")), h("span", { class: "muted" }, ` · rev ${m.revision}`)),
        h("span", { class: "r-model" }, m.reported ?? "model not reported"),
        h("div", { class: "lat" }, h("i", { style: { width: `${Math.max(4, (m.duration_ms / maxMs) * 100)}%` } })),
        h("span", { class: "r-meta" }, `requested ${m.requested} → routed ${r.routed_model ?? m.reported ?? "?"} · ${route.provider ?? "?"} ${route.kind ?? ""} · ${fmtDuration(m.duration_ms)} · ${r.usage?.input_tokens ?? "?"} in / ${r.usage?.output_tokens ?? "?"} out · ${r.receipt_id ?? "no receipt"}`),
      );
    })),
  );
}

function reviewSection(run, d, review, onDone) {
  if (review) {
    return h("div", { class: "reviewed" },
      h("span", { class: `seal ${review.outcome}` }, review.outcome === "approved" ? "✓" : review.outcome === "rejected" ? "✕" : "◉"),
      h("div", {},
        h("b", {}, `${review.outcome[0].toUpperCase()}${review.outcome.slice(1)} by ${review.reviewer}`),
        h("div", { class: "muted", style: { fontSize: "12.5px" } },
          `${fmtDate(review.reviewed_at)} · ${review.precedents_written?.length ?? 0} precedent(s) written to H-MEM · ${review.feedback?.length ?? 0} feedback update(s)${review.note ? ` · “${review.note}”` : ""}`)));
  }
  const reviewer = h("input", { class: "input", placeholder: "e.g. A. Pharmacist", value: localStorage.getItem("ss-reviewer") ?? "" });
  const note = h("textarea", { class: "input", placeholder: d.status === "PENDING_APPROVAL" ? "Reason (required to reject)" : "Note for the record" });
  const submit = async (outcome, btn) => {
    if (!reviewer.value.trim()) { reviewer.focus(); return toast("Enter the reviewer's name.", "err"); }
    btn.disabled = true;
    try {
      localStorage.setItem("ss-reviewer", reviewer.value.trim());
      const rec = await api.review(run.run_id, d.decision_id, { outcome, reviewer: reviewer.value.trim(), note: note.value.trim() });
      toast(`Recorded: ${outcome}. ${rec.precedents_written.length} precedent(s) written to H-MEM.`, "ok");
      onDone(rec);
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
    }
  };
  const actions = d.status === "PENDING_APPROVAL"
    ? [h("button", { class: "btn btn-jade", type: "button", onclick: (e) => submit("approved", e.currentTarget) }, "Approve"),
       h("button", { class: "btn btn-verm", type: "button", onclick: (e) => submit("rejected", e.currentTarget) }, "Reject")]
    : [h("button", { class: "btn btn-primary", type: "button", onclick: (e) => submit("acknowledged", e.currentTarget) }, "Acknowledge")];
  return h("div", { class: "review" },
    h("label", {}, "Reviewer", reviewer),
    h("label", {}, "Note", note),
    h("div", { class: "actions" }, actions));
}

function bodySections(run, d, byId) {
  const sections = [exposureSection(d), candidatesSection(d, byId), precedentsSection(d)];
  if (d.escalation_reasons.length) {
    sections.push(h("section", {},
      h("div", { class: "sec-title" }, h("h3", {}, "Why it was escalated")),
      h("ul", { class: "reasons" }, d.escalation_reasons.map((r) => h("li", {}, r)))));
  }
  sections.push(receiptsSection(d) ?? h("section", {},
    h("div", { class: "sec-title" }, h("h3", {}, "Model calls")),
    h("p", { class: "muted" }, run.mode === "sample" ? "Sample mode: rule-based agents, no model was called." : "No model call was needed: planning was skipped.")));
  if (sections.length % 2 === 1) sections[sections.length - 1].classList.add("wide");
  return h("div", { class: "dp-body" }, sections);
}

export function renderDecision(run, d, review) {
  const st = STATUS[d.status] ?? { cls: "", label: d.status, hint: "" };
  const byId = new Map(d.evidence.map((e) => [e.evidence_id, e]));
  const root = h("article", { class: "glass dp reveal" });
  const holder = h("div", {});
  const mount = (rv) => holder.replaceChildren(reviewSection(run, d, rv, (rec) => mount(rec)));
  mount(review);

  root.append(
    h("header", { class: "dp-head" },
      h("div", {},
        h("div", { class: "eyebrow" }, `Decision · ${d.item.item_id}`),
        h("h2", {}, d.item.description),
        h("div", { class: "dp-meta" },
          modeChip(run.mode),
          h("span", { class: "chip" }, `NDC ${d.item.ndc}`),
          availabilityChip(d.shortage),
          h("span", { class: "chip" }, `openFDA updated ${d.shortage.update_date ?? d.shortage.update_date_raw}`),
          d.shortage.has_openfda_block ? null : h("span", { class: "chip mem" }, "no openfda block"))),
      h("div", { class: `status-big ${st.cls}` },
        h("div", { class: "label" }, "Status"),
        h("div", { class: "value" }, h("i", {}), st.label),
        h("div", { class: "hint" }, `${st.hint} Revisions: ${d.revisions}.`))),
    bodySections(run, d, byId),
    holder,
    h("div", { class: "disclaimer" }, "⚑", h("span", {}, d.limitations.join(" "))),
  );
  return root;
}
