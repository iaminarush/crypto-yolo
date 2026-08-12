import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../../../database.types.ts";

/**
 * Client-safe Supabase client (anon key + RLS).
 * This is safe to use in the browser: the anon key is public by design and
 * row-level security must be enforced in Supabase. Only data visible to the
 * anon role is readable from the dashboard.
 */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export function getSupabase() {
	if (!supabaseUrl || !supabaseAnonKey) {
		throw new Error(
			"Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in apps/web/.env.local",
		);
	}
	return createClient<Database>(supabaseUrl, supabaseAnonKey);
}
