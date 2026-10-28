# 앱 아이콘(16×16 픽셀 "B + 커서")을 그려 앱 아이콘 파일을 만든다.
# 사용: python -I tools/make-icon.py
# 결과: build/icon.png(1024), build/icon.ico(Windows), build/icon.icns(Mac)
# 픽셀 그림이라 정수 배율(최근접)로만 키운다. 그래서 .ico 에 24px 는 넣지 않는다(1.5배는 픽셀이 뭉개짐).
from pathlib import Path

from PIL import Image, ImageColor

RIM, TILE, SHADE, ACC = '#3c414d', '#131519', '#0a0b0d', '#f0c94a'
B = ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X...X', 'X...X', 'XXXX.']
CURSOR = ['XXX'] * 7

grid = [[None] * 16 for _ in range(16)]
for y in range(1, 15):
    for x in range(1, 15):
        grid[y][x] = TILE
for i in range(2, 14):
    grid[0][i] = grid[15][i] = grid[i][0] = grid[i][15] = RIM
for x, y in ((1, 1), (14, 1), (1, 14), (14, 14)):
    grid[y][x] = RIM

letters = []
for glyph, x0 in ((B, 3), (CURSOR, 9)):
    for dy, row in enumerate(glyph):
        for dx, c in enumerate(row):
            if c == 'X':
                letters.append((x0 + dx, 5 + dy))
for x, y in letters:
    if grid[y + 1][x] == TILE:
        grid[y + 1][x] = SHADE
for x, y in letters:
    grid[y][x] = ACC

base = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
for y, row in enumerate(grid):
    for x, c in enumerate(row):
        if c:
            base.putpixel((x, y), ImageColor.getrgb(c) + (255,))

assert base.getpixel((0, 0))[3] == 0 and base.getpixel((3, 5))[:3] == ImageColor.getrgb(ACC)

out = Path(__file__).resolve().parent.parent / 'build'
up = lambda n: base.resize((n, n), Image.NEAREST)
up(1024).save(out / 'icon.png')
# .ico 는 크기별 그림을 직접 넘긴다. 큰 그림 하나만 주면 Pillow 가 줄이며 뭉갠다.
sizes = [16, 32, 48, 64, 128, 256]
up(256).save(out / 'icon.ico', sizes=[(n, n) for n in sizes], append_images=[up(n) for n in sizes[:-1]])
# 맥은 아이콘 둘레에 여백을 두는 게 관례(약 10%). 1024 판 가운데 832(=16×52) 로 놓는다.
mac = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
mac.paste(up(832), (96, 96))
mac.save(out / 'icon.icns')
print('build/icon.png, icon.ico, icon.icns')
