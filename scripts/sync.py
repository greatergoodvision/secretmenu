import os, re, json, hashlib, mimetypes
from datetime import datetime, timezone
from pathlib import Path
import requests

SOURCE_URL = os.environ.get("AIRTABLE_SOURCE_URL")
MARKUP = 50
OUT = Path("public")
IMG = OUT / "images"
OUT.mkdir(exist_ok=True)
IMG.mkdir(parents=True, exist_ok=True)

if not SOURCE_URL:
    raise SystemExit("Missing AIRTABLE_SOURCE_URL secret")

session = requests.Session()
ua = {"User-Agent": "Mozilla/5.0"}
html = session.get(SOURCE_URL, headers=ua, timeout=60)
html.raise_for_status()

m_url = re.search(r'urlWithParams:\s*"(.*?)"', html.text)
m_headers = re.search(r"var headers = ({.*?});", html.text, re.S)
if not m_url or not m_headers:
    raise SystemExit("Airtable shared-view bootstrap data not found")

fetch_path = bytes(m_url.group(1), "utf-8").decode("unicode_escape")
headers = json.loads(m_headers.group(1))
headers["x-time-zone"] = "UTC"
raw = session.get("https://airtable.com" + fetch_path, headers=headers, timeout=60)
raw.raise_for_status()
data = raw.json()

# Find the largest object that looks like an Airtable table payload.
def walk(x):
    if isinstance(x, dict):
        yield x
        for v in x.values():
            yield from walk(v)
    elif isinstance(x, list):
        for v in x:
            yield from walk(v)

candidates = []
for d in walk(data):
    cols = d.get("columns")
    rows = d.get("rows")
    if isinstance(cols, list) and isinstance(rows, list):
        candidates.append((len(rows), d))

if not candidates:
    raise SystemExit("Could not locate Airtable rows/columns in shared-view payload")

table = max(candidates, key=lambda x: x[0])[1]
columns = table.get("columns", [])
rows = table.get("rows", [])

# Column id/name map.
col_map = {}
for c in columns:
    if not isinstance(c, dict):
        continue
    cid = c.get("id") or c.get("columnId")
    name = c.get("name") or c.get("label") or c.get("title")
    if cid and name:
        col_map[cid] = str(name)

money_re = re.compile(r"\$\s*(\d[\d,]*(?:\.\d{1,2})?)")
def bump_money(text):
    def repl(m):
        original = m.group(1)
        amount = float(original.replace(",", "")) + MARKUP
        decimals = 2 if "." in original else 0
        return "$" + f"{amount:,.{decimals}f}"
    return money_re.sub(repl, str(text))

def simple_text(v):
    if v is None:
        return ""
    if isinstance(v, (str, int, float, bool)):
        return str(v)
    if isinstance(v, dict):
        for k in ("text", "name", "label", "displayValue"):
            if k in v and isinstance(v[k], (str, int, float)):
                return str(v[k])
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        parts = [simple_text(x) for x in v]
        return ", ".join([p for p in parts if p])
    return str(v)

def attachment_urls(v):
    found = []
    def rec(x):
        if isinstance(x, dict):
            u = x.get("url")
            if isinstance(u, str) and u.startswith("http"):
                found.append(u)
            for vv in x.values(): rec(vv)
        elif isinstance(x, list):
            for vv in x: rec(vv)
    rec(v)
    return found

def save_image(url, key):
    try:
        r = session.get(url, timeout=45)
        if not r.ok or not r.content:
            return None
        ct = r.headers.get("content-type", "").split(";")[0].strip()
        ext = mimetypes.guess_extension(ct) or ".jpg"
        if ext == ".jpe": ext = ".jpg"
        name = hashlib.sha1(key.encode()).hexdigest()[:18] + ext
        (IMG / name).write_bytes(r.content)
        return "images/" + name
    except Exception:
        return None

products = []
for idx, row in enumerate(rows):
    if not isinstance(row, dict):
        continue
    values = row.get("cellValuesByColumnId") or row.get("cellValues") or row.get("values") or {}
    if isinstance(values, list):
        # Sometimes values are list entries carrying a column id.
        tmp = {}
        for item in values:
            if isinstance(item, dict):
                cid = item.get("columnId") or item.get("id")
                if cid:
                    tmp[cid] = item.get("value", item.get("cellValue"))
        values = tmp
    if not isinstance(values, dict):
        continue

    fields = []
    title = None
    image = None
    for cid, raw_value in values.items():
        label = col_map.get(cid, str(cid))
        low = label.lower()
        # Never expose Airtable/source identifiers or internal-looking fields.
        if any(x in low for x in ["record id", "airtable", "source url", "supplier url", "internal"]):
            continue

        if image is None and any(x in low for x in ["photo", "image", "picture", "attachment"]):
            urls = attachment_urls(raw_value)
            if urls:
                image = save_image(urls[0], f"{idx}-{label}")

        value = simple_text(raw_value).strip()
        if not value:
            continue

        if "price" in low or money_re.search(value):
            value = bump_money(value)
            kind = "price"
        else:
            kind = "text"

        if title is None and not any(x in low for x in ["price", "quantity", "quality", "photo", "image", "picture", "attachment"]):
            title = value
            continue

        fields.append({"label": label, "value": value, "kind": kind})

    if title is None:
        title = f"Product {idx + 1}"
    products.append({"title": title, "image": image, "fields": fields})

payload = {
    "updatedAt": datetime.now(timezone.utc).isoformat(),
    "count": len(products),
    "products": products,
}
(OUT / "catalog.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
print(f"Synced {len(products)} products. All displayed dollar prices were increased by ${MARKUP}.")
