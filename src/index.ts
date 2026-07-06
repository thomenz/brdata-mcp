#!/usr/bin/env node
/**
 * brdata-mcp — an MCP (Model Context Protocol) stdio server that exposes the
 * brdata Brazilian company & document tools to agent harnesses (Claude Code,
 * Claude Desktop, …). Paid tools automatically settle the x402 HTTP endpoints
 * using the wallet(s) configured via EVM_PRIVATE_KEY and/or SOLANA_PRIVATE_KEY.
 *
 * The brdata service accepts payment on BOTH Base and Solana (USDC). This client
 * registers whichever rails you give it a key for; the x402 layer picks the one
 * the server's 402 challenge advertises (if you configure both, it settles on
 * whichever the server lists — no manual selection needed).
 *
 * Environment:
 *   BRDATA_BASE_URL    base URL of a running brdata Worker (default https://brdata.thomenz.me)
 *   EVM_PRIVATE_KEY    0x-prefixed key of the paying Base wallet (holds USDC)
 *   SOLANA_PRIVATE_KEY base58 or JSON-array secret key of the paying Solana wallet (holds USDC)
 *   X402_NETWORK       "base" (mainnet, default) or "base-sepolia" (testnet → Solana devnet)
 *   SOLANA_RPC_URL     optional RPC override used to build the Solana payment (e.g. a Helius URL)
 *
 * SECURITY: these keys control real funds. Use DEDICATED wallets with small
 * balances — never a personal/treasury key. Anything that can read this
 * process' environment can spend from them.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Encoder,
} from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const BASE = (process.env.BRDATA_BASE_URL ?? "https://brdata.thomenz.me").replace(/\/+$/, "");
const TESTNET = process.env.X402_NETWORK === "base-sepolia";

// CAIP-2 network ids (Solana ids are the first 32 chars of each cluster's genesis hash).
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BASE_MAINNET = "eip155:8453";
const BASE_SEPOLIA = "eip155:84532";

async function loadSolanaSigner(raw: string) {
  const pk = raw.trim();
  const bytes = pk.startsWith("[")
    ? Uint8Array.from(JSON.parse(pk) as number[])
    : new Uint8Array(getBase58Encoder().encode(pk));
  if (bytes.length === 64) return createKeyPairSignerFromBytes(bytes);
  if (bytes.length === 32) return createKeyPairSignerFromPrivateKeyBytes(bytes);
  throw new Error(`SOLANA_PRIVATE_KEY has unexpected length ${bytes.length} (want 32 or 64 bytes)`);
}

// Build a payment-aware fetch registering every rail we have a key for. Free
// tools still work with plain fetch; paid tools surface the 402 as a tool error
// when no matching wallet is configured.
let payFetch: typeof fetch = fetch;
const rails: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schemes: Array<{ network: any; client: any }> = [];

const solPk = process.env.SOLANA_PRIVATE_KEY;
if (solPk) {
  try {
    const signer = await loadSolanaSigner(solPk);
    const config = process.env.SOLANA_RPC_URL ? { rpcUrl: process.env.SOLANA_RPC_URL } : undefined;
    schemes.push({ network: TESTNET ? SOLANA_DEVNET : SOLANA_MAINNET, client: new ExactSvmScheme(signer, config) });
    rails.push(`solana(${signer.address})`);
  } catch (err) {
    console.error(`[brdata-mcp] SOLANA_PRIVATE_KEY invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const evmPk = process.env.EVM_PRIVATE_KEY;
if (evmPk) {
  try {
    const account = privateKeyToAccount(evmPk as `0x${string}`);
    schemes.push({ network: TESTNET ? BASE_SEPOLIA : BASE_MAINNET, client: new ExactEvmScheme(account) });
    rails.push(`base(${account.address})`);
  } catch (err) {
    console.error(`[brdata-mcp] EVM_PRIVATE_KEY invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (schemes.length > 0) {
  payFetch = wrapFetchWithPaymentFromConfig(fetch, { schemes }) as typeof fetch;
} else {
  console.error(
    "[brdata-mcp] No EVM_PRIVATE_KEY or SOLANA_PRIVATE_KEY set — paid tools will fail on HTTP 402. The free validate_cnpj tool still works.",
  );
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function call(method: string, path: string, body?: unknown): Promise<ToolResult> {
  try {
    const res = await payFetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      isError: !res.ok,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

const server = new McpServer(
  { name: "brdata-mcp", version: "0.3.2" },
  {
    instructions:
      "brdata exposes paid tools over Brazilian public company & government data, " +
      "settling x402 micropayments (USDC on Base or Solana) automatically per call — a call is " +
      "charged only on success; invalid input is rejected for free. Coverage:\n" +
      "1) Company registry by CNPJ — `lookup_company` (basic: legal name, status, CNAE " +
      "activities, address) and `lookup_company_full` (due diligence: + partners, sanctions).\n" +
      "2) Regulatory risk & compliance — `screen_company_risk`: federal debarment (CEIS), " +
      "anti-corruption (CNEP), leniency and the forced-labor register ('Lista Suja', MTE) → verdict " +
      "+ 0–100 risk score, each hit flagged active vs historical. The Brazilian complement global " +
      "OFAC/EU/UK/UN + PEP screens miss (a company barred or listed for slave-like labor by the " +
      "Brazilian government comes back clean on those).\n" +
      "3) Company search & discovery across ~28M active companies — `search_companies` by " +
      "filters (CNAE activity code, state/city, company size, MEI, name), cursor-paginated. " +
      "Use this to BUILD LISTS/prospect; use lookup_* when you already have a CNPJ.\n" +
      "4) Public procurement / tenders (licitações) via PNCP — `decode_tender_id` (parse a " +
      "17-digit Compras.gov.br id), `resolve_tender` (any reference → PNCP coordinates), " +
      "`get_tender` (header), `get_tender_items` (line items/lots), `get_tender_documents` " +
      "(edital file URIs), `search_tenders` (keyword search of open biddings).\n" +
      "5) Fiscal documents — `decode_nfe_key` (44-digit NF-e access key) and `decode_boleto` " +
      "(bank slip digitable line: amount, due date, bank).\n" +
      "6) `lookup_cep` (Brazilian postal code → address) and `validate_documents` (batch " +
      "check CPF/CNPJ/PIS/license plate/PIX key). `validate_cnpj` is a free check-digit test.\n" +
      "Data is public-registry only (LGPD: no CPF exposure; MEI contact fields are always " +
      "redacted). Ideal for KYB, due diligence, compliance, and public-sector (B2G) sales " +
      "intelligence in Brazil.",
  },
);

const CNPJ_ARG = { cnpj: z.string().describe("Brazilian company tax ID (CNPJ), 14 digits, with or without punctuation.") };

server.registerTool(
  "lookup_company",
  {
    title: "Lookup Brazilian company (basic)",
    description:
      "Consolidated official registry profile of a Brazilian company by CNPJ: legal name, status, activities (CNAE), address, incorporation date. Paid ($0.01).",
    inputSchema: CNPJ_ARG,
  },
  ({ cnpj }) => call("GET", `/company/${encodeURIComponent(cnpj)}`),
);

server.registerTool(
  "lookup_company_full",
  {
    title: "Lookup Brazilian company (full due diligence)",
    description:
      "Full profile: everything in lookup_company plus partners/shareholders (QSA) and government sanction checks (CEIS/CNEP). Paid ($0.10).",
    inputSchema: CNPJ_ARG,
  },
  ({ cnpj }) => call("GET", `/company/${encodeURIComponent(cnpj)}/full`),
);

server.registerTool(
  "screen_company_risk",
  {
    title: "Brazilian regulatory risk & compliance screen",
    description:
      "Screen a Brazilian company by CNPJ against the federal debarment (CEIS), anti-corruption (CNEP), leniency-agreement and forced-labor ('Lista Suja' — MTE Cadastro de Empregadores) registries. Returns a single verdict (clear/flagged) + 0–100 risk score, each hit flagged active vs historical. The Brazilian complement that global OFAC/EU/UK/UN + PEP screens miss — a company barred or listed for slave-like labor by the Brazilian government comes back clean on those. Company-level public data; no CPF (LGPD). Paid ($0.03).",
    inputSchema: CNPJ_ARG,
  },
  ({ cnpj }) => call("GET", `/risk/company/${encodeURIComponent(cnpj)}`),
);

server.registerTool(
  "decode_nfe_key",
  {
    title: "Decode NF-e access key",
    description:
      "Decode a 44-digit Brazilian electronic invoice (NF-e/NFC-e) access key: issuer CNPJ, state, emission date, invoice number, model. Paid ($0.005).",
    inputSchema: { access_key: z.string().describe("44-digit NF-e access key.") },
  },
  ({ access_key }) => call("GET", `/nfe/${encodeURIComponent(access_key)}`),
);

server.registerTool(
  "decode_boleto",
  {
    title: "Decode boleto digitable line",
    description:
      "Decode a Brazilian boleto linha digitável (47 or 48 digits): bank, amount, due date, validity. Paid ($0.005).",
    inputSchema: { digitable_line: z.string().describe("Boleto digitable line (47 or 48 digits).") },
  },
  ({ digitable_line }) => call("POST", "/boleto/decode", { digitable_line }),
);

server.registerTool(
  "validate_documents",
  {
    title: "Batch-validate Brazilian identifiers",
    description:
      "Validate up to 100 Brazilian identifiers: CPF, CNPJ (incl. alphanumeric), PIS, license plates, Pix keys. Paid ($0.002).",
    inputSchema: {
      documents: z
        .array(
          z.object({
            type: z.enum(["cpf", "cnpj", "pis", "license_plate", "pix_key"]),
            value: z.string(),
          }),
        )
        .min(1)
        .max(100)
        .describe("Documents to validate (max 100)."),
    },
  },
  ({ documents }) => call("POST", "/validate/batch", { documents }),
);

server.registerTool(
  "lookup_cep",
  {
    title: "Lookup Brazilian postal code (CEP)",
    description:
      "Enriched CEP lookup: full address, IBGE city code, coordinates when available. Paid ($0.005).",
    inputSchema: { cep: z.string().describe("8-digit Brazilian postal code (CEP).") },
  },
  ({ cep }) => call("GET", `/cep/${encodeURIComponent(cep)}`),
);

server.registerTool(
  "search_companies",
  {
    title: "Search & segment active Brazilian companies",
    description:
      "Search active Brazilian companies by industry (CNAE prefix, main activity), location " +
      "(state/city), size, age (registration date) and legal-name substring. Returns official " +
      "registry data with business contact info (MEI contacts are redacted under LGPD). Cursor " +
      "paginated. Paid per page ($0.05). At least one filter is required.",
    inputSchema: {
      cnae: z.array(z.string()).optional().describe("CNAE prefixes (4-7 digits), matched on the MAIN activity."),
      state: z.string().length(2).optional().describe("State (UF), e.g. \"MS\"."),
      city: z.string().optional().describe("City name (accent/case-insensitive) or a TOM/IBGE code."),
      company_size: z.array(z.enum(["ME", "EPP", "DEMAIS"])).optional(),
      opened_before: z.string().optional().describe("registration_date <= YYYY-MM-DD."),
      opened_after: z.string().optional().describe("registration_date >= YYYY-MM-DD."),
      is_mei: z.boolean().nullable().optional(),
      name_contains: z.string().min(2).optional(),
      has_email: z.boolean().nullable().optional(),
      has_phone: z.boolean().nullable().optional(),
      page_size: z.number().int().min(1).max(50).optional().describe("Default 25, max 50."),
      cursor: z.string().optional().describe("Pass the previous response's next_cursor."),
    },
  },
  (args) => {
    const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    return call("POST", "/companies/search", body);
  },
);

const TENDER_COORDS = {
  cnpj: z.string().describe("Buyer agency CNPJ (14 digits)."),
  year: z.number().int().min(2021).describe("Tender year (>= 2021)."),
  seq: z.number().int().min(1).describe("PNCP sequential (NOT the Compras.gov.br number)."),
};

server.registerTool(
  "decode_tender_id",
  {
    title: "Decode a Compras.gov.br tender id (offline)",
    description:
      "Offline decode of a Compras.gov.br 17-digit tender id (UASG + modality + number + year), with the modality name in English. Paid ($0.005).",
    inputSchema: { id: z.string().describe("17-digit Compras.gov.br id.") },
  },
  ({ id }) => call("GET", `/tender/decode/${encodeURIComponent(id)}`),
);

server.registerTool(
  "resolve_tender",
  {
    title: "Resolve a Brazilian tender reference to PNCP",
    description:
      "Resolve any Brazilian public tender reference (Compras.gov.br 17-digit id or URL, PNCP URL, or control number) into canonical PNCP coordinates + a summary (object, modality, estimated value, dates). Paid ($0.02).",
    inputSchema: {
      reference: z
        .string()
        .describe("A 17-digit id, a Compras.gov.br/PNCP URL, or a PNCP control number (CNPJ-1-SEQ/ANO)."),
    },
  },
  ({ reference }) => call("POST", "/tender/resolve", { reference }),
);

server.registerTool(
  "get_tender",
  {
    title: "Get a Brazilian tender header (PNCP)",
    description:
      "Full header of a Brazilian public tender by PNCP coordinates: object, modality, status, estimated value, opening/closing dates, buyer, price-registration flag. Paid ($0.01).",
    inputSchema: TENDER_COORDS,
  },
  ({ cnpj, year, seq }) => call("GET", `/tender/${encodeURIComponent(cnpj)}/${year}/${seq}`),
);

server.registerTool(
  "get_tender_items",
  {
    title: "Get all items of a Brazilian tender (PNCP)",
    description:
      "All items of a Brazilian public tender: quantities, maximum accepted prices, units, and SME-exclusive (ME/EPP) flags. Essential for bid/no-bid analysis. Paid ($0.03).",
    inputSchema: TENDER_COORDS,
  },
  ({ cnpj, year, seq }) => call("GET", `/tender/${encodeURIComponent(cnpj)}/${year}/${seq}/items`),
);

server.registerTool(
  "get_tender_documents",
  {
    title: "List documents of a Brazilian tender (PNCP)",
    description:
      "Document list (download URIs) of a Brazilian public tender. ZIPs usually contain the full edital PDF and item list. Metadata only — files are not fetched. Paid ($0.01).",
    inputSchema: TENDER_COORDS,
  },
  ({ cnpj, year, seq }) => call("GET", `/tender/${encodeURIComponent(cnpj)}/${year}/${seq}/documents`),
);

server.registerTool(
  "search_tenders",
  {
    title: "Search Brazilian public tenders (PNCP)",
    description:
      "Search Brazilian public procurement tenders (PNCP) by keyword. Returns normalized references (CNPJ/year/sequential, control number, PNCP URL) ready for detail lookups. Paid ($0.05).",
    inputSchema: {
      query: z.string().min(3).describe("Keyword(s), min 3 chars."),
      page: z.number().int().min(1).optional().describe("Page (default 1)."),
    },
  },
  ({ query, page }) => call("POST", "/tender/search", { query, ...(page ? { page } : {}) }),
);

server.registerTool(
  "validate_cnpj",
  {
    title: "Validate a CNPJ (free)",
    description:
      "Free local check-digit/format validation of a single CNPJ (numeric or alphanumeric). No payment required.",
    inputSchema: CNPJ_ARG,
  },
  ({ cnpj }) => call("GET", `/validate/${encodeURIComponent(cnpj)}`),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[brdata-mcp] ready. base=${BASE} network=${TESTNET ? "testnet" : "mainnet"} rails=[${rails.join(", ") || "none (free tools only)"}]`,
);
