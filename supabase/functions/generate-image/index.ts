import { corsHeaders } from '../_shared/cors.ts';

// Pollinations.ai - Completely free image generation
// https://pollinations.ai/
// @ts-ignore
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { prompt, location, action, mood } = await req.json();
    
    if (!prompt) {
      throw new Error('Prompt is required.');
    }

    // Enhance prompt for pixel art
    const enhancedPrompt = `pixel art style, 16-bit retro game scene, dark fantasy rpg, ${prompt}, pixelated, low resolution, gameboy advance style, detailed pixel art, grim atmosphere`.trim();
    
    // Use Pollinations.ai - completely free, no API key needed
    // Adding a random seed to get different images each time
    const encodedPrompt = encodeURIComponent(enhancedPrompt);
    const seed = Date.now();
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=640&height=360&nologo=true&seed=${seed}`;

    return new Response(JSON.stringify({
      ok: true,
      imageUrl: imageUrl,
      prompt: enhancedPrompt,
      seed: seed,
    }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });

  } catch (err) {
    console.error('generate-image error:', err);
    return new Response(JSON.stringify({ 
    // @ts-ignore
      error: String(err.message || err),
      imageUrl: null,
    }), {
      status: 400,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
});