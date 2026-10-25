// Generates Halden Packaging's simulated systems (customer master, AR ledger,
// order book, collections notes) as weekly snapshots, into data/sources/*.json.
// Halden is fictional and these records are simulated; the customers'
// financials come from their real SEC filings, read live through Zetaris.
//
// The ledger is written so the week-1 decisions the policy calls for have a
// realistic aftermath in week 2 (AAP stretches its new headroom; Wayfair pays
// the 63-day invoice after the hold; DKS keeps paying on time).
//
//   npx tsx scripts/gen-ledger.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { WEEKS } from "../src/sources.ts";

const [W1, W2] = WEEKS;

// Seeded PRNG (mulberry32) so the ledger is reproducible.
let seed = 20261019;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const round = (n: number, to = 100) => Math.round(n / to) * to;

interface Cust { ticker: string; name: string; terms: number; limit: number; since: string; manager: string; late: [number, number]; monthly: number }
const CUST: Cust[] = [
  { ticker: "WMT", name: "Walmart Inc.", terms: 60, limit: 1_500_000, since: "2014", manager: "Dana Price", late: [0, 3], monthly: 520_000 },
  { ticker: "TGT", name: "Target Corporation", terms: 45, limit: 900_000, since: "2016", manager: "Dana Price", late: [0, 4], monthly: 360_000 },
  { ticker: "KSS", name: "Kohl's Corporation", terms: 45, limit: 400_000, since: "2018", manager: "Luis Ortega", late: [5, 13], monthly: 210_000 },
  { ticker: "AAP", name: "Advance Auto Parts, Inc.", terms: 30, limit: 250_000, since: "2021", manager: "Mei Chen", late: [0, 2], monthly: 225_000 },
  { ticker: "PTON", name: "Peloton Interactive, Inc.", terms: 30, limit: 150_000, since: "2022", manager: "Mei Chen", late: [0, 3], monthly: 60_000 },
  { ticker: "W", name: "Wayfair Inc.", terms: 30, limit: 600_000, since: "2019", manager: "Luis Ortega", late: [2, 9], monthly: 300_000 },
  { ticker: "BBWI", name: "Bath & Body Works, Inc.", terms: 45, limit: 350_000, since: "2020", manager: "Sam Patel", late: [0, 5], monthly: 170_000 },
  { ticker: "DKS", name: "Dick's Sporting Goods, Inc.", terms: 45, limit: 500_000, since: "2017", manager: "Sam Patel", late: [0, 3], monthly: 290_000 },
];

interface Inv { invoice_id: string; ticker: string; issue_date: string; due_date: string; amount_usd: number; paid_date: string; paid_usd: number; disputed: number }
const invoices: Inv[] = [];
let n = 10400;
const inv = (ticker: string, issue: string, terms: number, amount: number, paid: string | null, disputed = 0): Inv => {
  const i: Inv = { invoice_id: `INV-${n++}`, ticker, issue_date: issue, due_date: addDays(issue, terms), amount_usd: amount, paid_date: paid ?? "", paid_usd: paid ? amount : 0, disputed };
  invoices.push(i);
  return i;
};

// The open book at week 1 (issued but not yet due unless noted).
const open: Record<string, [string, number][]> = {
  WMT: [["2026-08-24", 260_000], ["2026-09-07", 255_000], ["2026-09-21", 270_000], ["2026-10-05", 265_000]], // ~1.05M of 1.5M
  TGT: [["2026-09-08", 180_000], ["2026-09-22", 175_000], ["2026-10-06", 185_000]],                          // 540k of 900k
  KSS: [["2026-09-07", 112_000], ["2026-09-21", 118_000], ["2026-10-05", 110_000]],                          // 340k of 400k
  AAP: [["2026-09-21", 112_000], ["2026-10-09", 118_000]],                                                    // 230k of 250k
  PTON: [["2026-09-28", 30_000], ["2026-10-12", 30_000]],                                                     // 60k of 150k
  BBWI: [["2026-09-08", 88_000], ["2026-09-22", 86_000], ["2026-10-06", 88_500]],                            // 262.5k of 350k
  DKS: [["2026-09-08", 145_000], ["2026-09-22", 150_000], ["2026-10-06", 145_000]],                          // 440k of 500k
};
// Paid history: two invoices a month from April, each paid `late` days after due.
// Invoices whose due date falls after week 1 stay open; the open book is then
// topped up per account below so utilisation lands where the story needs it.
for (const c of CUST) {
  for (let m = 4; m <= 10; m++) {
    for (const day of [3, 17]) {
      const issue = `2026-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (issue > W1) continue;
      const due = addDays(issue, c.terms);
      const amount = round(c.monthly / 2 * (0.85 + rnd() * 0.3));
      if (due >= W1) continue; // recent invoices are written explicitly below
      if (c.ticker === "W" && issue >= "2026-07-15") continue; // Wayfair's slide, below
      if (open[c.ticker] && issue >= open[c.ticker][0][0]) continue; // overlaps the explicit open book
      const late = between(c.late[0], c.late[1]);
      if (addDays(due, late) >= W1) continue; // history is settled before week 1
      inv(c.ticker, issue, c.terms, amount, addDays(due, late));
    }
  }
}

const openIds: Record<string, Inv[]> = {};
for (const [t, rows] of Object.entries(open)) {
  const c = CUST.find((x) => x.ticker === t)!;
  openIds[t] = rows.map(([d, a]) => inv(t, d, c.terms, a, null));
}

// Wayfair's slide: July paid 24 days late, August still unpaid at week 1
// (63 days past due), September unpaid (29 days past due), October open.
inv("W", "2026-07-15", 30, 150_000, addDays(addDays("2026-07-15", 30), 24));
const wAug = inv("W", "2026-07-18", 30, 168_000, null);  // due 2026-08-17 → 63 days past due at week 1
const wSep = inv("W", "2026-08-21", 30, 142_000, null);  // due 2026-09-20 → 29 days past due at week 1
inv("W", "2026-09-30", 30, 135_000, null);                // due 2026-10-30
inv("W", "2026-10-12", 30, 125_000, null);                // due 2026-11-11  → open 570k of 600k

// Kohl's disputes part of September's invoice (damaged pallets): logged in the
// CRM in week 1, flagged in the ledger once it short-pays in week 2.

// ---------------------------------------------------------------- week 2
// What happened between the snapshots.
const pay = (i: Inv, d: string) => ({ ...i, paid_date: d, paid_usd: i.amount_usd });
const week2Changes = new Map<string, Inv>();
// WMT, TGT, BBWI, DKS, PTON: the invoices that fell due were paid on time.
for (const t of ["WMT", "TGT", "BBWI", "DKS", "PTON"]) for (const i of openIds[t]) if (i.due_date < W2) week2Changes.set(i.invoice_id, pay(i, addDays(i.due_date, between(0, 2))));
// AAP: leaves its Sept 21 invoice (due 10-21) unpaid, and the orders shipped
// against its new headroom are invoiced straight away (below).
// Wayfair: pays the 63-day invoice on 10-23 after the hold; September stays unpaid.
week2Changes.set(wAug.invoice_id, pay(wAug, "2026-10-23"));
void wSep;
// KSS: the 09-07 invoice (due 10-22) is paid except the disputed part stays open.
const kssSep = openIds.KSS[0];
week2Changes.set(kssSep.invoice_id, { ...kssSep, paid_date: "2026-10-24", paid_usd: kssSep.amount_usd - 18_400, disputed: 1 });

// New invoices issued in week 2 (orders shipped during the week).
const w2New: Inv[] = [
  { invoice_id: "INV-20001", ticker: "AAP", issue_date: "2026-10-21", due_date: addDays("2026-10-21", 30), amount_usd: 40_000, paid_date: "", paid_usd: 0, disputed: 0 },
  { invoice_id: "INV-20002", ticker: "AAP", issue_date: "2026-10-23", due_date: addDays("2026-10-23", 30), amount_usd: 26_000, paid_date: "", paid_usd: 0, disputed: 0 },
  { invoice_id: "INV-20003", ticker: "WMT", issue_date: "2026-10-20", due_date: addDays("2026-10-20", 60), amount_usd: 150_000, paid_date: "", paid_usd: 0, disputed: 0 },
  { invoice_id: "INV-20004", ticker: "KSS", issue_date: "2026-10-21", due_date: addDays("2026-10-21", 45), amount_usd: 30_000, paid_date: "", paid_usd: 0, disputed: 0 },
  { invoice_id: "INV-20005", ticker: "DKS", issue_date: "2026-10-22", due_date: addDays("2026-10-22", 45), amount_usd: 180_000, paid_date: "", paid_usd: 0, disputed: 0 },
];

// AAP's Sept 21 invoice (due 10-21) is 5 days past due at week 2. Its Oct 9
// invoice is not yet due. With the two new invoices the open book is
// 230k + 66k = 296k: 98.7% of the 300k the desk is expected to set.

function snapshot(asOf: string): Inv[] {
  const rows: Inv[] = [];
  for (const i of invoices) {
    if (i.issue_date > asOf) continue;
    const cur = asOf >= W2 ? week2Changes.get(i.invoice_id) ?? i : i;
    const paidByThen = cur.paid_date && cur.paid_date <= asOf;
    rows.push({ ...cur, paid_date: paidByThen ? cur.paid_date : "", paid_usd: paidByThen ? cur.paid_usd : 0 });
  }
  if (asOf >= W2) rows.push(...w2New);
  return rows;
}

const invoiceRows = WEEKS.flatMap((w) => snapshot(w).map((i) => ({ as_of: w, ...i })));

const customerRows = WEEKS.flatMap((w) => CUST.map((c) => ({
  as_of: w, ticker: c.ticker, customer_name: c.name, payment_terms_days: c.terms, credit_limit_usd: c.limit, customer_since: c.since, account_manager: c.manager,
})));

const orderRows = [
  // week 1
  { as_of: W1, order_id: "SO-4471", ticker: "W", order_date: "2026-10-15", ship_by: "2026-10-24", amount_usd: 420_000, status: "awaiting_credit" },
  { as_of: W1, order_id: "SO-4488", ticker: "AAP", order_date: "2026-10-16", ship_by: "2026-10-23", amount_usd: 40_000, status: "awaiting_credit" },
  { as_of: W1, order_id: "SO-4490", ticker: "WMT", order_date: "2026-10-16", ship_by: "2026-10-22", amount_usd: 150_000, status: "awaiting_credit" },
  { as_of: W1, order_id: "SO-4495", ticker: "KSS", order_date: "2026-10-17", ship_by: "2026-10-24", amount_usd: 30_000, status: "awaiting_credit" },
  { as_of: W1, order_id: "SO-4502", ticker: "DKS", order_date: "2026-10-17", ship_by: "2026-10-28", amount_usd: 180_000, status: "awaiting_credit" },
  // week 2: what shipped, what is still waiting, what is new
  { as_of: W2, order_id: "SO-4471", ticker: "W", order_date: "2026-10-15", ship_by: "2026-10-24", amount_usd: 420_000, status: "awaiting_credit" },
  { as_of: W2, order_id: "SO-4488", ticker: "AAP", order_date: "2026-10-16", ship_by: "2026-10-23", amount_usd: 40_000, status: "shipped" },
  { as_of: W2, order_id: "SO-4490", ticker: "WMT", order_date: "2026-10-16", ship_by: "2026-10-22", amount_usd: 150_000, status: "shipped" },
  { as_of: W2, order_id: "SO-4495", ticker: "KSS", order_date: "2026-10-17", ship_by: "2026-10-24", amount_usd: 30_000, status: "shipped" },
  { as_of: W2, order_id: "SO-4502", ticker: "DKS", order_date: "2026-10-17", ship_by: "2026-10-28", amount_usd: 180_000, status: "shipped" },
  { as_of: W2, order_id: "SO-4511", ticker: "AAP", order_date: "2026-10-22", ship_by: "2026-10-23", amount_usd: 26_000, status: "shipped" },
  { as_of: W2, order_id: "SO-4530", ticker: "AAP", order_date: "2026-10-24", ship_by: "2026-10-30", amount_usd: 25_000, status: "awaiting_credit" },
  { as_of: W2, order_id: "SO-4533", ticker: "TGT", order_date: "2026-10-24", ship_by: "2026-11-02", amount_usd: 120_000, status: "awaiting_credit" },
];

const notesW1 = [
  { note_date: "2026-09-08", ticker: "W", category: "risk", note: "July invoice paid 24 days late. AP contact cited a cash management review." },
  { note_date: "2026-10-14", ticker: "W", category: "contact", note: "Wayfair AP: August and September invoices on hold pending 'cash management review'; no payment date given." },
  { note_date: "2026-10-10", ticker: "KSS", category: "dispute", note: "Kohl's disputes $18,400 of the September 7 invoice: damaged pallets at the Ohio DC. Photos requested." },
  { note_date: "2026-10-16", ticker: "AAP", category: "contact", note: "AAP buyer asks for more headroom for Q4 store resets; order SO-4488 pending." },
  { note_date: "2026-10-15", ticker: "DKS", category: "contact", note: "DKS is integrating the Foot Locker banners and asks for an $800,000 limit for Q4 fixtures." },
  { note_date: "2026-10-12", ticker: "TGT", category: "contact", note: "Target confirms Q4 display program volumes in line with last year." },
];
const notesW2 = [
  { note_date: "2026-10-23", ticker: "W", category: "contact", note: "Wayfair paid the August invoice (63 days late) after the order hold was escalated. September invoice still open." },
  { note_date: "2026-10-24", ticker: "AAP", category: "promise_to_pay", note: "AAP AP team: payment run delayed by their ERP migration; expects to pay the Sept 25 invoice by Oct 31. Buyer placed SO-4530 meanwhile." },
  { note_date: "2026-10-24", ticker: "KSS", category: "dispute", note: "Kohl's paid the September 7 invoice short by the disputed $18,400; dispute still open." },
];
const noteRows = [
  ...WEEKS.flatMap((w) => notesW1.map((x) => ({ as_of: w, ...x }))),
  ...notesW2.map((x) => ({ as_of: W2, ...x })),
];

mkdirSync("data/sources", { recursive: true });
const write = (name: string, records: unknown[]) => writeFileSync(`data/sources/${name}.json`, JSON.stringify({ system: name, generated: "scripts/gen-ledger.ts", simulated: true, records }, null, 1));
write("customers", customerRows);
write("invoices", invoiceRows);
write("orders", orderRows);
write("collections_notes", noteRows);
console.log(`customers ${customerRows.length}, invoices ${invoiceRows.length}, orders ${orderRows.length}, notes ${noteRows.length}`);
