# Dev helper: show the class skeleton around the Nth price occurrence in a saved page.
# Usage: python -I scripts/inspect.py .probe/<site>.html [nth] [width]
import re, sys
sys.stdout.reconfigure(encoding='utf-8')
path = sys.argv[1]
nth = int(sys.argv[2]) if len(sys.argv) > 2 else 3
width = int(sys.argv[3]) if len(sys.argv) > 3 else 2500
h = open(path, encoding='utf-8').read()
h = re.sub(r'<(script|style|svg)[\s\S]*?</\1>', '', h)
prices = list(re.finditer(r'\d{1,3}(?:\.\d{3})+(?:,\d{2})?\s*(?:TL|₺)|₺\s*\d{1,3}(?:\.\d{3})+', h))
print('price hits:', len(prices))
if not prices:
    sys.exit()
m = prices[min(nth, len(prices) - 1)]
chunk = h[max(0, m.start() - width): m.end() + 400]
# keep tag names, class, href, data-* ; drop other attributes
def slim(t):
    tag = t.group(0)
    name = re.match(r'</?\s*([a-zA-Z0-9-]+)', tag)
    if not name:
        return ''
    keep = re.findall(r'\s(class|href|data-[a-z-]+|itemprop)="([^"]{0,90})"', tag)
    attrs = ''.join(f' {k}="{v}"' for k, v in keep)
    return f'<{"/" if tag.startswith("</") else ""}{name.group(1)}{attrs}>'
chunk = re.sub(r'<[^>]+>', slim, chunk)
chunk = re.sub(r'\s+', ' ', chunk)
print(chunk)
