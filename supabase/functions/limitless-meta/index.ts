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
      const nameMatch = row.match(/<a href="\/decks\/(\d+)"[^>]*>([^<]+)<\/a>/);
      const shareMatch = row.match(/(\d+\.\d+)%/);
      if (nameMatch && shareMatch) {
        decks.push({ id: nameMatch[1], name: nameMatch[2].trim(), share: parseFloat(shareMatch[1]) });
      }
    }
    const top = decks.slice(0, 20);
    const capturedAt = new Date().toISOString();

    // Guarda la foto en la base (esto es lo nuevo)
    if (top.length) {
      const { error: insertError } = await sb.from("meta_snapshots").insert(
        top.map((d) => ({ captured_at: capturedAt, deck_ref: d.id, name: d.name, share: d.share }))
      );
      if (insertError) throw insertError;
    }

    return new Response(JSON.stringify({ decks: top, capturedAt, saved: top.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
