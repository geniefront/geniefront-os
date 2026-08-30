import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__, {
  auth: { persistSession: true, autoRefreshToken: true },
});
