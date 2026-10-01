"use client";

import { useMemo, useState } from "react";
import { CATEGORY_LABEL, money, unitSuffix } from "../lib/util";

const PRESETS = [50, 100, 200, 500];

/**
 * 预算比价器：输入每月预算 → 列出预算内买得到的所有档位。
 *
 * 刻意不做「额度归一化折算 / 性价比排名」：各家额度单位（积分、Credits、
 * 请求数、亿 Tokens）口径完全不同，硬折出来的排名是「编造出来的精确」。
 * 这里只做能做准的事 —— 按标价筛选，把额度原文摆出来让人自己看。
 */
export default function BudgetCalc({ products }) {
  const [budget, setBudget] = useState(100);

  const rows = useMemo(() => {
    const out = [];
    for (const p of products) {
      // 只算国内计费、且在运营的产品；「仅收录」与已关停的不进比价
      if (p.scope === "watch" || p.status !== "active") continue;
      for (const pl of p.plans || []) {
        if (pl.price == null || pl.price > budget) continue;
        out.push({ p, pl });
      }
    }
    return out.sort((a, b) => a.pl.price - b.pl.price);
  }, [products, budget]);

  const vendorCount = new Set(rows.map((r) => r.p.slug)).size;

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">预算比价器</h2>
        <p className="section-sub">
          按各档位标价筛选（季付 / 年付折算价以官网标注为准）；只含国内计费产品，
          海外计费与「仅收录」不计入
        </p>
      </div>

      <div className="toolbar">
        <div className="tabs">
          {PRESETS.map((v) => (
            <button
              key={v}
              className={`tab ${budget === v ? "active" : ""}`}
              onClick={() => setBudget(v)}
            >
              ¥{v}
            </button>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "4px 12px",
            background: "var(--card)",
          }}
        >
          <span style={{ color: "var(--muted)", fontSize: 13 }}>每月预算 ¥</span>
          <input
            type="number"
            min="0"
            step="10"
            value={budget}
            onChange={(e) => setBudget(Math.max(0, Number(e.target.value) || 0))}
            style={{
              width: 80,
              border: "none",
              outline: "none",
              background: "transparent",
              font: "inherit",
              color: "var(--ink)",
              fontWeight: 600,
            }}
          />
        </div>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          {rows.length} 个档位 · 覆盖 {vendorCount} 家
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">该预算内没有可买的档位，试试调高预算。</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>产品</th>
                <th>档位</th>
                <th>价格</th>
                <th>额度 / 说明</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, pl }, i) => (
                <tr key={`${p.slug}-${i}`}>
                  <td className="cell-prod">
                    <div className="name">{p.name}</div>
                    <div className="sub">
                      {p.vendor} · {CATEGORY_LABEL[p.category] || p.category}
                    </div>
                  </td>
                  <td className="nowrap">{pl.name}</td>
                  <td className="nowrap">
                    {pl.price === 0 ? (
                      <span className="free-txt">免费</span>
                    ) : (
                      <>
                        <b className="num">{money(p, pl.price, pl)}</b>
                        <span className="unit">{unitSuffix(pl.unit) || "/月"}</span>
                      </>
                    )}
                  </td>
                  <td className="cell-quota">{pl.quota || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="section-sub" style={{ marginTop: 10 }}>
        ⚠️ 各家额度单位（积分 / Credits / 请求数 / Tokens）口径不同，<b>不能相互换算</b>，
        所以这里只做「这个预算内能选什么」的筛选，不做「性价比排名」——那种排名只能靠编。
      </p>
    </section>
  );
}
