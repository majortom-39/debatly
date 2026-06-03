import { createClient, type Session, type User } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabasePublishableKey!, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true
      }
    })
  : null;

export type AuthProvider = "google" | "x" | "discord";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
  isAnonymous: boolean;
};

export function mapAuthUser(user: User | null | undefined): AuthUser | null {
  if (!user) return null;
  const isAnonymous = Boolean(user.is_anonymous);
  return {
    id: user.id,
    email: user.email || "",
    name: user.user_metadata?.full_name || user.user_metadata?.name || user.email || (isAnonymous ? "Guest" : "Signed-in user"),
    avatarUrl: user.user_metadata?.avatar_url || user.user_metadata?.picture || "",
    isAnonymous
  };
}

export async function getAuthSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

export async function getAccessToken() {
  const session = await getAuthSession();
  return session?.access_token || "";
}

export async function authHeaders(extra: HeadersInit = {}): Promise<HeadersInit> {
  const token = await getAccessToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

// Sign a brand-new visitor in as an anonymous guest (no email/password) so the
// app is fully usable with zero friction. Requires "Allow anonymous sign-ins" in
// the Supabase dashboard.
export async function signInAnonymously(): Promise<Session | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.session || null;
}

export async function signInWithProvider(provider: AuthProvider) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const redirectTo = window.location.origin;
  // If the current visitor is an anonymous guest, LINK the new identity instead of
  // a plain sign-in so all their existing guest debates carry over to the permanent
  // account (same user id). If linking isn't available, fall back to a normal sign-in.
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session?.user?.is_anonymous) {
    const { error: linkError } = await supabase.auth.linkIdentity({ provider, options: { redirectTo } });
    if (!linkError) return; // browser redirects to the provider
  }
  const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo } });
  if (error) throw error;
}

export async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
