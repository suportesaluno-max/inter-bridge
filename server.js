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
const INTER_HOST = "cdpj.partners.bancointer.com.br";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel de ambiente ausente: ${name}`);
  return value;
}

// Chamada HTTPS ao Inter com o certificado do cliente (mTLS).
// Usa https.request diretamente: o fetch nativo do Node ignora
// a opcao "agent" e nao apresentaria o certificado.
function interRequest(path, { method = "GET", body, token, formEncoded } = {}) {
  return new Promise((resolve, reject) => {
    const data = body
      ? formEncoded
        ? new URLSearchParams(body).toString()
        : JSON.stringify(body)
      : null;
    const req = https.request(
      {
        hostname: INTER_HOST,
        path,
        method,
        cert: Buffer.from(requireEnv("INTER_CERT"), "base64").toString("utf8"),
        key: Buffer.from(requireEnv("INTER_KEY"), "base64").toString("utf8"),
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": formEncoded ? "application/x-www-form-urlencoded" : "application/json",
          "x-inter-conta-corrente": requireEnv("INTER_CONTA_CORRENTE"),
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json });
        });
      }
    );
    req.setTimeout(30000, () => req.destroy(new Error("Timeout na chamada ao Inter")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Token OAuth do Inter (cache de 50 minutos)
let cachedToken = null;
let tokenExpiresAt = 0;

async function getInterToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const resultado = await interRequest("/oauth/v2/token", {
    method: "POST",
    formEncoded: true,
    body: {
      client_id: requireEnv("INTER_CLIENT_ID"),
      client_secret: requireEnv("INTER_CLIENT_SECRET"),
      grant_type: "client_credentials",
      scope: "boleto-cobranca.write boleto-cobranca.read",
    },
  });

  if (!resultado.ok) {
    throw new Error(`Falha ao autenticar no Inter [${resultado.status}]: ${JSON.stringify(resultado.json)}`);
  }

  cachedToken = resultado.json.access_token;
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

// Testa a autenticacao com o Inter sem emitir nada
app.get("/testar-auth", async (_req, res) => {
  try {
    await getInterToken();
    res.json({ ok: true, mensagem: "Autenticacao com o Inter funcionando" });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

// Emitir boleto
// Body: { seuNumero, valorNominal, dataVencimento (YYYY-MM-DD),
//         pagador: { nome, cpfCnpj, email, endereco, cidade, uf, cep, mensagem } }
app.post("/emitir", async (req, res) => {
  try {
    const { seuNumero, valorNominal, dataVencimento, pagador } = req.body || {};

    if (!seuNumero || !valorNominal || !dataVencimento || !pagador?.cpfCnpj || !pagador?.nome) {
      return res.status(400).json({
        error: "Campos obrigatorios: seuNumero, valorNominal, dataVencimento, pagador.nome, pagador.cpfCnpj",
      });
    }

    const token = await getInterToken();
    const resultado = await interRequest("/cobranca/v3/cobrancas", {
      method: "POST",
      token,
      body: {
        seuNumero: String(seuNumero).slice(0, 15),
        valorNominal: Number(valorNominal),
        dataVencimento,
        numDiasAgenda: 60,
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
    const resultado = await interRequest(path, { token });

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
