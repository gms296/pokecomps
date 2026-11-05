// supabase/functions/limitless-decklists/index.ts
//
// Para cada arquetipo del último snapshot de meta:
// 1) Busca en su página de arquetipo (limitlesstcg.com/decks/<ref>) un decklist real reciente.
// 2) Lee ese decklist específico (limitlesstcg.com/decks/list/<id>) y saca cada carta con su cantidad.
// 3) Reemplaza lo guardado en deck_lists para ese arquetipo.
//
// No usa ninguna API key: son páginas públicas, igual que limitless-meta.
// Si Limitless cambia el diseño de estas páginas, el parser de texto puede necesitar un ajuste.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"');
}

// Saca de la página (HTML crudo) la expansión y el número de cada carta, en el orden en que aparecen.
// Limitless enlaza cada carta como /cards/<EXPANSIÓN>/<NÚMERO> (ej. /cards/TWM/128).
function extractPrints(html: string): { set: string; num: string }[] {
  const out: { set: string; num: string }[] = [];
  const re = /href="(?:https?:\/\/limitlesstcg\.com)?\/cards\/([A-Za-z0-9-]+)\/([A-Za-z0-9-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const cur = { set: m[1].toUpperCase(), num: m[2] };
    const last = out[out.length - 1];
    if (last && last.set === cur.set && last.num === cur.num) continue; // imagen + nombre apuntan a la misma carta
    out.push(cur);
  }
  return out;
}

function parseDecklist(text: string) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const headingMap: Record<string, string> = {
    "Pokémon": "Pokemon", "Pokemon": "Pokemon", "Trainer": "Trainer", "Energy": "Energy",
  };
  const cards: { category: string; name: string; quantity: number }[] = [];
  let currentCategory: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^(Copy to Clipboard|Decklist played by)/i.test(line)) break;
    const heading = line.match(/^(Pokémon|Pokemon|Trainer|Energy)\s*\(\d+\)$/i);
    if (heading) {
      currentCategory = headingMap[heading[1]] || heading[1];
      i++;
      continue;
    }
    if (currentCategory && /^\d{1,2}$/.test(line)) {
      const qty = parseInt(line, 10);
      i++;
      while (i < lines.length && /^[$€]/.test(lines[i])) i++;
      if (i < lines.length && !/^\d{1,2}$/.test(lines[i])) {
        const name = lines[i];
        cards.push({ category: currentCategory, name, quantity: qty });
        i++;
      }
      while (i < lines.length && /^[$€]/.test(lines[i])) i++;
      continue;
    }
    i++;
  }
  return cards;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { data: latestRow } = await sb
      .from("meta_snapshots").select("captured_at")
      .order("captured_at", { ascending: false }).limit(1).maybeSingle();
    if (!latestRow) {
      return new Response(JSON.stringify({ error: "Todavía no hay un snapshot de meta guardado. Corré limitless-meta primero." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: archetypes } = await sb
      .from("meta_snapshots").select("deck_ref,name,share")
      .eq("captured_at", latestRow.captured_at)
      .order("share", { ascending: false })
      .limit(20);

    const results = [];
    for (const arch of archetypes || []) {
      try {
        const archRes = await fetch(`https://limitlesstcg.com/decks/${arch.deck_ref}?format=standard`, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; PokeCompsBot/1.0)" },
        });
        const archHtml = await archRes.text();
        const listMatch = archHtml.match(/href="\/decks\/list\/(\d+)"/);
        if (!listMatch) {
          results.push({ archetype: arch.name, ok: false, reason: "no se encontró ningún decklist en esa página" });
          continue;
        }
        const listId = listMatch[1];

        const listRes = await fetch(`https://limitlesstcg.com/decks/list/${listId}`, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; PokeCompsBot/1.0)" },
        });
        const listHtml = await listRes.text();
        const cards: { category: string; name: string; quantity: number; set?: string; num?: string }[] =
          parseDecklist(stripTags(listHtml));
        // Se asigna expansión+número solo si la cantidad de enlaces coincide con la de cartas leídas;
        // si no coincide, es más seguro guardar solo el nombre que asignar un número equivocado.
        const prints = extractPrints(listHtml);
        let hinted = 0;
        if (prints.length === cards.length) {
          cards.forEach((c, i) => { c.set = prints[i].set; c.num = prints[i].num; });
          hinted = cards.length;
        }

        if (!cards.length) {
          results.push({ archetype: arch.name, ok: false, reason: "no se pudo leer el decklist (¿cambió el diseño de la página?)" });
          continue;
        }

        await sb.from("deck_lists").delete().eq("archetype", arch.name);
        await sb.from("deck_lists").insert(
          cards.map((c) => ({
            archetype: arch.name, card_name: c.name, category: c.category,
            quantity: c.quantity, source_list_id: listId,
            set_code: c.set ?? null, number: c.num ?? null,
          }))
        );
        results.push({
          archetype: arch.name, ok: true, cards: cards.length, source: listId,
          con_expansion_y_numero: hinted, enlaces_encontrados: prints.length,
          ejemplo: cards.slice(0, 3).map((c) => `${c.quantity} ${c.name} ${c.set ?? "?"} ${c.num ?? "?"}`),
        });
      } catch (e) {
        results.push({ archetype: arch.name, ok: false, reason: String(e) });
      }
    }

    return new Response(JSON.stringify({ results, capturedAt: new Date().toISOString() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
