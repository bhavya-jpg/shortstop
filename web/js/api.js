// JSON API client for src/server.ts.

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${url} failed (HTTP ${res.status})`);
  return data;
}

export const api = {
  meta: () => call("GET", "/api/meta"),
  health: () => call("GET", "/api/health"),
  scenarios: () => call("GET", "/api/scenarios"),
  runs: () => call("GET", "/api/runs"),
  run: (id) => call("GET", `/api/runs/${encodeURIComponent(id)}`),
  start: (body) => call("POST", "/api/runs", body),
  review: (runId, decisionId, body) =>
    call("POST", `/api/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(decisionId)}/review`, body),
  precedents: (item) => call("GET", `/api/precedents${item ? `?item=${encodeURIComponent(item)}` : ""}`),
  zetarisJoin: () => call("GET", "/api/zetaris/join"),
  events: (id) => new EventSource(`/api/runs/${encodeURIComponent(id)}/events`),
};
