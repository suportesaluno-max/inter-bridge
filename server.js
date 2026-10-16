// Ponte Banco Inter (mTLS) — sem dependencias externas.
const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const HOST = "cdpj.partners.bancointer.com.br";

// Aceita o PEM em varias linhas, em uma linha com \n, com espacos no lugar das quebras, entre aspas ou em base64.
function normalizePem(raw, name) {
  let v = String(raw || "").trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n").replace(/\r/g, "");
  if (!v.includes("-----BEGIN")) {
    try { const d = Buffer.from(v.replace(/\s+/g, ""), "base64").toString("utf8"); if (d.includes("-----BEGIN")) v = d; } catch {}
  }
  const m = v.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) throw new Error(`${name} invalido: nao encontrei o bloco -----BEGIN ...----- (tamanho recebido: ${v.length})`);
  const body = m[2].replace(/\s+/g, "").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${m[1]}-----\n${body}\n-----END ${m[1]}-----\n`;
}

let agent, pemError = null;
try {
  agent = new https.Agent({ cert: normalizePem(process.env.INTER_CERT, "INTER_CERT"), key: normalizePem(process.env.INTER_KEY, "INTER_KEY"), keepAlive: true });
} catch (e) { pemError = e.message; console.error(pemError); }

const conta = () => String(process.env.INTER_CONTA_CORRENTE || "").replace(/\D/g, "");

function interReq(method, path, { body, form, token } = {}) {
  return new Promise((resolve, reject) => {
    if (pemError) return reject(Object.assign(new Error(pemError), { status: 500 }));
    const data = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : null;
    const headers = { Accept: "application/json" };
    if (data) { headers["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
    if (token) { headers.Authorization = `Bearer ${token}`; if (conta()) headers["x-conta-corrente"] = conta(); }
    const req = https.request({ host: HOST, path, method, agent, headers, timeout: 45000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let j; try { j = buf ? JSON.parse(buf) : {}; } catch { j = { raw: buf }; } resolve({ status: res.statusCode, json: j }); });
    });
    req.on("timeout", () => req.destroy(new Error("timeout Inter")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

let cached = { token: null, exp: 0 };
async function getToken() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const r = await interReq("POST", "/oauth/v2/token", { form: {
    client_id: process.env.INTER_CLIENT_ID, client_secret: process.env.INTER_CLIENT_SECRET,
    grant_type: "client_credentials", scope: "boleto-cobranca.read boleto-cobranca.write" } });
  if (r.status !== 200 || !r.json.access_token) throw Object.assign(new Error("Falha ao autenticar no Inter"), { status: r.status, detalhe: r.json });
  cached = { token: r.json.access_token, exp: Date.now() + (r.json.expires_in - 60) * 1000 };
  return cached.token;
}

const send = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true, service: "inter-bridge", certificado: pemError ? pemError : "ok" });
    if (req.headers.authorization !== `Bearer ${process.env.BRIDGE_TOKEN}`) return send(res, 401, { error: "Token da ponte invalido" });
    const token = await getToken();

    if (req.method === "POST" && url.pathname === "/emitir") {
      const b = await readBody(req); const p = b.pagador || {};
      const doc = String(p.cpfCnpj || "").replace(/\D/g, "");
      const r = await interReq("POST", "/cobranca/v3/cobrancas", { token, body: {
        seuNumero: String(b.seuNumero).slice(0, 15), valorNominal: Number(b.valorNominal), dataVencimento: b.dataVencimento, numDiasAgenda: 60,
        pagador: { cpfCnpj: doc, tipoPessoa: doc.length > 11 ? "JURIDICA" : "FISICA", nome: String(p.nome || "").slice(0, 100),
          endereco: String(p.endereco || "").slice(0, 100), cidade: String(p.cidade || "").slice(0, 60), uf: String(p.uf || "").toUpperCase(),
          cep: String(p.cep || "").replace(/\D/g, ""), email: p.email || undefined },
        mensagem: p.mensagem ? { linha1: String(p.mensagem).slice(0, 78) } : undefined } });
      if (r.status >= 300 || !r.json.codigoSolicitacao) return send(res, r.status >= 300 ? r.status : 502, { error: "Inter recusou a emissao", detalhe: r.json });
      return send(res, 200, { ok: true, codigoSolicitacao: r.json.codigoSolicitacao });
    }
    const mC = url.pathname.match(/^\/cobranca\/([\w-]+)$/);
    if (req.method === "GET" && mC) {
      const r = await interReq("GET", `/cobranca/v3/cobrancas/${mC[1]}`, { token });
      if (r.status >= 300) return send(res, r.status, { error: "Erro ao consultar", detalhe: r.json });
      return send(res, 200, { linhaDigitavel: r.json.boleto?.linhaDigitavel ?? null, situacao: r.json.cobranca?.situacao ?? null, pix: r.json.pix?.pixCopiaECola ?? null });
    }
    const mP = url.pathname.match(/^\/pdf\/([\w-]+)$/);
    if (req.method === "GET" && mP) {
      const r = await interReq("GET", `/cobranca/v3/cobrancas/${mP[1]}/pdf`, { token });
      if (r.status >= 300 || !r.json.pdf) return send(res, r.status >= 300 ? r.status : 502, { error: "PDF indisponivel", detalhe: r.json });
      res.writeHead(200, { "Content-Type": "application/pdf" }); return res.end(Buffer.from(r.json.pdf, "base64"));
    }
    if (req.method === "GET" && url.pathname === "/pagos") {
      const out = []; let pagina = 0, total = 1;
      while (pagina < total && pagina < 50) {
        const q = new URLSearchParams({ dataInicial: url.searchParams.get("dataInicio"), dataFinal: url.searchParams.get("dataFim"),
          filtrarDataPor: "PAGAMENTO", situacao: "RECEBIDO", "paginacao.itensPorPagina": "1000", "paginacao.paginaAtual": String(pagina) });
        const r = await interReq("GET", `/cobranca/v3/cobrancas?${q}`, { token });
        if (r.status >= 300) return send(res, r.status, { error: "Erro ao listar pagos", detalhe: r.json });
        for (const it of r.json.cobrancas || []) { const c = it.cobranca || it;
          out.push({ codigoSolicitacao: c.codigoSolicitacao, seuNumero: c.seuNumero, dataPagamentoBaixa: c.dataSituacao || null }); }
        total = r.json.totalPaginas || 1; pagina++;
      }
      return send(res, 200, { cobrancas: out });
    }
    send(res, 404, { error: "Rota nao encontrada" });
  } catch (e) { send(res, e.status || 500, { error: e.message, detalhe: e.detalhe }); }
}).listen(PORT, () => console.log("inter-bridge na porta", PORT));
