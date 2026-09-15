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

// 表格「免费额度 / 套餐」列：优先展示免费档额度，没有免费档就退到首档额度
export function freeQuota(product) {
  const free = (product.plans || []).find((p) => p.price === 0 && p.quota);
  if (free) return free.quota;
  const withQuota = (product.plans || []).find((p) => p.quota);
  return withQuota ? withQuota.quota : "—";
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 时间线用：只按字面量切 ISO 串，不做时区换算，保证任何运行环境下结果一致
export function fmtDateTime(iso) {
  if (!iso) return "";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return String(iso);
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return m[4] ? `${day} ${m[4]}:${m[5]}` : day;
}

/* ------------------------------------------------------------------ *
 * 货币
 * 国内产品默认人民币。海外计费的产品在 products.json 里写 "currency": "USD"，
 * 由这里统一出符号，避免再出现「¥20 USD/月」这种硬编码符号写错币种的问题。
 * ------------------------------------------------------------------ */
export function currencyOf(product, plan) {
  const cur = plan?.currency || product?.currency || "CNY";
  return cur === "USD" ? "$" : "¥";
}

export function money(product, amount, plan) {
  if (amount == null) return "待核实";
  return `${currencyOf(product, plan)}${amount}`;
}

// 单位里往往自带货币词（"元/月"、"USD/月"），和货币符号重复 → 去掉货币词只留周期
export function unitSuffix(unit) {
  return String(unit || "")
    .replace(/^(人民币|美元|元|RMB|USD|CNY|\$|¥)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ *
 * 活动有效期（渲染层过期判定）
 *
 * 为什么要在渲染层判、而不是直接删数据：
 *   活动是爬虫采集来的历史资产，到期应该「下架」而立刻消失得无影无踪，
 *   所以保留数据、只控制展示；过期判定集中在这里，所有页面共用一套规则。
 *
 * 时间一致性（static export + React 预渲染）：
 *   1) 静态站点的 HTML 是 next build 那一刻生成的。如果组件在渲染函数里直接
 *      Date.now()，客户端 hydrate 时会算出另一个值 → 预渲染内容 ≠ 首次客户端
 *      渲染内容 → React 报 hydration mismatch。
 *   2) 所以参照时刻由服务端组件取一次（构建时刻），当 prop 传给客户端组件；
 *      客户端首次渲染沿用同一个值，输出与静态 HTML 完全一致。
 *   3) 组件挂载后再用 useEffect 换成浏览器真实时间并按分钟复核，
 *      这样「构建之后才到期」的活动不用等下一次构建就会自动下架。
 * ------------------------------------------------------------------ */

// 解析截止时间；endsAt 缺失或非法一律返回 null（视为长期有效，宁可多留、不可误删）
export function promoEndsAt(promo) {
  if (!promo?.endsAt) return null;
  const t = Date.parse(promo.endsAt);
  return Number.isNaN(t) ? null : t;
}

export function isPromoExpired(promo, nowMs) {
  const t = promoEndsAt(promo);
  return t != null && t < nowMs;
}

// 拆成 { active, expired }，顺序保持原样
export function splitPromos(promos, nowMs) {
  const active = [];
  const expired = [];
  for (const p of promos || []) (isPromoExpired(p, nowMs) ? expired : active).push(p);
  return { active, expired };
}

export function activePromos(product, nowMs) {
  return splitPromos(product?.promos, nowMs).active;
}

// 距截止还有几天（无 endsAt → null；已过期 → ≤ 0）
export function daysLeft(promo, nowMs) {
  const t = promoEndsAt(promo);
  if (t == null) return null;
  return Math.ceil((t - nowMs) / 86400000);
}

// 临近截止（默认 7 天内）→ 需要给出紧迫提示
export function endsSoon(promo, nowMs, withinDays = 7) {
  const d = daysLeft(promo, nowMs);
  return d != null && d > 0 && d <= withinDays;
}

// 截止文案："今天截止" / "明天截止" / "9/30 截止（15 天后）"
export function endLabel(promo, nowMs) {
  const d = daysLeft(promo, nowMs);
  if (d == null) return "";
  if (d <= 0) return "已结束";
  if (d === 1) return "明天截止";
  if (d <= 7) return `${d} 天后截止`;
  return `${fmtDate(promo.endsAt)} 截止`;
}

/* ------------------------------------------------------------------ *
 * 活动分层与取值
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
  // 算不出金额的增量福利（额度翻倍 / 加赠）给个定性标签，别让活动行空着
  if (/翻倍|加倍/.test(title)) return { text: "额度翻倍", kind: "save" };
  if (/加赠|赠送|多送|领\s*[\d,.]+\s*(万|亿)?\s*(Tokens?|Credits?|积分)/i.test(title))
    return { text: "额外加赠", kind: "save" };
  return null;
}

// 一条活动的「省钱力度」评分，用于排序与卡头选主（数值越大越猛）
// ⚠️ 只认「省下来的钱」，不要把付出去的价格当力度：更早的版本取全文最大的 ¥ 数字，
// 结果「年付 ¥4,690（对比月付 ¥5,628）」里的正价把分数顶到 5628，压过了真正
// 「立省 ¥1,680」的活动。改为优先认显式省钱写法，再退到折扣力度与首月价。
export function promoScore(promo) {
  const t = `${promo?.detail || ""} ${promo?.title || ""}`;
  // 1) 显式写出的省钱金额：立省 ¥938 / 省 ¥1,680 / 省 200 元
  //    注意 `省 N%` 是百分比不是金额，所以裸「省」必须跟 ¥，或跟「元」
  const explicit =
    t.match(/立省\s*¥?\s*([\d,]+(?:\.\d+)?)/) ||
    t.match(/省\s*¥\s*([\d,]+(?:\.\d+)?)/) ||
    t.match(/省\s*([\d,]+(?:\.\d+)?)\s*元/);
  let score = explicit ? parseFloat(explicit[1].replace(/,/g, "")) : 0;
  // 2) 折扣力度：折数越小越猛（5 折 ≈ 300 分，与"省 ¥300"同量级，便于混排）
  for (const m of t.matchAll(/(\d(?:\.\d)?)\s*折/g)) {
    score = Math.max(score, (10 - parseFloat(m[1])) * 60);
  }
  // 3) 只写了首月价、算不出省多少的，给个低位分，别让它顶掉能量化的活动
  if (score === 0 && /首月\s*¥?\s*[\d.]/.test(t)) score = 30;
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
 * 过期活动在这里就被过滤掉：产品名下活动全部过期 → 整张卡下架，不再出现在优惠板块。
 * 卡片按各自最强活动的力度降序，分入 save / free / perk 三档。
 * 同产品的多条进行中活动全部保留在 card.promos（不折叠、不截断）。
 */
export function groupDeals(products, nowMs) {
  const buckets = { save: [], free: [], perk: [] };

  for (const p of products) {
    const { active, expired } = splitPromos(p.promos, nowMs);
    if (!active.length) continue;

    const strongest = [...active].sort((a, b) => promoScore(b) - promoScore(a))[0];
    const bucket = promoBucket(strongest);
    const value = promoValue(strongest);

    buckets[bucket].push({
      product: p,
      promos: active,                          // 进行中的活动，逐条渲染
      endedCount: expired.length,              // 已结束的条数，用于透明提示
      value,                                   // 卡头大字（来自最强的那条）
      valueFrom: value ? strongest.title : "", // 大字出自哪条活动，避免张冠李戴
      topScore: promoScore(strongest),
    });
  }

  buckets.save.sort((a, b) => b.topScore - a.topScore);
  buckets.free.sort((a, b) => b.topScore - a.topScore);
  return buckets;
}
