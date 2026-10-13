import express from "express";
import https from "node:https";

// ============================================================
// Ponte Painel de Boletos <-> Banco Inter
//
// O Banco Inter exige autenticacao mTLS (certificado digital da
// aplicacao). O servidor do painel nao consegue apresentar o
// certificado, entao esta ponte roda no Render com o certificado
// configurado como variavel de ambiente.
//
// Variaveis de ambiente obrigatorias (configurar no Render):
//   INTER_CLIENT_ID       - Client ID da aplicacao no Inter
//   INTER_CLIENT_SECRET   - Client Secret da aplicacao
//   INTER_CERT            - conteudo do arquivo .crt em base64
//   INTER_KEY             - conteudo do arquivo .key em base64
//   INTER_CONTA_CORRENTE  - numero da conta corrente Inter
//   BRIDGE_TOKEN          - senha compartilhada com o painel
// ============================================================

const PORT = process.env.PORT || 3000;
const INTER_BASE = "https://cdpj.partners.bancointer.com.br";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel de ambiente ausente: ${name}`);
  return value;
}

// Agente HTTPS com o certificado do Inter (mTLS)
function interAgent() {
  return new https.Agent({
    cert: Buffer.from(requireEnv("INTER_CERT"), "base64").toString("utf8"),
    key: Buffer.from(requireEnv("INTER_KEY"), "base64").toString("utf8"),
  });
}

// Chamada autenticada a API do Inter
async function interFetch(path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${INTER_BASE}${path}`, {
    method,
    agent: interAgent(),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-inter-conta-corrente": requireEnv("INTER_CONTA_CORRENTE"),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: response.status, ok: response.ok, json };
}

// Token OAuth do Inter (cache de 50 minutos)
let cachedToken = null;
let tokenExpiresAt = 0;

async function getInterToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const params = new URLSearchParams({
    client_id: requireEnv("INTER_CLIENT_ID"),
    client_secret: requireEnv("INTER_CLIENT_SECRET"),
    grant_type: "client_credentials",
    scope: "boleto-cobranca.write boleto-cobranca.read",
  });

  const response = await fetch(`${INTER_BASE}/oauth/v2/token`, {
    method: "POST",
    agent: interAgent(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Falha ao autenticar no Inter [${response.status}]: ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

// ---------- Servidor HTTP ----------

const app = express();
app.use(express.json({ limit: "1mb" }));

// Autenticacao da ponte: so o painel pode chamar
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${requireEnv("BRIDGE_TOKEN")}`) {
    return res.status(401).json({ error: "Token da ponte invalido" });
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "inter-bridge" });
});

// Emitir boleto
// Body: { seuNumero, valorNominal, dataVencimento (YYYY-MM-DD),
//         pagador: { nome, cpfCnpj, email, endereco, cidade, uf, cep } }
app.post("/emitir", async (req, res) => {
  try {
    const { seuNumero, valorNominal, dataVencimento, pagador } = req.body || {};

    if (!seuNumero || !valorNominal || !dataVencimento || !pagador?.cpfCnpj || !pagador?.nome) {
      return res.status(400).json({
        error: "Campos obrigatorios: seuNumero, valorNominal, dataVencimento, pagador.nome, pagador.cpfCnpj",
      });
    }

    const token = await getInterToken();
    const resultado = await interFetch("/cobranca/v3/cobrancas", {
      method: "POST",
      token,
      body: {
        seuNumero: String(seuNumero).slice(0, 15),
        valorNominal: Number(valorNominal),
        dataVencimento,
        numDiasAgenda: "SESSENTA",
        pagador: {
          tipoPessoa: String(pagador.cpfCnpj).replace(/\D/g, "").length > 11 ? "JURIDICA" : "FISICA",
          nome: String(pagador.nome).slice(0, 100),
          cpfCnpj: String(pagador.cpfCnpj).replace(/\D/g, ""),
          email: pagador.email || undefined,
          endereco: pagador.endereco || "Nao informado",
          cidade: pagador.cidade || "Sao Paulo",
          uf: pagador.uf || "SP",
          cep: String(pagador.cep || "01001000").replace(/\D/g, ""),
        },
        mensagem: pagador.mensagem ? { linha1: String(pagador.mensagem).slice(0, 78) } : undefined,
      },
    });

    if (!resultado.ok) {
      return res.status(resultado.status).json({
        error: "Inter recusou a emissao",
        detalhe: resultado.json,
      });
    }

    res.json({ ok: true, codigoSolicitacao: resultado.json.codigoSolicitacao });
  } catch (error) {
    console.error("Erro em /emitir:", error);
    res.status(500).json({ error: String(error.message || error) });
  }
});

// Consultar boletos pagos em um periodo
// Query: ?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD
app.get("/pagos", async (req, res) => {
  try {
    const { dataInicio, dataFim } = req.query;
    if (!dataInicio || !dataFim) {
      return res.status(400).json({ error: "Informe dataInicio e dataFim (YYYY-MM-DD)" });
    }

    const token = await getInterToken();
    const path =
      `/cobranca/v3/cobrancas?dataInicio=${dataInicio}&dataFim=${dataFim}` +
      `&filtrarDataPor=PAGAMENTO&situacao=PAGO&itensPorPagina=1000`;
    const resultado = await interFetch(path, { token });

    if (!resultado.ok) {
      return res.status(resultado.status).json({
        error: "Inter recusou a consulta",
        detalhe: resultado.json,
      });
    }

    res.json({ ok: true, cobrancas: resultado.json.cobrancas || [] });
  } catch (error) {
    console.error("Erro em /pagos:", error);
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`inter-bridge rodando na porta ${PORT}`);
});
