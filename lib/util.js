export const CATEGORIES = [
  { key: "all", label: "全部" },
  { key: "coding", label: "编程" },
  { key: "office", label: "办公" },
  { key: "general", label: "通用" },
  { key: "api", label: "API / Token" },
];

export const CATEGORY_LABEL = {
  coding: "编程",
  office: "办公",
  general: "通用",
  api: "API / Token",
};

export const PRICE_STATUS = {
  verified: { label: "已核实", cls: "b-green", title: "已直接核对官方定价页" },
  partial: { label: "部分核实", cls: "b-blue", title: "已核对官网，但部分档位价格未公开或待确认" },
  pending: { label: "待核实", cls: "b-gray", title: "定价页为动态渲染，爬虫核实中" },
};

export function entryPrice(product) {
  const plans = (product.plans || []).filter((p) => p.price != null);
  if (!plans.length) return { text: "待核实", promo: null };
  if (plans.some((p) => p.price === 0)) return { text: "有免费档", promo: null };
  const min = plans.reduce((a, b) => (a.price <= b.price ? a : b));
  return { text: `¥${min.price}/月`, promo: min.intro ? `首月 ¥${min.intro}` : null };
}

export function freeQuota(product) {
  const free = (product.plans || []).find((p) => p.price === 0 && p.quota);
  if (free) return free.quota;
  const withQuota = (product.plans || []).find((p) => p.quota);
  return withQuota ? withQuota.quota : "—";
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
