"use client";

import { useEffect, useState } from "react";

// 解析 "每日 23:00–次日 09:00" 这类字符串，取出起止时间（支持跨零点）
function parseWindow(w) {
  const m = String(w || "").match(/(\d{1,2}):(\d{2})\D+?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return { start: +m[1] * 60 + +m[2], end: +m[3] * 60 + +m[4] };
}

function inWindow(now, w) {
  const n = now.getHours() * 60 + now.getMinutes();
  if (w.start <= w.end) return n >= w.start && n < w.end;
  return n >= w.start || n < w.end; // 跨零点（如 23:00–09:00）
}

export default function PromoWindow({ window: w }) {
  const [active, setActive] = useState(null);

  useEffect(() => {
    const t = parseWindow(w);
    if (!t) return;
    const update = () => setActive(inWindow(new Date(), t));
    update();
    const id = setInterval(update, 60 * 1000);
    return () => clearInterval(id);
  }, [w]);

  if (active === null) return <span className="badge b-amber">{w}</span>;
  return active ? (
    <span className="badge b-green">{w} · 现在正处时段内</span>
  ) : (
    <span className="badge b-gray">{w} · 当前不在时段</span>
  );
}
