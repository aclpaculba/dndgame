import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { prompt, location, action, mood } = await req.json();
    
    if (!prompt) {
      throw new Error('Prompt is required.');
    }

    // Keep it simple - no long descriptions
    const cleanPrompt = prompt.trim();
    const encodedPrompt = encodeURIComponent(cleanPrompt);
    
    // Use a simpler URL format
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=384&nologo=true&seed=${Date.now()}`;

    console.log('Generated prompt:', cleanPrompt);

    return new Response(JSON.stringify({
      ok: true,
      imageUrl: imageUrl,
      prompt: cleanPrompt,
    }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });

  } catch (err) {
    console.error('generate-image error:', err);
    return new Response(JSON.stringify({ 
      error: String(err.message || err),
      imageUrl: null,
    }), {
      status: 400,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
});