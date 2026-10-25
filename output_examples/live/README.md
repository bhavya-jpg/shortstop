# Live evidence (real Zetaris and Nightshift, 2026-10-25)

These files come from real runs against a local Zetaris instance and Meterless
Nightshift. They are **not** sample-mode output; the sample-mode examples are in
the parent folder. Hospital data, policies and precedents are SYNTHETIC. Copies
were checked for credentials, user paths and emails before inclusion.

| File | What it shows |
|---|---|
| `scenario-1-furosemide.live-*` | Zetaris data → H-MEM recall → Nemotron planner (3 candidates, all valid) → Nemotron critic accepts → `PENDING_APPROVAL` |
| `scenario-2-sodium-bicarbonate.live-*` | 45 days of stock: planning skipped, no chat call → `MONITOR_PENDING_ACKNOWLEDGEMENT` |
| `scenario-3-dexmedetomidine.live-*` | ICU usage missing + conflicting H-MEM precedents → `ESCALATED` (4 reasons) |
| `check-nightshift.json` | `/v1/models`, real completion, invalid token → 401 |
| `check-zetaris.json`, `check-zetaris-tables.json` | Auth, SQL, 1,142 openFDA rows, hospital tables, cross-source join |
| `check-register-*.json` | Registration statements as executed |
| `nemotron-class-route-test.json` | `meterless/text` and `meterless/judge` requests; receipts show `provider_model: meterless/auto`, routed to Nemotron |

In each `*.live-output.json`, `decisions[].model_calls[].meterless` is Nightshift's
`meterless.compute_receipt.v1` for that call: the routed model, provider, phases and usage.
