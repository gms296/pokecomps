// supabase/functions/limitless-meta/index.ts
//
// Trae el metagame de Standard EN VIVO desde la página pública de Limitless TCG,
// usando una ventana móvil de los últimos 3 meses, y guarda una foto en meta_snapshots.
// No necesita ninguna API key.
//
// Por qué "3months" y no una temporada fija ("2526"): la temporada completa incluye
// meses de ANTES de la rotación de formato, así que mezclaba decks que ya no son
// legales (ej. Gardevoir ex después de la rotación de abril 2026) con los actuales.
// Una ventana móvil de 3 meses se autoactualiza sola con el tiempo: mientras sea más
// larga que el tiempo transcurrido desde la última rotación, en algún punto va a volver
// a mezclar formatos otra vez — si eso pasa, achicar a "1months" hasta la próxima rotación.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const res = await fetch("https://limitlesstcg.com/decks?format=standard&time=3months", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PokeCompsBot/1.0)" },
    });
    const html = await res.text();

    const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
    const decks: { id: string; name: string; share: number }[] = [];

    for (const row of rows) {
      const nameMatch = row.match(/<a href="\/decks\/(\d+)"[^>]*>([\s\S]*?)<\/a>/);
      const shareMatch = row.match(/(\d+\.\d+)%/);
      if (nameMatch && shareMatch) {
        const cleanName = nameMatch[2].replace(/<[^>]+>/g, "").trim();
        if (cleanName) {
          decks.push({ id: nameMatch[1], name: cleanName, share: parseFloat(shareMatch[1]) });
        }
      }
    }
    const top = decks.slice(0, 20);
    const capturedAt = new Date().toISOString();

    if (top.length) {
      const { error: insertError } = await sb.from("meta_snapshots").insert(
        top.map((d) => ({ captured_at: capturedAt, deck_ref: d.id, name: d.name, share: d.share }))
      );
      if (insertError) throw insertError;
    }

    const debugInfo = top.length ? {} : {
      fetchStatus: res.status,
      htmlLength: html.length,
      rowsFound: rows.length,
      debugHtmlSnippet: html.slice(0, 1500),
    };

    return new Response(JSON.stringify({ decks: top, capturedAt, saved: top.length, ...debugInfo }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
