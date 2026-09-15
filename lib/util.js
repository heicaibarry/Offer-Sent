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

/* ------------------------------------------------------------------ *
 * 活动分层与取值
 * 目标：让「能省多少」成为可扫读的一等信息，而不是埋在正文里。
 * ------------------------------------------------------------------ */

// 从活动标题 + 详情里抽一个「价值标签」：省 ¥938 / 7 折 / 首月 ¥9.9 / 免费
export function promoValue(promo) {
  const title = promo?.title || "";
  const t = `${title} ${promo?.detail || ""}`;
  if (/限时免费|限免|免费|白嫖/.test(title)) return { text: "免费", kind: "free" };
  const save = t.match(/立省\s*¥?\s*([\d,]+(?:\.\d+)?)/);
  if (save) return { text: `省 ¥${save[1]}`, kind: "save" };
  const first = t.match(/首月\s*¥?\s*([\d.]+)/);
  if (first) return { text: `首月 ¥${first[1]}`, kind: "save" };
  const off = t.match(/(\d(?:\.\d)?)\s*折/);
  if (off) return { text: `${off[1]} 折`, kind: "save" };
  return null;
}

// 一条活动的「省钱力度」评分，用于排序与卡头选主（数值越大越猛）
export function promoScore(promo) {
  const t = `${promo?.detail || ""} ${promo?.title || ""}`;
  let score = 0;
  for (const m of t.matchAll(/¥\s?([\d,]+(?:\.\d+)?)/g)) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) score = Math.max(score, n);
  }
  for (const m of t.matchAll(/(\d(?:\.\d)?)\s*折/g)) {
    // 折数越小越猛：5 折 ≈ 300 分，与"省 ¥300"同量级，便于混排
    score = Math.max(score, (10 - parseFloat(m[1])) * 60);
  }
  return score;
}

// 三档归类：算得出省多少钱 → save；免费领取 → free；其余权益/返利 → perk
export function promoBucket(promo) {
  const t = `${promo?.title || ""} ${promo?.detail || ""}`;
  if (/免费|白嫖|限免|领取|注册即|签到|0\s?元/.test(t)) return "free";
  if (/折|立省|首月|省\s?¥|原价\s?¥/.test(t)) return "save";
  return "perk";
}

export const BUCKETS = {
  save: { title: "立刻省钱", sub: "有明确折扣或首月价，算得出省多少" },
  free: { title: "免费白嫖", sub: "限免、注册即领、签到送额度" },
  perk: { title: "会员权益", sub: "长期折扣、邀请返利等" },
};

// 取产品的「最低月价」（有免费档记 0）
export function minPlanPrice(product) {
  const plans = (product.plans || []).filter((p) => p.price != null);
  if (!plans.length) return null;
  return plans.reduce((a, b) => (a.price <= b.price ? a : b)).price;
}

// 该产品带免费档的条数
export function freePlanCount(product) {
  return (product.plans || []).filter((p) => p.price === 0).length;
}

// 该产品最低档的首月价（用于表格"首月价"列）
export function introPrice(product) {
  const plans = (product.plans || []).filter((p) => p.price != null && p.price > 0);
  if (!plans.length) return null;
  const min = plans.reduce((a, b) => (a.price <= b.price ? a : b));
  return min.intro != null ? min.intro : null;
}

/**
 * 把「每个产品多条活动」整理成「每个产品一张卡」。
 * 卡片按各自最强活动的力度降序，分入 save / free / perk 三档。
 * 同产品的多条活动全部保留在 card.promos（不折叠、不截断）。
 */
export function groupDeals(products) {
  const buckets = { save: [], free: [], perk: [] };

  for (const p of products) {
    const promos = p.promos || [];
    if (!promos.length) continue;

    const strongest = [...promos].sort((a, b) => promoScore(b) - promoScore(a))[0];
    const bucket = promoBucket(strongest);
    const value = promoValue(strongest);

    buckets[bucket].push({
      product: p,
      promos,                                  // 全部活动，逐条渲染
      value,                                   // 卡头大字（来自最强的那条）
      valueFrom: value ? strongest.title : "", // 大字出自哪条活动，避免张冠李戴
      topScore: promoScore(strongest),
    });
  }

  buckets.save.sort((a, b) => b.topScore - a.topScore);
  buckets.free.sort((a, b) => b.topScore - a.topScore);
  return buckets;
}
