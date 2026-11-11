import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 640
BG = (13, 20, 33)
GRID = (25, 36, 56)
ACCENT = (52, 211, 153)      # green
ACCENT2 = (96, 165, 250)     # blue
TEXT = (233, 240, 250)
MUTED = (148, 163, 184)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# subtle grid
for x in range(0, W, 40):
    d.line([(x, 0), (x, H)], fill=GRID, width=1)
for y in range(0, H, 40):
    d.line([(0, y), (W, y)], fill=GRID, width=1)

# glow blobs
glow = Image.new("RGB", (W, H), BG)
gd = ImageDraw.Draw(glow)
gd.ellipse([-160, -200, 460, 420], fill=(16, 48, 66))
gd.ellipse([820, 300, 1480, 900], fill=(20, 30, 66))
img = Image.blend(img, glow, 0.55)
d = ImageDraw.Draw(img)

F = r"C:\Windows\Fonts"
title_f = ImageFont.truetype(os.path.join(F, "msyhbd.ttc"), 82)
sub_f = ImageFont.truetype(os.path.join(F, "msyh.ttc"), 30)
chip_num = ImageFont.truetype(os.path.join(F, "msyhbd.ttc"), 40)
chip_lbl = ImageFont.truetype(os.path.join(F, "msyh.ttc"), 21)
small_f = ImageFont.truetype(os.path.join(F, "msyh.ttc"), 22)
tag_f = ImageFont.truetype(os.path.join(F, "msyhbd.ttc"), 22)

# tag
d.rounded_rectangle([72, 62, 292, 106], radius=22, fill=(23, 42, 58), outline=(45, 70, 96), width=1)
d.text((96, 70), "DeepSeek Harness 插件", font=tag_f, fill=ACCENT)

# title
d.text((68, 138), "Token 管家", font=title_f, fill=TEXT)

# version badge (right aligned, avoids overlapping the title)
ver_f = ImageFont.truetype(os.path.join(F, "msyh.ttc"), 24)
ver_text = "v0.18.0 · MIT · 零 prompt 改动"
vw = d.textlength(ver_text, font=ver_f)
d.rounded_rectangle([W - 72 - vw - 44, 62, W - 72, 106], radius=22, fill=(23, 42, 58), outline=(45, 70, 96), width=1)
d.text((W - 72 - vw - 22, 71), ver_text, font=ver_f, fill=MUTED)

# subtitle
d.text((72, 252), "把每一笔 token 账单摊开看：缓存命中、失效损失、大结果压缩、换会话省钱", font=sub_f, fill=MUTED)

# chips
chips = [
    ("66%", "长会话账单是重复发送的历史"),
    ("−94%", "换任务开新会话，单请求成本"),
    ("−69%", "大工具输出结构压缩"),
]
x = 72
for num, lbl in chips:
    w = 372 if lbl.endswith("历史") else 360
    d.rounded_rectangle([x, 348, x + w, 492], radius=20, fill=(19, 30, 46), outline=(40, 58, 82), width=1)
    d.text((x + 26, 366), num, font=chip_num, fill=ACCENT if num != "−94%" else ACCENT2)
    d.text((x + 26, 424), lbl, font=chip_lbl, fill=TEXT)
    x += w + 26

# footer
d.line([(72, 540), (1208, 540)], fill=(36, 50, 72), width=1)
d.text((72, 556), "真实计费口径 · 缓存前缀哨兵 · 无损工具输出压缩 · 命令/HTTP/面板 全部零 token 开销", font=small_f, fill=MUTED)
d.text((72, 596), "github.com/yyy-yq1/dsh-plugin-token-governor", font=small_f, fill=ACCENT2)

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "social-preview.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG", optimize=True)
print(out, img.size, os.path.getsize(out))
