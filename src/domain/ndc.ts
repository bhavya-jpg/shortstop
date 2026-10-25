// NDC normalization. FDA publishes 10-digit NDCs in three segment layouts
// (4-4-2, 5-3-2, 5-4-1). The 11-digit 5-4-2 form pads the short segment with a
// leading zero, which makes package identity comparable across sources.
// An unhyphenated 10-digit NDC is ambiguous (the layout cannot be recovered),
// so it is rejected rather than guessed.

export type NdcResult =
  | { ok: true; ndc11: string; product11: string; layout: "4-4-2" | "5-3-2" | "5-4-1" | "5-4-2" }
  | { ok: false; error: string };

export function normalizeNdc(raw: unknown): NdcResult {
  if (typeof raw !== "string") return { ok: false, error: "NDC is not a string" };
  const s = raw.trim();
  if (s === "") return { ok: false, error: "NDC is empty" };

  if (/^\d{11}$/.test(s)) {
    return build(s.slice(0, 5), s.slice(5, 9), s.slice(9), "5-4-2");
  }
  if (/^\d{10}$/.test(s)) {
    return { ok: false, error: `unhyphenated 10-digit NDC "${s}" is ambiguous` };
  }
  const m = /^(\d+)-(\d+)-(\d+)$/.exec(s);
  if (!m) return { ok: false, error: `NDC "${s}" is not in a labeler-product-package format` };
  const [labeler, product, pkg] = [m[1]!, m[2]!, m[3]!];
  const layout = `${labeler.length}-${product.length}-${pkg.length}`;
  switch (layout) {
    case "4-4-2":
      return build(`0${labeler}`, product, pkg, "4-4-2");
    case "5-3-2":
      return build(labeler, `0${product}`, pkg, "5-3-2");
    case "5-4-1":
      return build(labeler, product, `0${pkg}`, "5-4-1");
    case "5-4-2":
      return build(labeler, product, pkg, "5-4-2");
    default:
      return { ok: false, error: `NDC "${s}" has unsupported segment layout ${layout}` };
  }
}

function build(labeler: string, product: string, pkg: string, layout: "4-4-2" | "5-3-2" | "5-4-1" | "5-4-2"): NdcResult {
  return { ok: true, ndc11: `${labeler}-${product}-${pkg}`, product11: `${labeler}-${product}`, layout };
}
