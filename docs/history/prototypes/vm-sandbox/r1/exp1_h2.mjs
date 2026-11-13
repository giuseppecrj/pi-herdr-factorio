// F05 R1 experiment 1: HTTP/2 probes where :authority and host differ.
// Every request is an unauthenticated GET, and no credentials are sent.
import http2 from "node:http2";
import crypto from "node:crypto";

const EDGE = "169.254.169.254";
const L = "llm.int.exe.xyz", G = "github.int.exe.xyz";
const PATHS = ["/openai/v1/models", "/xai/v1/models", "/zen"];

function classify(h, body) {
  if (h["x-github-request-id"] || String(h.server || "").toLowerCase().includes("github")) return "github";
  try {
    const j = JSON.parse(body);
    if (j && j.object === "list" && Array.isArray(j.data))
      return j.data.some((m) => String(m.id).includes("grok")) ? "llm-xai" : "llm-openai";
  } catch {}
  return "other";
}

function probe(name, path, sni, headers) {
  return new Promise((resolve) => {
    const rec = { name, path, sni, headers };
    const done = (extra) => { Object.assign(rec, extra); console.log(JSON.stringify(rec)); resolve(); };
    let client;
    try {
      client = http2.connect(`https://${EDGE}:443`, { servername: sni, ALPNProtocols: ["h2"] });
    } catch (e) { return done({ status: "ERR", error: String(e), backend: "none" }); }
    const t = setTimeout(() => { client.destroy(); done({ status: "ERR", error: "timeout", backend: "none" }); }, 15000);
    client.on("error", (e) => { clearTimeout(t); done({ status: "ERR", error: String(e).slice(0, 200), backend: "none" }); });
    client.on("connect", () => { rec.alpn = client.alpnProtocol; });
    let req;
    try {
      req = client.request({ ":method": "GET", ":path": path, "user-agent": "f05-r1-probe-h2", ...headers });
    } catch (e) { clearTimeout(t); client.close(); return done({ status: "ERR", error: String(e).slice(0, 200), backend: "none" }); }
    let resh = {};
    const chunks = [];
    req.on("response", (h) => { resh = h; });
    req.on("data", (c) => chunks.push(c));
    req.on("error", (e) => { clearTimeout(t); client.close(); done({ status: "ERR", error: String(e).slice(0, 200), backend: "none" }); });
    req.on("end", () => {
      clearTimeout(t); client.close();
      const body = Buffer.concat(chunks);
      const tr = resh["x-trace-id"];
      done({
        status: resh[":status"], server: resh.server,
        x_trace_id_count: tr === undefined ? 0 : Array.isArray(tr) ? tr.length : String(tr).split(",").length,
        ctype: resh["content-type"],
        header_names: Object.keys(resh).filter((k) => !k.startsWith(":")).sort(),
        body_len: body.length,
        body_sha256: crypto.createHash("sha256").update(body).digest("hex").slice(0, 16),
        snippet: body.subarray(0, 90).toString().replace(/\n/g, " "),
        backend: classify(resh, body.toString()),
      });
    });
    req.end();
  });
}

for (const P of PATHS) {
  await probe("h2:sni=L,:auth=L", P, L, { ":authority": L });
  await probe("h2:sni=L,:auth=G", P, L, { ":authority": G });
  await probe("h2:sni=G,:auth=L", P, G, { ":authority": L });
  await probe("h2:sni=L,:auth=L,host=G", P, L, { ":authority": L, host: G });
  await probe("h2:sni=L,:auth=G,host=L", P, L, { ":authority": G, host: L });
  await probe("h2:sni=G,:auth=G,host=L", P, G, { ":authority": G, host: L });
  await probe("h2:sni=G,:auth=L,host=G", P, G, { ":authority": L, host: G });
  await probe("h2:sni=L,:auth=L,x-forwarded-host=G", P, L, { ":authority": L, "x-forwarded-host": G });
  await probe("h2:sni=L,:auth=L,forwarded host=G", P, L, { ":authority": L, forwarded: `host=${G}` });
  await probe("h2:sni=L,:auth=G.(dot)", P, L, { ":authority": G + "." });
  await probe("h2:sni=L,:auth=GITHUB.INT.EXE.XYZ", P, L, { ":authority": G.toUpperCase() });
  await probe("h2:sni=L,:auth=G:443", P, L, { ":authority": G + ":443" });
}
