# -*- coding: utf-8 -*-
"""
agent-deals 图标 · v8 定稿：折扣价签（Discount Tag）

设计决策记录（为什么放弃雷达弧线）：
  前 7 版都用「中心点 + 同心弧」表达雷达/扫描。实测无论把圆心摆到左下、
  把弧收窄、去掉扇区，缩略后一律被读作 WiFi 图标 —— 该形状族与无线信号
  符号完全同构，属于不可救的歧义。因此改用单一主体符：

     价签轮廓（圆角矩形 + 左上角穿孔） + 下折箭头（降价语义）

  语义唯一、轮廓粗大，16px 下仍能辨认；颜色沿用项目主色青→蓝→紫渐变。

分尺寸差异化：
  · 大尺寸(48+)：价签 + 双层下箭头 + 穿孔 + 柔和高光
  · 小尺寸(16/24/32)：只留价签轮廓 + 单层粗下箭头（去掉穿孔与描边细节）
"""
from PIL import Image, ImageDraw, ImageFilter
import os

OUT = r"E:\AI编程\综合类\agent-deals\assets\agent-deals.ico"
PREVIEW = r"E:\AI编程\综合类\_ico_preview"

C1 = (32, 201, 214)      # 青
C2 = (56, 128, 246)      # 蓝
C3 = (129, 90, 242)      # 紫


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def grad_color(t):
    t = max(0.0, min(1.0, t))
    if t < 0.5:
        return lerp(C1, C2, t / 0.5)
    return lerp(C2, C3, (t - 0.5) / 0.5)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def make_base(S):
    base = Image.new("RGB", (S, S))
    px = base.load()
    for y in range(S):
        for x in range(S):
            px[x, y] = grad_color(x / S * 0.50 + y / S * 0.50)
    hl = Image.new("L", (S, S), 0)
    ImageDraw.Draw(hl).ellipse([-S * 0.34, -S * 0.46, S * 0.72, S * 0.50], fill=46)
    hl = hl.filter(ImageFilter.GaussianBlur(S * 0.12))
    return Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), base, hl)


def render(S, detailed=True):
    base = make_base(S)
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 价签几何：略微向左留白，给右侧下箭头腾出比重
    if detailed:
        tw, th = S * 0.545, S * 0.400          # tag 宽高
        tx, ty = S * 0.117, S * 0.170          # 左上角
        rad = int(S * 0.062)
        hole_r = S * 0.043
        stroke = max(2, int(S * 0.0260))
        arw = max(2, int(S * 0.0530))          # 箭头笔画
    else:
        # 小尺寸：价签整体缩小，让渐变外框形成清晰留白，避免白块糊满画布
        tw, th = S * 0.560, S * 0.395
        tx, ty = S * 0.140, S * 0.185
        rad = int(S * 0.070)
        hole_r = 0
        stroke = max(2, int(S * 0.0300))
        arw = max(2, int(S * 0.0760))

    # --- 价签本体（白）---
    tag = [tx, ty, tx + tw, ty + th]
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [tag[0] + S * 0.010, tag[1] + S * 0.022, tag[2] + S * 0.010, tag[3] + S * 0.022],
        radius=rad, fill=(16, 34, 82, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.022))
    layer = Image.alpha_composite(layer, shadow)

    d = ImageDraw.Draw(layer)
    d.rounded_rectangle(tag, radius=rad, fill=(255, 255, 255, 255))

    # --- 左上穿孔 ---
    if detailed:
        hx, hy = tx + tw * 0.235, ty + th * 0.300
        d.ellipse([hx - hole_r, hy - hole_r, hx + hole_r, hy + hole_r],
                  fill=grad_color(0.34) + (255,))

    # --- ¥ 符号（降价语义）---
    ink = grad_color(0.60)
    cx = tx + tw * 0.560
    top = ty + th * 0.175          # 上移一点，整体居中
    mid = ty + th * 0.465          # 折点
    tip = ty + th * 0.800          # 收住，避免贴底
    half = tw * 0.150

    d.line([(cx - half, top), (cx, mid)], fill=ink + (255,), width=arw)
    d.line([(cx + half, top), (cx, mid)], fill=ink + (255,), width=arw)
    d.line([(cx, mid), (cx, tip)], fill=ink + (255,), width=arw)

    # 两道横杠 —— 构成 ¥ 的横画
    if detailed:
        y1 = mid + th * 0.075
        y2 = mid + th * 0.265
        for by in (y1, y2):
            d.line([(cx - half * 1.15, by), (cx + half * 1.15, by)],
                   fill=ink + (255,), width=max(2, int(stroke * 0.86)))
    else:
        by = mid + th * 0.170
        d.line([(cx - half * 1.10, by), (cx + half * 1.10, by)],
               fill=ink + (255,), width=max(2, int(stroke * 0.90)))

    icon = Image.alpha_composite(base.convert("RGBA"), layer)
    icon.putalpha(rounded_mask(S, int(S * 0.222)))
    return icon


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    os.makedirs(PREVIEW, exist_ok=True)

    imgs = {}
    for n in (256, 128, 64, 48, 32, 24, 16):
        detailed = n >= 48
        imgs[n] = render(n * 4, detailed=detailed).resize((n, n), Image.LANCZOS)
        imgs[n].save(os.path.join(PREVIEW, f"agent-deals_{n}.png"))

    base = imgs[256]
    base.save(OUT, format="ICO",
              sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)],
              append_images=[imgs[128], imgs[64], imgs[48], imgs[32], imgs[24], imgs[16]])
    print("ICO:", OUT, os.path.getsize(OUT), "bytes")
    return OUT


if __name__ == "__main__":
    main()
