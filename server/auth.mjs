import { createClient } from "@supabase/supabase-js";
import { Resolver } from "node:dns/promises";
import https from "node:https";
import WebSocket from "ws";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const SUPABASE_HOST = parseSupabaseHost(SUPABASE_URL);
const publicDnsResolver = new Resolver();
publicDnsResolver.setServers(["1.1.1.1", "8.8.8.8"]);

let supabaseAdmin = null;
let supabaseAddressCache = { host: "", address: "", expiresAt: 0 };

export function isAuthConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

export function getAuthConfigStatus() {
  return {
    configured: isAuthConfigured()
  };
}

export function getSupabaseAdmin() {
  if (!isAuthConfigured()) return null;
  if (!supabaseAdmin) {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: {
        fetch: createSupabaseFetch()
      },
      realtime: {
        transport: WebSocket
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }
  return supabaseAdmin;
}

function parseSupabaseHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function createSupabaseFetch() {
  return async function supabaseFetch(input, init = {}) {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    if (!SUPABASE_HOST || requestUrl.hostname !== SUPABASE_HOST || requestUrl.protocol !== "https:") {
      return fetch(input, init);
    }
    return fetchWithPublicDns(requestUrl, input, init);
  };
}

async function resolveSupabaseAddress(hostname) {
  const now = Date.now();
  if (supabaseAddressCache.host === hostname && supabaseAddressCache.address && supabaseAddressCache.expiresAt > now) {
    return supabaseAddressCache.address;
  }
  const addresses = await publicDnsResolver.resolve4(hostname);
  const address = addresses[0];
  if (!address) throw new Error(`No public DNS address found for ${hostname}`);
  supabaseAddressCache = { host: hostname, address, expiresAt: now + 60_000 };
  return address;
}

function fetchWithPublicDns(url, input, init = {}) {
  const baseRequest = input instanceof Request ? input : null;
  const headers = new Headers(baseRequest?.headers || {});
  new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
  const headerObject = {};
  headers.forEach((value, key) => {
    headerObject[key] = value;
  });
  const method = init.method || baseRequest?.method || "GET";
  const body = init.body || null;
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      method,
      path: `${url.pathname}${url.search}`,
      headers: headerObject,
      timeout: Number(process.env.SUPABASE_AUTH_TIMEOUT_MS || 10_000),
      lookup(hostname, options, callback) {
        resolveSupabaseAddress(hostname)
          .then((address) => {
            if (options?.all) {
              callback(null, [{ address, family: 4 }]);
              return;
            }
            callback(null, address, 4);
          })
          .catch((error) => callback(error));
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode || 0,
          statusText: response.statusMessage || "",
          headers: response.headers
        }));
      });
    });
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error(`Supabase request timed out after ${request.timeout}ms`));
    });
    if (body) request.write(body);
    request.end();
  });
}

export async function authenticateBearerToken(token) {
  if (!token || !isAuthConfigured()) return null;
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  const user = data.user;
  return {
    id: user.id,
    email: user.email || "",
    name: user.user_metadata?.full_name || user.user_metadata?.name || user.email || "Signed-in user",
    avatarUrl: user.user_metadata?.avatar_url || user.user_metadata?.picture || "",
    provider: user.app_metadata?.provider || user.app_metadata?.providers?.[0] || ""
  };
}

export async function attachAuthUser(request, _response, next) {
  try {
    request.authUser = await authenticateBearerToken(getBearerToken(request));
  } catch (error) {
    console.warn(`[auth] token validation failed: ${error instanceof Error ? error.message : String(error)}`);
    request.authUser = null;
  }
  next();
}

export function requireAuth(request, response) {
  if (request.authUser?.id) return true;
  response.status(401).json({ error: "Authentication required" });
  return false;
}

export function getBearerToken(request) {
  const header = request.headers?.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  return match?.[1]?.trim() || "";
}

export function getTokenFromUrl(request) {
  try {
    const parsed = new URL(request.url || "", "http://127.0.0.1");
    return parsed.searchParams.get("access_token") || "";
  } catch {
    return "";
  }
}
