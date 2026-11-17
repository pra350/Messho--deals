import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const KEY = process.env.SERPAPI_KEY;
const BASE = process.env.RENDER_EXTERNAL_URL;
const app = express();
const dir = path.resolve("uploads");
fs.mkdirSync(dir, { recursive: true });
const upload = multer({ dest: dir, limits: { fileSize: 8 * 1024 * 1024 } });
app.use("/uploads", express.static(dir));
setInterval(() => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 600000) fs.unlinkSync(p);
  }
}, 60000);

async function serp(params) {
  const u = new URL("https://serpapi.com/search.json");
  Object.entries({ ...params, api_key: KEY }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error("SerpAPI " + r.status + ": " + (d.error || "failed"));
  return d;
}

const clean = (x) => ({
  title: x.title,
  shop: x.source || "",
  link: x.link || x.product_link,
  image: x.thumbnail,
  price: x.extracted_price ?? x.price?.extracted_value ?? null,
  priceText: typeof x.price === "string" ? x.price : x.price?.value
});

function rank(items) {
  const seen = new Set();
  const list = items
    .filter((i) => i.link && i.price && !seen.has(i.link) && seen.add(i.link))
    .map((i) => ({ ...i, meesho: /meesho/i.test(i.link + i.shop) }));
  const by = (a, b) => a.price - b.price;
  return [...list.filter((i) => i.meesho).sort(by), ...list.filter((i) => !i.meesho).sort(by)].slice(0, 40);
}

async function shopping(q) {
  const d = await serp({ engine: "google_shopping", q, gl: "in", hl: "en", google_domain: "google.co.in" });
  return (d.shopping_results || []).map(clean);
}

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Type a product name" });
    const all = [...(await shopping(q + " meesho")), ...(await shopping(q))];
    res.json({ query: q, results: rank(all) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/image", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No photo received" });
    if (!BASE) return res.status(500).json({ error: "Server address missing" });
    const name = crypto.randomUUID() + ".jpg";
    fs.renameSync(req.file.path, path.join(dir, name));
    const lens = await serp({ engine: "google_lens", url: BASE + "/uploads/" + name });
    const matches = (lens.visual_matches || []).map(clean);
    const title = (matches.find((m) => m.title) || {}).title || "";
    let all = matches;
    if (title) {
      try { all = [...matches, ...(await shopping(title + " meesho")), ...(await shopping(title))]; } catch (e) {}
    }
    res.json({ query: title, results: rank(all) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Meesho Deals</title>
<style>
body{font:16px system-ui,sans-serif;margin:0;background:#fdf5fa;color:#2a1628}
main{max-width:600px;margin:auto;padding:16px}
input,button{font:inherit;padding:11px;border-radius:10px;border:1px solid #ecd6ee}
button{background:#9c27b0;color:#fff;border:0;font-weight:600}
.row{display:flex;gap:8px;margin:8px 0}.row input{flex:1;min-width:0}
.card{display:flex;gap:10px;background:#fff;border:1px solid #ecd6ee;border-radius:12px;padding:10px;margin:8px 0;text-decoration:none;color:inherit}
.card img{width:72px;height:90px;object-fit:cover;border-radius:8px}
.p{font-weight:700;color:#1b8a4b;font-size:18px}.tag{background:#9c27b0;color:#fff;border-radius:6px;padding:1px 6px;font-size:12px}
</style></head><body><main>
<h1>Meesho Deals</h1>
<p>Upload a product photo or screenshot. Meesho results show first, cheapest first.</p>
<div class="row"><input id="f" type="file" accept="image/*" onchange="photo()"></div>
<div class="row"><input id="q" placeholder="Or type the product"><button onclick="txt()">Search</button></div>
<div id="out"></div></main>
<script>
function $(i){return document.getElementById(i)}
function show(p){
  $("out").textContent="Searching... this can take up to 30 seconds";
  p.then(function(r){return r.json()}).then(function(r){
    if(r.error)throw new Error(r.error);
    var h=r.query?"<p>Found: "+r.query+"</p>":"";
    if(!r.results.length)h+="<p>No priced results found. Try typing the product name.</p>";
    r.results.forEach(function(x){
      h+='<a class="card" href="'+x.link+'" target="_blank" rel="noopener"><img src="'+(x.image||"")+'" alt=""><div><div class="p">'+(x.priceText||x.price)+(x.meesho?' <span class="tag">Meesho</span>':'')+'</div><div>'+(x.title||"")+'</div><small>'+x.shop+'</small></div></a>';
    });
    $("out").innerHTML=h;
  }).catch(function(e){$("out").textContent="Error: "+e.message});
}
function txt(){show(fetch("/api/search?q="+encodeURIComponent($("q").value)))}
function photo(){var d=new FormData();d.append("photo",$("f").files[0]);show(fetch("/api/image",{method:"POST",body:d}))}
</script></body></html>`;
app.get("/", (req, res) => res.type("html").send(PAGE));
app.listen(process.env.PORT || 3000, () => console.log("running"));
