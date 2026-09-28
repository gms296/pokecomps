// supabase/functions/limitless-meta/index.ts
//
// Trae el metagame de Standard EN VIVO desde la página pública de Limitless TCG
// (limitlesstcg.com/decks). No necesita ninguna API key.
//
// v4: el nombre del deck puede venir con un ícono (<img>) u otra etiqueta ANTES del
// texto, dentro del mismo <a>. Ahora se toma todo el contenido interno del link y se
// le quitan las etiquetas, en vez de esperar texto plano pegado al ">".
// Si aun así no encuentra nada, sigue devolviendo el diagnóstico (debugHtmlSnippet, etc.)

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
    const res = await fetch("https://limitlesstcg.com/decks?format=standard", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PokeCompsBot/1.0)" },
    });
    const html = await res.text();

    const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
    const decks: { id: string; name: string; share: number }[] = [];

    for (const row of rows) {
      // Toma TODO el contenido interno del <a href="/decks/ID">...</a>, tenga o no etiquetas adentro
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

    // Buscamos qué códigos de "format=" existen realmente en la página,
    // para saber cuál corresponde al Standard actual en vez de adivinar.
    const formatCodes = [...new Set(
      [...html.matchAll(/[?&]format=([A-Za-z0-9_.-]+)/g)].map((m) => m[1])
    )];
    const selectMatch = html.match(/<select[^>]*name="format"[\s\S]*?<\/select>/i);

    if (top.length) {
      const { error: insertError } = await sb.from("meta_snapshots").insert(
        top.map((d) => ({ captured_at: capturedAt, deck_ref: d.id, name: d.name, share: d.share }))
      );
      if (insertError) throw insertError;
    }

    const debugInfo = top.length ? { formatCodesFound: formatCodes, formatSelectSnippet: selectMatch ? selectMatch[0] : null } : {
      fetchStatus: res.status,
      htmlLength: html.length,
      rowsFound: rows.length,
      debugHtmlSnippet: html.slice(0, 1500),
      firstRowSnippet: rows[0] || null,
      containsDecksLink: html.includes("/decks/"),
      containsPercent: /\d+\.\d+%/.test(html),
      formatCodesFound: formatCodes,
      formatSelectSnippet: selectMatch ? selectMatch[0] : null,
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
