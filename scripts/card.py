# Dev helper: slim skeleton of the Nth element whose opening tag matches a regex.
# Usage: python -I scripts/card.py .probe/<site>.html '<regex on tag>' [nth] [len]
import re, sys
sys.stdout.reconfigure(encoding='utf-8')
path, pat = sys.argv[1], sys.argv[2]
nth = int(sys.argv[3]) if len(sys.argv) > 3 else 1
ln = int(sys.argv[4]) if len(sys.argv) > 4 else 2500
h = open(path, encoding='utf-8').read()
h = re.sub(r'<(script|style|svg)[\s\S]*?</\1>', '', h)
ms = [m for m in re.finditer(r'<[^>]+>', h) if re.search(pat, m.group(0))]
print('matches:', len(ms))
if not ms:
    sys.exit()
m = ms[min(nth, len(ms) - 1)]
chunk = h[m.start(): m.start() + ln]
def slim(t):
    tag = t.group(0)
    name = re.match(r'</?\s*([a-zA-Z0-9-]+)', tag)
    if not name:
        return ''
    keep = re.findall(r'\s(class|href|title|data-[a-z-]+|itemprop|id)="([^"]{0,80})"', tag)
    attrs = ''.join(f' {k}="{v}"' for k, v in keep)
    return f'<{"/" if tag.startswith("</") else ""}{name.group(1)}{attrs}>'
chunk = re.sub(r'<[^>]+>', slim, chunk)
print(re.sub(r'\s+', ' ', chunk))
