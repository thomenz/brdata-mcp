# brdata-mcp

An **MCP (Model Context Protocol) server** for **Brazilian company & public-procurement
data**, for agent harnesses (Claude Code, Claude Desktop, …). It covers: CNPJ company
registry lookup (basic + full due-diligence), **company search/discovery** across ~28M
active companies by filters (CNAE activity, state/city, size, MEI, name), **public tenders
/ licitações via PNCP** (decode Compras.gov.br IDs, resolve, header, line items, edital
documents, keyword search), NF-e & boleto decoding, CEP lookup, and batch document
validation — for KYB, due diligence, and B2G (public-sector) sales intelligence.

Paid tools **automatically settle** the underlying x402-protected HTTP endpoints in **USDC
on Base or Solana** using a wallet you configure; a call is charged only on success. Configure a
Base wallet (`EVM_PRIVATE_KEY`), a Solana wallet (`SOLANA_PRIVATE_KEY`), or both — the x402 layer
settles on whichever rail the server's 402 challenge advertises.

## Tools

| Tool | Endpoint | Price | Description |
|------|----------|-------|-------------|
| `lookup_company` | `GET /company/{cnpj}` | $0.01 | Consolidated registry profile |
| `lookup_company_full` | `GET /company/{cnpj}/full` | $0.10 | + partners (QSA) + sanctions |
| `screen_company_risk` | `GET /risk/company/{cnpj}` | $0.03 | Regulatory risk & compliance screen across 5 federal registries: debarment (CEIS), anti-corruption (CNEP), impeded non-profits (CEPIM), leniency & forced-labor register ("Lista Suja", MTE) → verdict + 0–100 score + per-source `data_as_of` |
| `decode_nfe_key` | `GET /nfe/{key}` | $0.005 | NF-e/NFC-e 44-digit access-key decoder |
| `decode_boleto` | `POST /boleto/decode` | $0.005 | Boleto digitable-line decoder |
| `validate_documents` | `POST /validate/batch` | $0.002 | Batch validate CPF/CNPJ/PIS/plate/Pix (≤100) |
| `lookup_cep` | `GET /cep/{cep}` | $0.005 | Enriched postal-code lookup |
| `search_companies` | `POST /companies/search` | $0.05/page | Search & segment active companies by CNAE/location/size/age/name |
| `decode_tender_id` | `GET /tender/decode/{id}` | $0.005 | Offline decode of a Compras.gov.br 17-digit tender id |
| `resolve_tender` | `POST /tender/resolve` | $0.02 | Resolve any tender reference (id/URL/control number) to PNCP + summary |
| `get_tender` | `GET /tender/{cnpj}/{year}/{seq}` | $0.01 | Full tender header (PNCP) |
| `get_tender_items` | `GET /tender/{cnpj}/{year}/{seq}/items` | $0.03 | All tender items + ME/EPP-exclusive flags |
| `get_tender_documents` | `GET /tender/{cnpj}/{year}/{seq}/documents` | $0.01 | Tender document URIs (no PDF download) |
| `search_tenders` | `POST /tender/search` | $0.05 | Search public tenders (PNCP) by keyword |
| `validate_cnpj` | `GET /validate/{cnpj}` | **free** | Single CNPJ check-digit validation |

`search_companies` requires the Worker to have the Phase 2 database configured (Hyperdrive);
otherwise it returns a 503 (and no payment is charged). MEI contact data is redacted (LGPD).

## Configuration

Environment variables:

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `BRDATA_BASE_URL` | no | `https://brdata.thomenz.me` | Base URL of a brdata Worker (defaults to the hosted production API) |
| `EVM_PRIVATE_KEY` | for paid tools (Base) | — | `0x`-prefixed key of the paying Base wallet (holds USDC) |
| `SOLANA_PRIVATE_KEY` | for paid tools (Solana) | — | base58 or JSON-array secret key of the paying Solana wallet (holds USDC). Configure this and/or `EVM_PRIVATE_KEY` |
| `SOLANA_RPC_URL` | no | public RPC | Optional Solana RPC override used to build the payment (e.g. a Helius URL) |
| `X402_NETWORK` | no | `base` | `base` (mainnet, matches the default URL) or `base-sepolia` (testnet → Solana devnet) |

## ⚠️ Security

`EVM_PRIVATE_KEY` controls **real funds**. Anything that can read this process'
environment (or the MCP config file) can spend from that wallet.

- Use a **dedicated wallet with a small balance**, funded only with what you're
  willing to auto-spend. Never a personal or treasury key.
- On testnet (`base-sepolia`) use test USDC only.
- The key is read from the environment; it is never sent anywhere except to sign
  x402 payment authorizations for `BRDATA_BASE_URL`.

## Use with Claude Code / Claude Desktop

Add to your `mcpServers` configuration:

```json
{
  "mcpServers": {
    "brdata": {
      "command": "npx",
      "args": ["-y", "brdata-mcp"],
      "env": {
        "EVM_PRIVATE_KEY": "0x<dedicated-wallet-key-with-USDC>"
      }
    }
  }
}
```

For local development against `wrangler dev`, point `BRDATA_BASE_URL` at
`http://localhost:8787` and use `X402_NETWORK=base-sepolia` with a testnet wallet.

If you run from source instead of npm, use:

```json
{
  "mcpServers": {
    "brdata": {
      "command": "node",
      "args": ["/absolute/path/to/packages/brdata-mcp/dist/index.js"],
      "env": { "BRDATA_BASE_URL": "http://localhost:8787", "EVM_PRIVATE_KEY": "0x...", "X402_NETWORK": "base-sepolia" }
    }
  }
}
```

## Example

> "Use brdata to run full due diligence on CNPJ 00.000.000/0001-91."

The agent calls `lookup_company_full`, which pays $0.10 in USDC and returns the
consolidated English profile with partners and sanction checks.

## Build & publish

```bash
pnpm install
pnpm run build        # emits dist/
pnpm run typecheck
# publish (see checklist in the main repo README before doing this):
npm publish --access public
```

## License

MIT
