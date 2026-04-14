/**
 * Prime Trust Realtor — Cloudflare Worker
 * Handles:
 *   POST /api/upload-image  → Uploads image to Cloudflare R2, returns public URL
 *   GET  /api/cms-data      → Returns cms-data.json (served from KV or R2)
 *   PUT  /api/cms-data      → Admin saves updated CMS JSON (password protected)
 *
 * Setup:
 *  1. Create R2 bucket named: prime-trust-images
 *  2. Create KV namespace named: PRIME_TRUST_KV
 *  3. Bind both in wrangler.toml (see below)
 *  4. Set secret: wrangler secret put ADMIN_PASSWORD
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers — allow your Cloudflare Pages domain
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ─── GET /api/cms-data ──────────────────────────────────────────
    if (path === "/api/cms-data" && request.method === "GET") {
      try {
        const data = await env.PRIME_TRUST_KV.get("cms-data", { type: "text" });
        if (!data) {
          return new Response(
            JSON.stringify({ error: "CMS data not found. Upload cms-data.json first." }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        return new Response(data, {
          headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-cache" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // ─── PUT /api/cms-data ──────────────────────────────────────────
    if (path === "/api/cms-data" && request.method === "PUT") {
      const password = request.headers.get("X-Admin-Password");
      if (password !== env.ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      try {
        const body = await request.text();
        JSON.parse(body); // Validate JSON before saving
        await env.PRIME_TRUST_KV.put("cms-data", body);
        return new Response(JSON.stringify({ success: true, message: "CMS data saved." }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON: " + e.message }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // ─── POST /api/upload-image ─────────────────────────────────────
    if (path === "/api/upload-image" && request.method === "POST") {
      const password = request.headers.get("X-Admin-Password");
      if (password !== env.ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      try {
        const formData = await request.formData();
        const file = formData.get("image");

        if (!file || typeof file === "string") {
          return new Response(JSON.stringify({ error: "No image file received." }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // Validate type
        const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
        if (!allowed.includes(file.type)) {
          return new Response(JSON.stringify({ error: "Only JPG, PNG, WEBP allowed." }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // Validate size (5MB max)
        if (file.size > 5 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: "Image must be under 5MB." }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // Generate unique filename
        const ext = file.type.split("/")[1].replace("jpeg", "jpg");
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        const filename = `properties/${timestamp}-${random}.${ext}`;

        // Upload to R2
        const buffer = await file.arrayBuffer();
        await env.PRIME_TRUST_IMAGES.put(filename, buffer, {
          httpMetadata: { contentType: file.type },
        });

        // Public URL — set your R2 custom domain or use this pattern
        // If you've set a public bucket domain in Cloudflare, use that here:
        const publicUrl = `https://images.primetrustrealtor.com/${filename}`;
        // Fallback: use worker URL pattern if no custom domain:
        // const publicUrl = `${url.origin}/images/${filename}`;

        return new Response(JSON.stringify({ success: true, url: publicUrl, filename }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // ─── GET /images/* ──────────────────────────────────────────────
    // Serve images from R2 (if no custom R2 domain is set)
    if (path.startsWith("/images/") && request.method === "GET") {
      const key = path.replace("/images/", "");
      const object = await env.PRIME_TRUST_IMAGES.get(key);
      if (!object) {
        return new Response("Image not found", { status: 404 });
      }
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Cache-Control", "public, max-age=31536000");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(object.body, { headers });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
};
