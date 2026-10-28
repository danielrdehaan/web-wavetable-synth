# Compares two folders of skinshots.mjs screenshots: python3 tools/skindiff.py <before> <after> [out].
# Prints, per shot, the share of pixels that changed by more than a small tolerance (antialiasing), and
# writes <out>/<name>.png with the changed pixels in red over a faded copy of the "after" shot.
import os
import sys
from PIL import Image, ImageChops

before, after = sys.argv[1], sys.argv[2]
out = sys.argv[3] if len(sys.argv) > 3 else None
TOL = 24  # summed RGB difference below this counts as unchanged
if out:
    os.makedirs(out, exist_ok=True)
for name in sorted(os.listdir(before)):
    if not name.endswith('.png') or not os.path.exists(os.path.join(after, name)):
        continue
    a = Image.open(os.path.join(before, name)).convert('RGB')
    b = Image.open(os.path.join(after, name)).convert('RGB')
    if a.size != b.size:
        print(f'{name}: sizes differ {a.size} vs {b.size}')
        continue
    diff = ImageChops.difference(a, b)
    r, g, bl = diff.split()
    total = ImageChops.add(ImageChops.add(r, g), bl)
    mask = total.point(lambda v: 255 if v > TOL else 0)
    changed = sum(1 for v in mask.getdata() if v)
    share = changed / (a.size[0] * a.size[1])
    box = mask.getbbox()
    print(f'{name}: {share * 100:.3f}% changed' + (f', within {box}' if box else ''))
    if out and changed:
        faded = Image.blend(b, Image.new('RGB', b.size, (255, 255, 255)), 0.6)
        faded.paste(Image.new('RGB', b.size, (255, 0, 0)), mask=mask)
        faded.save(os.path.join(out, name))
