# inter-bridge

Ponte entre o painel de boletos e a API do Banco Inter.

O Inter exige certificado digital (mTLS) em todas as chamadas. Esta ponte
roda no Render com o certificado configurado como variavel de ambiente e
expoe dois endpoints simples para o painel:

- `POST /emitir` — emite um boleto
- `GET /pagos?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD` — lista boletos pagos
- `GET /health` — verificacao de saude (sem autenticacao)

Todas as chamadas (exceto `/health`) exigem o header
`Authorization: Bearer <BRIDGE_TOKEN>`.

## Variaveis de ambiente (configurar no Render)

| Variavel | Descricao |
|---|---|
| `INTER_CLIENT_ID` | Client ID da aplicacao no Inter |
| `INTER_CLIENT_SECRET` | Client Secret da aplicacao |
| `INTER_CERT` | Conteudo do arquivo `.crt` em base64 |
| `INTER_KEY` | Conteudo do arquivo `.key` em base64 |
| `INTER_CONTA_CORRENTE` | Numero da conta corrente Inter |
| `BRIDGE_TOKEN` | Senha compartilhada com o painel |

## Deploy no Render

1. Suba estes arquivos em um repositorio no GitHub.
2. No Render: New → Web Service → conecte o repositorio.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Adicione as variaveis de ambiente acima em Environment.
6. Deploy.
