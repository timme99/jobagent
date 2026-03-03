// supabase/functions/delete-user/index.ts
// Deletes the authenticated user from auth.users using the service_role key.
// Cascade deletes are assumed to be configured in the DB for profiles,
// strategies, job_matches, and user_settings.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Validate the user JWT — we only allow users to delete themselves
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonRes(401, { error: 'Missing Authorization header' });
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return jsonRes(401, { error: 'Unauthorized' });
    }

    console.log(`delete-user: deleting user ${user.id}`);

    // Use the service-role admin client to hard-delete from auth.users.
    // This triggers CASCADE deletes on all user data tables.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id);

    if (deleteError) {
      console.error('Failed to delete user:', deleteError.message);
      return jsonRes(500, { error: deleteError.message });
    }

    console.log(`delete-user: user ${user.id} deleted successfully`);
    return jsonRes(200, { success: true });

  } catch (err: any) {
    console.error('Unhandled error in delete-user:', err);
    return jsonRes(500, { error: err.message || 'Internal server error' });
  }
});
