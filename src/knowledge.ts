// The desk's knowledge: Halden's credit policy and the sector notes that
// qualify it. Loaded from data/knowledge/policy.json; every decision cites
// clause ids from here, and the Risk Officer enforces them.

import { readFileSync } from "node:fs";

export interface Clause {
  id: string;
  title: string;
  text: string;
  applies_to?: string[];
}

interface PolicyBook {
  name: string;
  version: string;
  clauses: Clause[];
  sector_notes: Clause[];
}

let book: PolicyBook | null = null;

export function policyBook(): PolicyBook {
  book ??= JSON.parse(readFileSync("data/knowledge/policy.json", "utf8")) as PolicyBook;
  return book;
}

export function clause(id: string): Clause {
  const b = policyBook();
  const c = [...b.clauses, ...b.sector_notes].find((x) => x.id === id);
  if (!c) throw new Error(`unknown clause ${id}`);
  return c;
}

export const sectorNotesFor = (ticker: string): Clause[] => policyBook().sector_notes.filter((n) => n.applies_to?.includes(ticker));

export function policyText(): string {
  const b = policyBook();
  return [...b.clauses, ...b.sector_notes].map((c) => `${c.id} ${c.title}: ${c.text}`).join("\n");
}
