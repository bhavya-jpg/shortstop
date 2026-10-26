// Landing page. Every figure is either a dated, verified fact or comes from a
// real stored run through the API; nothing here is invented for show.
import { api } from "./api.js";
import { h, s, countUp, trackPointer, fmtDuration } from "./dom.js";

const REPO = "https://github.com/bhavya-jpg/shortstop";

function titleWords(lines) {
  let w = 0;
  return h("h1", { class: "l-title" }, lines.map((parts) =>
    h("span", { class: "line" }, parts.map((p) => {
      const words = p.text.split(" ").filter(Boolean);
      return words.map((word, i) => {
        const el = h(p.em ? "em" : "span", { class: "word", style: { "--w": w++ } }, word);
        return i < words.length - 1 || !p.last ? [el, " "] : el;
      });
    }))));
}

// Picks the newest stored run that produced a decision, preferring live runs.
async function latestDecision() {
  try {
    const runs = await api.runs();
    const usable = runs.filter((r) => r.status === "success" && r.decisions?.length);
    const pick = usable.find((r) => r.mode === "live") ?? usable[0];
    if (!pick) return null;
    const run = await api.run(pick.run_id);
    return { run, d: run.decisions[0] };
  } catch {
    return null;
  }
}

function heroCard(data) {
  if (!data) {
    return h("div", { class: "l-card" },
      h("div", { class: "l-card-bar" }, h("div", { class: "l-dots" }, h("i"), h("i"), h("i")), h("span", { class: "chip" }, "no runs yet")),
      h("div", { class: "l-card-body" }, h("p", { class: "muted" }, "Run a scenario in the console and the latest decision appears here.")));
  }
  const { run, d } = data;
  const ex = d.exposure;
  const max = Math.max(14, ...ex.locations.map((l) => l.days_on_hand ?? 0).filter((v) => v < 60));
  const planner = d.model_calls.find((m) => m.agent === "NightshiftPlanner");
  const critic = d.model_calls.find((m) => m.agent.includes("Critic"));
  const valid = d.candidates.filter((c) => c.action !== "ESCALATE").length;
  const statusCls = d.status === "ESCALATED" ? "esc" : d.status === "PENDING_APPROVAL" ? "" : "mon";
  const statusText = d.status === "ESCALATED" ? "Escalated" : d.status === "PENDING_APPROVAL" ? "Pending approval" : "Monitor";
  const bars = ex.locations.map((l) => {
    const v = l.days_on_hand;
    const color = v === null ? "var(--plum)" : v <= 7 ? "var(--clay)" : v <= 14 ? "var(--ochre)" : "var(--sage)";
    const fill = h("i", { style: { background: color } });
    setTimeout(() => { fill.style.transform = `scaleX(${v === null ? 1 : Math.max(0.04, Math.min(1, v / max))})`; }, 700);
    return h("div", {}, h("span", {}, l.location_id), h("span", { class: "t" }, fill), h("span", { style: { textAlign: "right" } }, v === null ? "—" : `${v}d`));
  });
  const doh = h("span", {}, "0");
  setTimeout(() => countUp(doh, ex.days_on_hand, { duration: 1500 }), 600);
  const steps = [
    { t: `${run.data_source === "zetaris" ? "Zetaris" : "Bundled sample data"}: shortage + hospital records` },
    { t: `Exposure: ${ex.status.toLowerCase()} across ${ex.locations.length} locations` },
    { t: `H-MEM: ${d.precedents.length} precedent(s) recalled` },
    planner ? { t: `Planner via Nightshift · ${planner.reported ?? "model not reported"}`, cls: "model" } : { t: run.mode === "sample" ? "Planner: rule-based (sample mode)" : "Planner skipped: stock adequate", cls: "model" },
    { t: `Validator: ${valid} candidate(s) admitted` },
    d.critic_verdicts.length ? { t: `Critic${critic ? " via Nightshift" : ""} · ${d.critic_verdicts[d.critic_verdicts.length - 1].verdict}`, cls: critic ? "model" : "" } : null,
    { t: "Waiting for a pharmacist", cls: "final" },
  ].filter(Boolean);

  return h("div", { style: { position: "relative" } },
    planner ? h("div", { class: "l-float f2" }, h("b", {}, "Routed by Nightshift"), planner.reported ?? "—") : null,
    h("div", { class: "l-float f1" }, h("b", {}, "Policy validator"), `${valid} of ${valid + d.rejected_candidates.length} candidates admitted`),
    h("div", { class: "l-card" },
      h("div", { class: "l-card-bar" },
        h("div", { class: "l-dots" }, h("i"), h("i"), h("i")),
        h("span", { class: "mono", style: { fontSize: "11px", color: "var(--mute)" } }, `latest run · ${run.run_id.slice(0, 22)}`),
        h("span", { class: `chip ${run.mode === "live" ? "live" : "sample"}` }, run.mode === "live" ? "● Live" : "Sample")),
      h("div", { class: "l-card-body" },
        h("span", { class: "eyebrow" }, `Decision · NDC ${d.item.ndc}`),
        h("div", { class: "l-card-title" }, d.item.description),
        h("div", { class: "l-card-cols" },
          h("div", {},
            h("div", { class: "l-doh" }, doh, h("small", {}, "days on hand")),
            h("div", { class: "l-mini-bars" }, bars)),
          h("ul", { class: "l-steps" }, steps.map((st, i) => h("li", { class: st.cls ?? "", style: { "--i": i } }, h("i", {}, "✓"), st.t)))),
        h("div", { class: "l-card-foot" },
          h("span", { class: `l-status ${statusCls}` }, statusText),
          h("span", {}, `${fmtDuration(run.execution_time_seconds * 1000)} · ${d.evidence.length} evidence IDs`)))));
}

// Items are strings; "*text*" renders in italics. Nodes are built per row so
// the duplicated row (for the seamless loop) never steals the first row's nodes.
function marquee(items, { dark = false, rev = false } = {}) {
  const row = () => items.map((t) => {
    const it = /^\*(.*)\*$/.exec(t);
    return h("span", { class: "mq-item" }, it ? h("em", {}, it[1]) : t, h("span", { class: "sep" }));
  });
  return h("div", { class: `l-marquee ${dark ? "dark" : ""}`, "aria-hidden": "true" },
    h("div", { class: `mq-track ${rev ? "rev" : ""}` }, row(), row()));
}

function flowDiagram() {
  const xs = [40, 270, 500, 730, 960];
  const d = `M${xs[0]},60 C140,60 170,20 ${xs[1]},20 S400,100 ${xs[2]},60 S630,20 ${xs[3]},20 S860,100 ${xs[4]},60`;
  const svg = s("svg", { viewBox: "0 0 1000 120", role: "img", "aria-label": "Five-step flow" },
    s("path", { class: "fl-path", d }),
    s("path", { class: "fl-draw", d }),
    s("circle", { class: "fl-dot", r: 4 }, s("animateMotion", { dur: "6s", repeatCount: "indefinite", path: d })));
  const ys = [60, 20, 60, 20, 60];
  xs.forEach((x, i) => svg.append(s("g", { class: "fl-node", transform: `translate(${x},${ys[i]})` },
    s("circle", { r: 16 }), s("text", { class: "num", "text-anchor": "middle", y: 4 }, `0${i + 1}`))));
  return h("div", { class: "l-flow inview" }, svg);
}

const FAQ = [
  ["Is ShortStop clinical decision support?", "No. It is a demonstration system. It never recommends doses, never makes patient-specific recommendations, and never orders, prescribes or messages anyone. Every proposed action waits for a pharmacist, who approves, rejects or acknowledges it."],
  ["Is the hospital data real?", "No. The formulary, stock, usage, policies and precedents are synthetic and labelled as such everywhere. The drug-shortage records are real public data from openFDA; the hospital's product NDCs are real FDA package codes used only as join keys."],
  ["How does it decide which actions are allowed?", "A deterministic validator, not a model. An action is admitted only if an active, in-date policy record permits it for that exact item, its days-on-hand trigger is met, every cited evidence ID exists, and any figure quoted matches the computed value. The model can propose; it cannot override the validator."],
  ["What happens when data is missing or precedents conflict?", "It escalates instead of guessing. Missing usage or inventory is treated as unknown, never as zero, so no policy trigger can fire on it. Conflicting precedents in H-MEM are flagged, and the decision goes to a human with the reasons listed."],
  ["Which AI model does it use?", "Every model call goes through Meterless Nightshift with the routing mode meterless/auto. In our live runs, Nightshift's compute receipts show every call was served by NVIDIA Nemotron 3.5 Bolt. ShortStop does not pin a specific model; the receipt for each call records which one answered."],
  ["What is H-MEM doing here?", "H-MEM is the Meterless memory engine. Each pharmacist decision becomes a precedent with provenance. Replaced precedents are kept but ranked down, never deleted. Approvals and rejections adjust confidence, and every change lands in an append-only ledger. The engine passes its 13/13 conformance suite."],
  ["Can I try it without Zetaris or Nightshift?", "Yes. Sample mode runs on a bundled snapshot of real openFDA records and synthetic hospital data with rule-based agents. Every screen and trace is labelled Sample, and nothing claims a sponsor call that did not happen. Live mode never falls back to sample data."],
];

export async function homeView() {
  const data = await latestDecision();

  const hero = h("section", { class: "l-hero" },
    h("div", { class: "l-hero-grid" }),
    h("div", { class: "home-inner" },
      h("div", { class: "l-hero-top" },
        h("span", { class: "l-badge" }, h("b", {}, "2026"), "Open Agent Hackathon · Reasoning Architecture"),
        h("span", { class: "l-coords" }, "Hospital pharmacy · Shortage response")),
      titleWords([[{ text: "When a drug runs short," }], [{ text: "answer with" }, { text: "evidence.", em: true, last: true }]]),
      h("div", { class: "l-hero-row" },
        h("div", { class: "l-hero-copy" },
          h("p", {}, "ShortStop reads public openFDA shortage records alongside your hospital's stock, usage and policy data, and hands a pharmacist a decision they can approve. Every action is backed by a policy; every claim is tied to a record."),
          h("div", { class: "l-ctas" },
            h("a", { class: "btn btn-dark", href: "#/command" }, "Open the console", h("span", { "aria-hidden": "true" }, "→")),
            h("button", { class: "btn btn-ghost", type: "button", onclick: () => document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }) }, "See how it works")),
          h("div", { class: "l-trust" },
            h("div", {}, h("b", { "data-n": "1142" }, "1,142"), "current openFDA shortage records"),
            h("div", {}, h("b", {}, "0"), "actions without a pharmacist"),
            h("div", {}, h("b", {}, "≤ 2"), "revisions, then escalate"))),
        heroCard(data))),
    marquee(["Exact package-NDC matching", "*Unknown is never zero*", "Every action cites a policy", "*Precedents that remember*", "Evidence you can open", "*A pharmacist always decides*"]),
  );

  const problem = h("section", { class: "home-section" },
    h("div", { class: "home-inner l-split" },
      h("div", { class: "inview" },
        h("div", { class: "eyebrow sec-eyebrow" }, "The problem"),
        h("h2", { class: "sec-h" }, "A shortage notice starts an ", h("em", {}, "afternoon of cross-checking.")),
        h("p", { class: "sec-lede" }, "Is it the exact product we stock? How many days do we have, and where is it? What does our policy let us do, and what did we decide last time? Pharmacy teams answer these by hand, across systems that don't talk to each other.")),
      h("div", { class: "l-stats" },
        [["1,142", "current drug-shortage records listed by openFDA", "openFDA via Zetaris · 25 Oct 2026"],
         ["68/100", "of the first 100 current records were injections", "openFDA · 25 Oct 2026"],
         ["2.55", "days of furosemide stock in the demo hospital", "synthetic hospital data"],
         ["3", "outcomes: approve, escalate or monitor", "a pharmacist decides each one"]].map(([n, t, src], i) =>
          h("div", { class: "l-stat inview", style: { "--i": i } }, h("b", {}, n), h("span", {}, t), h("small", {}, src))))));

  const how = h("section", { class: "home-section l-dark", id: "how" },
    h("div", { class: "l-dark-grid" }),
    h("div", { class: "home-inner", style: { position: "relative" } },
      h("div", { class: "inview" },
        h("div", { class: "eyebrow sec-eyebrow" }, "How it works"),
        h("h2", { class: "sec-h" }, "Five steps, ", h("em", {}, "one accountable answer.")),
        h("p", { class: "sec-lede" }, "A bounded loop of agents with a deterministic gate in the middle. The model proposes; the rules decide what is admissible; a person decides what happens.")),
      flowDiagram(),
      h("div", { class: "l-steps-grid" },
        [["Match", "Shortage records are matched to the formulary by exact package NDC across all FDA formats. Never by drug name."],
         ["Measure", "Days on hand per location, from real counts and usage. Missing data is unknown, never zero."],
         ["Remember", "H-MEM recalls precedents for the item, including what they replaced and any that conflict."],
         ["Propose & check", "A planner proposes via Nightshift. The validator rejects anything not backed by policy; critics can only make it stricter."],
         ["Decide", "A pharmacist approves, rejects or acknowledges. The decision becomes a precedent for next time."]].map(([t, p], i) =>
          h("div", { class: "l-step inview", style: { "--i": i } }, h("span", { class: "k" }, `Step 0${i + 1}`), h("h3", {}, t), h("p", {}, p))))),
  );

  const bento = h("section", { class: "home-section" },
    h("div", { class: "home-inner" },
      h("div", { class: "inview" },
        h("div", { class: "eyebrow sec-eyebrow" }, "Why you can trust the output"),
        h("h2", { class: "sec-h" }, "Built to be ", h("em", {}, "checked,"), " not believed.")),
      h("div", { class: "l-bento" },
        h("div", { class: "bento b-a inview" },
          h("div", {}, h("span", { class: "tag" }, "Evidence"), h("h3", { style: { marginTop: "14px" } }, "Every claim has an ID you can open"),
            h("p", {}, "Candidates cite stable evidence IDs for the policy, the exposure, the shortage record and the precedent. Cite an ID that does not exist and the candidate is rejected.")),
          h("div", { class: "b-visual ev-demo" }, ["EV-POLICY-POL-FUR-001", "EV-EXPOSURE-FUR-INJ-40", "EV-SHORTAGE-00409-6102-26", "EV-PRECEDENT-mem-2"].map((t, i) => h("span", { style: { "--i": i } }, t)), h("span", { class: "bad" }, "EV-MADE-UP"))),
        h("div", { class: "bento b-b forest inview", style: { "--i": 1 } },
          h("div", {}, h("span", { class: "tag" }, "Safety boundary"), h("h3", { style: { marginTop: "14px" } }, "A validator no model can override")),
          h("div", { class: "b-visual gate" }, h("span", { class: "in" }, "9 proposed"), h("span", { class: "bar" }), h("span", { class: "out" }, "0 admitted")),
          h("p", {}, "In our first live run, every model proposal broke the citation rules. All nine were rejected, and the case escalated.")),
        h("div", { class: "bento b-c inview", style: { "--i": 2 } },
          h("div", {}, h("span", { class: "tag" }, "Meterless H-MEM"), h("h3", { style: { marginTop: "14px" } }, "Memory with lineage")),
          h("div", { class: "b-visual mem-demo" }, h("div", { class: "old" }, h("span", {}, "mem-1 · switch"), h("span", {}, "2025-03")), h("div", {}, h("span", {}, "mem-2 · switch + double check"), h("span", {}, "2025-11"))),
          h("p", {}, "Replaced precedents are kept and ranked down, never deleted.")),
        h("div", { class: "bento b-d inview", style: { "--i": 3 } },
          h("div", {}, h("span", { class: "tag" }, "Honest modes"), h("h3", { style: { marginTop: "14px" } }, "Live or sample, always labelled")),
          h("div", { class: "b-visual", style: { display: "flex", gap: "8px" } }, h("span", { class: "chip live" }, "● Live"), h("span", { class: "chip sample" }, "Sample")),
          h("p", {}, "If Zetaris or Nightshift is down, a live run fails loudly. It never quietly swaps in sample data.")),
        h("div", { class: "bento b-e inview", style: { "--i": 4 } },
          h("div", {}, h("span", { class: "tag" }, "Traceability"), h("h3", { style: { marginTop: "14px" } }, "Every step on the record")),
          h("div", { class: "b-visual mono", style: { fontSize: "11.5px", color: "var(--ink-2)", lineHeight: 1.7 } },
            h("div", {}, "RETRIEVE_DATA · zetaris 200"), h("div", {}, "PLAN · nightshift 200"), h("div", {}, "VALIDATE · 3 valid"), h("div", {}, "PACKAGE · pending approval")),
          h("p", {}, "One JSONL trace per run, secrets redacted.")))));

  const integrations = h("section", { class: "home-section", style: { paddingTop: "40px" } },
    h("div", { class: "home-inner" },
      h("div", { class: "inview" },
        h("div", { class: "eyebrow sec-eyebrow" }, "Integrations"),
        h("h2", { class: "sec-h" }, "Real services, ", h("em", {}, "verified live.")),
        h("p", { class: "sec-lede" }, "Each integration below was exercised against the real service on 25 October 2026, and the evidence is in the repository.")),
      h("div", { class: "l-integr" },
        [["Data layer", "Zetaris", "The openFDA API is registered as Zetaris REST tables and the hospital tables as a PostgreSQL datasource. One SQL query joins public and private data.", "1,142 rows · cross-source join"],
         ["Memory engine", "Meterless H-MEM", "Precedent memory with provenance, supersession, feedback and an append-only trust ledger. Vendored unmodified.", "conformance 13/13"],
         ["Model gateway", "Meterless Nightshift", "The only model provider. Token auth, routing modes discovered at runtime, and a compute receipt stored for every call.", "invalid token → 401"],
         ["Model", "NVIDIA Nemotron", "Nightshift routed every live planner and critic call to Nemotron 3.5 Bolt automatically. ShortStop does not pin the model.", "nvidia/nemotron-3.5-bolt-e4b"]].map(([role, name, p, proof], i) =>
          h("div", { class: "integ inview", style: { "--i": i } }, h("span", { class: "role" }, role), h("h3", {}, name), h("p", {}, p), h("div", { class: "proof" }, `✓ ${proof}`))))));

  const faq = h("section", { class: "home-section", id: "faq", style: { paddingTop: "40px" } },
    h("div", { class: "home-inner l-faq" },
      h("div", { class: "inview" },
        h("div", { class: "eyebrow sec-eyebrow" }, "FAQ"),
        h("h2", { class: "sec-h" }, "Questions a pharmacist ", h("em", {}, "should ask.")),
        h("p", { class: "sec-lede" }, "Straight answers about what ShortStop does, what it does not do, and where its data comes from.")),
      h("div", { class: "faq-list" }, FAQ.map(([q, a], i) =>
        h("details", { class: "faq inview", style: { "--i": i }, ...(i === 0 ? { open: true } : {}) },
          h("summary", {}, h("span", {}, q), h("span", { class: "pm", "aria-hidden": "true" })),
          h("div", { class: "ans" }, h("div", {}, h("p", {}, a))))))));

  const cta = h("section", { class: "l-cta" },
    s("svg", { class: "l-cta-rings", viewBox: "0 0 900 900", "aria-hidden": "true" },
      s("circle", { cx: 450, cy: 450, r: 220 }), s("circle", { cx: 450, cy: 450, r: 320 }), s("circle", { cx: 450, cy: 450, r: 420 }),
      s("g", { class: "spin" }, s("circle", { cx: 450, cy: 450, r: 370 }))),
    h("div", { style: { position: "relative" }, class: "inview" },
      h("div", { class: "eyebrow sec-eyebrow" }, "Try it"),
      h("h2", {}, "Put the next shortage ", h("em", {}, "on the record.")),
      h("p", {}, "Run one of three real openFDA shortages against the demo hospital and watch the agents work, step by step."),
      h("div", { class: "l-ctas" },
        h("a", { class: "btn btn-dark", href: "#/command" }, "Open the console", h("span", { "aria-hidden": "true" }, "→")),
        h("a", { class: "btn btn-ghost", href: REPO, target: "_blank", rel: "noopener" }, "View the source"))));

  setTimeout(() => document.querySelectorAll(".bento").forEach(trackPointer), 0);
  return [hero, problem, how, marquee(["openFDA", "Zetaris", "PostgreSQL", "Meterless H-MEM", "Meterless Nightshift", "NVIDIA Nemotron · auto-routed", "Apache-2.0", "Synthetic hospital data", "Real shortage records"], { dark: true, rev: true }), bento, integrations, faq, cta];
}

export function renderFooter(el, compact) {
  el.classList.toggle("compact", compact);
  el.replaceChildren(h("div", { class: "foot-inner" },
    h("div", { class: "foot-top" },
      h("div", { class: "foot-brand" },
        h("a", { class: "brand", href: "#/" }, h("img", { src: "/assets/mark.svg", alt: "", width: 30, height: 30 }), h("span", { class: "brand-name" }, "ShortStop")),
        h("p", {}, "Explainable drug-shortage response for hospital pharmacy teams. Built for the Open Agent Hackathon 2026, Reasoning Architecture track.")),
      h("div", { class: "foot-col" }, h("h4", {}, "Product"),
        h("a", { href: "#/" }, "Overview"), h("a", { href: "#/command" }, "Console"), h("a", { href: "#/decisions" }, "Decisions"), h("a", { href: "#/memory" }, "Memory"), h("a", { href: "#/system" }, "System")),
      h("div", { class: "foot-col" }, h("h4", {}, "Built with"),
        h("span", {}, "Zetaris"), h("span", {}, "Meterless H-MEM"), h("span", {}, "Meterless Nightshift"), h("span", {}, "NVIDIA Nemotron"), h("span", {}, "openFDA")),
      h("div", { class: "foot-col" }, h("h4", {}, "Project"),
        h("a", { href: REPO, target: "_blank", rel: "noopener" }, "GitHub repository ↗"),
        h("a", { href: `${REPO}/blob/main/LICENSE`, target: "_blank", rel: "noopener" }, "Licence · Apache-2.0 ↗"),
        h("a", { href: `${REPO}#readme`, target: "_blank", rel: "noopener" }, "Documentation ↗"),
        h("a", { href: "#/", onclick: (e) => { e.preventDefault(); location.hash = "#/"; setTimeout(() => document.getElementById("faq")?.scrollIntoView({ behavior: "smooth" }), 400); } }, "FAQ"))),
    h("div", { class: "foot-word", "aria-hidden": "true" }, "ShortStop"),
    h("div", { class: "foot-bottom" },
      h("span", {}, "© 2026 ShortStop · Apache-2.0"),
      h("span", { class: "disc" }, "Demonstration system, not clinical decision support. Hospital data is synthetic; shortage records are public openFDA data. No action is taken without a pharmacist."))));
}
