/**
 * WebRTC Signaling Worker
 * Uses Cloudflare KV to exchange SDP + ICE candidates between peers.
 * Rooms expire after 1 hour automatically (KV TTL).
 *
 * Endpoints:
 *   POST /room/:id/offer          — caller posts SDP offer
 *   GET  /room/:id/offer          — callee polls for offer
 *   POST /room/:id/answer         — callee posts SDP answer
 *   GET  /room/:id/answer         — caller polls for answer
 *   POST /room/:id/ice/:role      — either peer posts ICE candidates (?role=caller|callee)
 *   GET  /room/:id/ice/:role      — other peer polls ICE candidates
 *   DELETE /room/:id              — clean up (optional)
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const TTL = 3600; // 1 hour

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    // Expected paths: /room/:id/offer | /room/:id/answer | /room/:id/ice/:role
    const parts = url.pathname.replace(/^\//, "").split("/");
    // parts[0] = "room", parts[1] = roomId, parts[2] = type, parts[3] = role (ice only)

    if (parts[0] !== "room" || !parts[1]) {
      return err("Invalid path. Use /room/:id/offer|answer|ice/caller|callee", 404);
    }

    const roomId = parts[1].slice(0, 64); // cap length
    const type = parts[2]; // offer | answer | ice
    const role = parts[3]; // caller | callee (ice only)

    if (!["offer", "answer", "ice"].includes(type)) {
      return err("Type must be offer, answer, or ice", 404);
    }

    const key = type === "ice" ? `${roomId}:ice:${role}` : `${roomId}:${type}`;

    if (!["caller", "callee"].includes(role) && type === "ice") {
      return err("Role must be caller or callee for ice", 400);
    }

    // DELETE room — clear all keys
    if (request.method === "DELETE" && parts[2] === undefined) {
      await Promise.all([
        env.SIGNALING_KV.delete(`${roomId}:offer`),
        env.SIGNALING_KV.delete(`${roomId}:answer`),
        env.SIGNALING_KV.delete(`${roomId}:ice:caller`),
        env.SIGNALING_KV.delete(`${roomId}:ice:callee`),
      ]);
      return json({ ok: true });
    }

    // POST — store value
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return err("Body must be JSON");
      }

      // For ICE, we append candidates rather than overwrite
      if (type === "ice") {
        const existing = await env.SIGNALING_KV.get(key, "json") || [];
        const updated = existing.concat(Array.isArray(body) ? body : [body]);
        await env.SIGNALING_KV.put(key, JSON.stringify(updated), { expirationTtl: TTL });
        return json({ ok: true, count: updated.length });
      }

      await env.SIGNALING_KV.put(key, JSON.stringify(body), { expirationTtl: TTL });
      return json({ ok: true });
    }

    // GET — retrieve value
    if (request.method === "GET") {
      const value = await env.SIGNALING_KV.get(key, "json");
      if (value === null) return json({ found: false });
      return json({ found: true, data: value });
    }

    return err("Method not allowed", 405);
  },
};
