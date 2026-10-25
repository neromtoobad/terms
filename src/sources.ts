// The data estate Terms reads through Zetaris. One definition drives three
// things: the Zetaris registration DDL (scripts/zetaris-setup.ts), the local
// sample-mode mirror (src/adapters/mirror.ts), and the schema text agents see.
//
// Two kinds of source:
//  - SEC EDGAR (real, public): Zetaris fetches each customer's XBRL facts
//    straight from data.sec.gov (Lightning REST tables, CACHE TABLE'd), and
//    flattens them into one view per concept across all customers.
//  - Halden Packaging's own systems (simulated): customer master, AR ledger,
//    open orders and collections notes, served by Terms at /sources/*.json the
//    way each real system would expose its API. Every row carries `as_of`, so
//    one table holds every weekly snapshot.

export interface Column {
  name: string;
  type: "STRING" | "BIGINT" | "DOUBLE";
  desc: string;
}

export interface SourceTable {
  name: string;
  system: string;
  desc: string;
  columns: Column[];
}

export const CONTAINER = "terms";
export const SEC_DB = "TERMS_SEC";
export const HALDEN_DB = "HALDEN_SYSTEMS";

// The 8 customers: real US-listed retailers. CIKs from SEC company_tickers.json.
export const CUSTOMERS = [
  { ticker: "WMT", cik: "0000104169", name: "Walmart Inc.", sector: "big-box general merchandise and grocery" },
  { ticker: "TGT", cik: "0000027419", name: "Target Corporation", sector: "big-box general merchandise" },
  { ticker: "KSS", cik: "0000885639", name: "Kohl's Corporation", sector: "department stores" },
  { ticker: "AAP", cik: "0001158449", name: "Advance Auto Parts, Inc.", sector: "auto parts retail" },
  { ticker: "PTON", cik: "0001639825", name: "Peloton Interactive, Inc.", sector: "connected fitness" },
  { ticker: "W", cik: "0001616707", name: "Wayfair Inc.", sector: "online home goods" },
  { ticker: "BBWI", cik: "0000701985", name: "Bath & Body Works, Inc.", sector: "specialty retail" },
  { ticker: "DKS", cik: "0001089063", name: "Dick's Sporting Goods, Inc.", sector: "sporting goods retail" },
] as const;
export type Ticker = (typeof CUSTOMERS)[number]["ticker"];

// SEC concepts Terms reads. `instant` concepts are balance-sheet points in time
// (frames like CY2026Q2I); the others are quarterly durations (CY2026Q2).
export const SEC_CONCEPTS = [
  { view: "sec_revenue", tag: "RevenueFromContractWithCustomerExcludingAssessedTax", instant: false, label: "revenue" },
  { view: "sec_net_income", tag: "NetIncomeLoss", instant: false, label: "net income" },
  { view: "sec_assets_current", tag: "AssetsCurrent", instant: true, label: "current assets" },
  { view: "sec_liabilities_current", tag: "LiabilitiesCurrent", instant: true, label: "current liabilities" },
] as const;

const SEC_COLUMNS: Column[] = [
  { name: "ticker", type: "STRING", desc: "customer ticker, joins to customers.ticker" },
  { name: "cik", type: "STRING", desc: "SEC central index key" },
  { name: "entity_name", type: "STRING", desc: "filer name" },
  { name: "concept", type: "STRING", desc: "US-GAAP tag" },
  { name: "frame", type: "STRING", desc: "SEC calendar frame: CY2026Q2 (quarter) or CY2026Q2I (instant)" },
  { name: "period_start", type: "STRING", desc: "YYYY-MM-DD (null for instants)" },
  { name: "period_end", type: "STRING", desc: "YYYY-MM-DD" },
  { name: "value_usd", type: "DOUBLE", desc: "reported value in USD" },
  { name: "fiscal_year", type: "BIGINT", desc: "fiscal year of the filing" },
  { name: "fiscal_period", type: "STRING", desc: "FY | Q1 | Q2 | Q3" },
  { name: "form", type: "STRING", desc: "10-Q | 10-K" },
  { name: "filed", type: "STRING", desc: "filing date" },
];

export const SEC_SOURCES: SourceTable[] = SEC_CONCEPTS.map((c) => ({
  name: c.view,
  system: "SEC EDGAR (live)",
  desc: `${c.label} (${c.tag}) for every customer, from data.sec.gov XBRL company facts`,
  columns: SEC_COLUMNS,
}));

export const HALDEN_SOURCES: SourceTable[] = [
  {
    name: "customers", system: "Halden ERP (simulated)", desc: "Customer master: credit terms and the limit on file, per weekly snapshot",
    columns: [
      { name: "as_of", type: "STRING", desc: "snapshot date YYYY-MM-DD" },
      { name: "ticker", type: "STRING", desc: "customer ticker" },
      { name: "customer_name", type: "STRING", desc: "legal name" },
      { name: "payment_terms_days", type: "BIGINT", desc: "net terms, e.g. 30, 45, 60" },
      { name: "credit_limit_usd", type: "DOUBLE", desc: "credit limit on file in the ERP" },
      { name: "customer_since", type: "STRING", desc: "YYYY" },
      { name: "account_manager", type: "STRING", desc: "Halden account owner" },
    ],
  },
  {
    name: "invoices", system: "Halden AR ledger (simulated)", desc: "Invoices with due date, amount and payment, per weekly snapshot",
    columns: [
      { name: "as_of", type: "STRING", desc: "snapshot date YYYY-MM-DD" },
      { name: "invoice_id", type: "STRING", desc: "invoice number" },
      { name: "ticker", type: "STRING", desc: "customer ticker" },
      { name: "issue_date", type: "STRING", desc: "YYYY-MM-DD" },
      { name: "due_date", type: "STRING", desc: "YYYY-MM-DD" },
      { name: "amount_usd", type: "DOUBLE", desc: "invoice amount" },
      { name: "paid_date", type: "STRING", desc: "YYYY-MM-DD, empty if unpaid at as_of" },
      { name: "paid_usd", type: "DOUBLE", desc: "amount paid so far" },
      { name: "disputed", type: "BIGINT", desc: "1 if the customer disputes the invoice" },
    ],
  },
  {
    name: "orders", system: "Halden order book (simulated)", desc: "Open orders waiting for credit release, per weekly snapshot",
    columns: [
      { name: "as_of", type: "STRING", desc: "snapshot date YYYY-MM-DD" },
      { name: "order_id", type: "STRING", desc: "sales order number" },
      { name: "ticker", type: "STRING", desc: "customer ticker" },
      { name: "order_date", type: "STRING", desc: "YYYY-MM-DD" },
      { name: "ship_by", type: "STRING", desc: "requested ship date" },
      { name: "amount_usd", type: "DOUBLE", desc: "order value" },
      { name: "status", type: "STRING", desc: "awaiting_credit | released | shipped" },
    ],
  },
  {
    name: "collections_notes", system: "Halden CRM (simulated)", desc: "Collections and account notes logged by Halden staff",
    columns: [
      { name: "as_of", type: "STRING", desc: "snapshot date the note is visible from" },
      { name: "note_date", type: "STRING", desc: "YYYY-MM-DD" },
      { name: "ticker", type: "STRING", desc: "customer ticker" },
      { name: "category", type: "STRING", desc: "promise_to_pay | dispute | contact | risk" },
      { name: "note", type: "STRING", desc: "free text" },
    ],
  },
];

export const SOURCES: SourceTable[] = [...SEC_SOURCES, ...HALDEN_SOURCES];

// Weekly snapshots of Halden's systems. The desk moves through them with
// "advance week"; week 1 is where every demo starts.
export const WEEKS = ["2026-10-19", "2026-10-26"] as const;

export function schemaText(): string {
  return SOURCES.map(
    (t) => `${CONTAINER}.${t.name}  -- ${t.system}: ${t.desc}\n` + t.columns.map((c) => `   ${c.name} ${c.type}  -- ${c.desc}`).join("\n")
  ).join("\n");
}

const slug = (t: string) => t.toLowerCase();
export const secRawTable = (ticker: string, tag: string) => `${slug(ticker)}_${slug(tag)}_raw`;

// Statements to re-run after Zetaris restarts (CACHE TABLE is in-memory).
export function zetarisRecache(): string[] {
  return [
    ...SEC_CONCEPTS.flatMap((c) => CUSTOMERS.map((cu) => `CACHE TABLE ${SEC_DB.toLowerCase()}.${secRawTable(cu.ticker, c.tag)}`)),
    ...HALDEN_SOURCES.map((t) => `CACHE TABLE ${HALDEN_DB.toLowerCase()}.${t.name}_src`),
  ];
}

// Zetaris DDL, one statement per entry (Zetaris runs one statement per call).
// Raw REST tables are CACHE TABLE'd straight after creation: an uncached
// Lightning REST table re-fetches its endpoint on every query.
export function zetarisDdl(sourceBaseUrl: string, userAgent: string): string[] {
  const out: string[] = [
    `CREATE LIGHTNING DATABASE ${SEC_DB} DESCRIBE BY "SEC EDGAR XBRL company facts for Halden customers"`,
    `CREATE LIGHTNING DATABASE ${HALDEN_DB} DESCRIBE BY "Halden Packaging internal systems, simulated, served by Terms"`,
    `CREATE SCHEMASTORE CONTAINER ${CONTAINER}`,
  ];
  // One view per concept, a UNION ALL straight over the customers' raw tables
  // (a view over other schemastore views of the same shape fails to resolve).
  for (const c of SEC_CONCEPTS) {
    const parts: string[] = [];
    for (const cu of CUSTOMERS) {
      const raw = secRawTable(cu.ticker, c.tag);
      out.push(
        `CREATE LIGHTNING REST TABLE ${raw} FROM ${SEC_DB} REQUEST(endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK${cu.cik}/us-gaap/${c.tag}.json", method "get", response_type "json", http_encoding "URLENCODED") HEADER (user-agent "${userAgent}") BODY ()`,
        `CACHE TABLE ${SEC_DB.toLowerCase()}.${raw}`
      );
      parts.push(
        `SELECT '${cu.ticker}' AS ticker, CAST(cik AS STRING) AS cik, \`entityName\` AS entity_name, tag AS concept, fact.frame AS frame, ${c.instant ? "CAST(NULL AS STRING)" : "fact.`start`"} AS period_start, fact.\`end\` AS period_end, CAST(fact.val AS DOUBLE) AS value_usd, CAST(fact.fy AS BIGINT) AS fiscal_year, fact.fp AS fiscal_period, fact.form AS form, fact.filed AS filed FROM ${SEC_DB.toLowerCase()}.${raw} LATERAL VIEW explode(units.USD) AS fact WHERE fact.frame IS NOT NULL`
      );
    }
    out.push(`CREATE SCHEMASTORE VIEW ${c.view} WITH CONTAINER ${CONTAINER} AS ${parts.join(" UNION ALL ")}`);
  }
  for (const t of HALDEN_SOURCES) {
    out.push(
      `CREATE LIGHTNING REST TABLE ${t.name}_src FROM ${HALDEN_DB} REQUEST(endpoint "${sourceBaseUrl.replace(/\/+$/, "")}/sources/${t.name}.json", method "get", response_type "json", http_encoding "URLENCODED") HEADER () BODY ()`,
      `CACHE TABLE ${HALDEN_DB.toLowerCase()}.${t.name}_src`
    );
    const cols = t.columns.map((c) => (c.type === "STRING" ? `r.${c.name} AS ${c.name}` : `CAST(r.${c.name} AS ${c.type}) AS ${c.name}`)).join(", ");
    out.push(`CREATE SCHEMASTORE VIEW ${t.name} WITH CONTAINER ${CONTAINER} AS SELECT ${cols} FROM ${HALDEN_DB.toLowerCase()}.${t.name}_src LATERAL VIEW explode(records) AS r`);
  }
  return out;
}
