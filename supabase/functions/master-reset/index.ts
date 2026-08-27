import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, requireUser } from '../_shared/game.ts';

declare const Deno: {
  serve: (handler: (req: Request) => Promise<Response> | Response) => void;
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  
  try {
    const { sessionId, userId } = await req.json();
    
    // Validate input
    if (!sessionId) throw new Error('sessionId is required.');
    if (!userId) throw new Error('userId is required.');

    const db = adminClient();

    // Verify the user exists
    await requireUser(db, userId);

    console.log(`✅ Master reset initiated for session: ${sessionId} by user: ${userId}`);

    // ============================================================
    // STEP 1: Delete all players in the session
    // ============================================================
    const { error: deletePlayersError } = await db
      .from('players')
      .delete()
      .eq('session_id', sessionId);
    
    if (deletePlayersError) {
      console.error('Failed to delete players:', deletePlayersError);
      throw new Error('Failed to clear players: ' + deletePlayersError.message);
    }
    console.log(`✅ Deleted players for session: ${sessionId}`);

    // ============================================================
    // STEP 2: Delete all messages in the session
    // ============================================================
    const { error: deleteMessagesError } = await db
      .from('messages')
      .delete()
      .eq('session_id', sessionId);
    
    if (deleteMessagesError) {
      console.error('Failed to delete messages:', deleteMessagesError);
      // Don't throw - messages are non-critical
    } else {
      console.log(`✅ Deleted messages for session: ${sessionId}`);
    }

    // ============================================================
    // STEP 3: Reset the session to a clean state
    // ============================================================
    const { error: updateSessionError } = await db
      .from('sessions')
      .update({
        status: 'active',
        current_turn_index: 0,
        turn_order: [],
        story_narrative: 'A new tale begins… The ember has been rekindled.',
        story_choices: [],
        story_history: [],
        updated_at: new Date().toISOString(),
      })
      .eq('id', sessionId);
    
    if (updateSessionError) {
      console.error('Failed to reset session:', updateSessionError);
      throw new Error('Failed to reset session: ' + updateSessionError.message);
    }
    console.log(`✅ Reset session: ${sessionId}`);

    // ============================================================
    // STEP 4: Clear active_session_id from all profiles that were in this session
    // ============================================================
    const { error: clearProfilesError } = await db
      .from('profiles')
      .update({ active_session_id: null })
      .eq('active_session_id', sessionId);
    
    if (clearProfilesError) {
      console.error('Failed to clear profiles:', clearProfilesError);
      // Don't throw - this is cleanup
    } else {
      console.log(`✅ Cleared active_session_id from profiles for session: ${sessionId}`);
    }

    console.log(`✅ Master reset completed for session: ${sessionId}`);

    return new Response(JSON.stringify({ 
      ok: true, 
      message: 'Session has been completely wiped and reset.' 
    }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
    
  } catch (err) {
    console.error('Master reset error:', err);
    return new Response(JSON.stringify({ 
      error: err instanceof Error ? err.message : String(err)
    }), {
      status: 400,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
});