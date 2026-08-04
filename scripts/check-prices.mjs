#!/usr/bin/env node
/**
 * Confere a tabela PRICES deste pacote contra o `/.well-known/x402` VIVO.
 *
 * 🔴 POR QUE EXISTE: o preço mora DENTRO da descrição de cada tool, que é o texto que o
 * agente lê para decidir se vale chamar. Em 2026-08-04 o Worker repreçou 6 rotas e este
 * pacote seguiu publicado no npm anunciando os valores velhos — o agente decidia por um
 * número e o 402 cobrava outro. Nenhum build pega isso: são dois repositórios separados,
 * o MCP não importa o `catalog.ts`, e os dois compilam felizes divergindo.
 *
 * Rode ANTES de publicar:  npm run check-prices
 * Sai com código 1 se qualquer preço divergir, faltar rota ou o manifesto não responder.
 */
import { PRICES, PRICE_ROUTES } from "../dist/index.js";

const BASE = (process.env.BRDATA_BASE_URL ?? "https://brdata.thomenz.me").replace(/\/+$/, "");
const url = `${BASE}/.well-known/x402?cachebust=${process.pid}`;

const res = await fetch(url);
if (!res.ok) {
  console.error(`✖ ${url} respondeu ${res.status} — não dá para verificar preço nenhum.`);
  process.exit(1);
}
const manifest = await res.json();

/** path do manifesto -> preço, já normalizado para a forma `{param}` do PRICE_ROUTES. */
const live = new Map(
  (manifest.resources ?? []).map((r) => [String(r.path).replace(/:(\w+)/g, "{$1}"), r.price]),
);

let bad = 0;
for (const [key, path] of Object.entries(PRICE_ROUTES)) {
  const mine = PRICES[key];
  const theirs = live.get(path);
  if (theirs === undefined) {
    console.error(`✖ ${key.padEnd(15)} ${path} — não existe no manifesto vivo`);
    bad++;
  } else if (theirs !== mine) {
    console.error(`✖ ${key.padEnd(15)} ${path} — MCP diz ${mine}, o 402 cobra ${theirs}`);
    bad++;
  } else {
    console.log(`✓ ${key.padEnd(15)} ${mine}`);
  }
}

// O inverso também importa: rota paga nova no Worker que o MCP não expõe é receita que
// simplesmente não é oferecida a nenhum agente.
const mapped = new Set(Object.values(PRICE_ROUTES));
for (const [path, price] of live) {
  if (!mapped.has(path)) {
    console.error(`⚠ ${path} (${price}) existe no Worker e NÃO tem tool neste MCP`);
    bad++;
  }
}

if (bad) {
  console.error(`\n${bad} divergência(s). Corrija PRICES/PRICE_ROUTES em src/index.ts antes de publicar.`);
  process.exit(1);
}
console.log(`\nTodos os ${Object.keys(PRICES).length} preços batem com ${BASE}.`);
