import { corsHeaders } from '../_shared/cors.ts';

const REPLICATE_API_TOKEN = Deno.env.get('REPLICATE_API_TOKEN') || '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { prompt, location, action, mood } = await req.json();
    
    if (!prompt) {
      throw new Error('Prompt is required.');
    }

    // Enhanced prompt for FLUX.2
    const enhancedPrompt = `A dark fantasy scene in a retro 16-bit pixel art style, with a grim atmosphere. ${prompt}. Detailed pixel art, gameboy advance style.`;

    let imageUrl = null;
    let usedModel = '';

    // --- Use Replicate FLUX.2 [pro] ---
    if (REPLICATE_API_TOKEN) {
      try {
        console.log('🖼️ Using Replicate FLUX.2 [pro]...');

        const response = await fetch('https://api.replicate.com/v1/predictions', {
          method: 'POST',
          headers: {
            'Authorization': `Token ${REPLICATE_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            version: 'black-forest-labs/flux-2-pro',
            input: {
              prompt: enhancedPrompt,
              // Optional: adjust these for your needs
              // width: 1024,
              // height: 768,
              // num_outputs: 1,
            },
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('Replicate API error:', response.status, errorText);
          throw new Error(`Replicate API error: ${response.status}`);
        }

        const prediction = await response.json();
        console.log('📡 Prediction ID:', prediction.id);

        // Poll for the result
        let result = prediction;
        let attempts = 0;
        const maxAttempts = 30;

        while (result.status !== 'succeeded' && result.status !== 'failed' && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const statusRes = await fetch(result.urls.get, {
            headers: { 'Authorization': `Token ${REPLICATE_API_TOKEN}` },
          });
          result = await statusRes.json();
          attempts++;
          console.log(`⏳ Polling... (${attempts}/${maxAttempts}) status: ${result.status}`);
        }

        if (result.status === 'failed') {
          console.error('Replicate prediction failed:', result.error);
          throw new Error('Replicate prediction failed');
        }

        if (result.status === 'succeeded') {
          // FLUX.2 returns a single image URL or array
          if (Array.isArray(result.output)) {
            imageUrl = result.output[0];
          } else if (typeof result.output === 'string') {
            imageUrl = result.output;
          } else if (result.output && typeof result.output === 'object') {
            // Sometimes it returns an object with a url property
            imageUrl = result.output.url || JSON.stringify(result.output);
          }
          
          if (imageUrl) {
            usedModel = 'Replicate FLUX.2 [pro]';
            console.log('✅ Replicate FLUX.2 worked!');
          } else {
            throw new Error('No image URL in output');
          }
        }
      } catch (err) {
        console.warn('❌ Replicate failed:', err.message);
      }
    } else {
      console.warn('⚠️ No REPLICATE_API_TOKEN found.');
    }

    // --- FALLBACK: Use Pollinations (if Replicate fails) ---
    if (!imageUrl) {
      try {
        console.log('🔄 Trying Pollinations fallback...');
        const encodedPrompt = encodeURIComponent(enhancedPrompt);
        const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=384&nologo=true&seed=${Date.now()}`;
        
        const response = await fetch(pollinationsUrl);
        if (response.ok) {
          const blob = await response.blob();
          if (blob.size > 0) {
            const arrayBuffer = await blob.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
            imageUrl = `data:image/png;base64,${base64}`;
            usedModel = 'Pollinations (fallback)';
            console.log('✅ Pollinations fallback worked!');
          }
        }
      } catch (err) {
        console.warn('Pollinations fallback failed:', err.message);
      }
    }

    // --- FINAL FALLBACK: Canvas renderer ---
    if (!imageUrl) {
      console.log('🔄 Using canvas fallback renderer...');
      return new Response(JSON.stringify({
        ok: true,
        imageUrl: null,
        fallback: true,
        prompt: enhancedPrompt,
      }), {
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    console.log('✅ Returning image URL, used model:', usedModel);
    return new Response(JSON.stringify({
      ok: true,
      imageUrl: imageUrl,
      prompt: enhancedPrompt,
      usedModel: usedModel,
    }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });

  } catch (err) {
    console.error('❌ generate-image error:', err);
    return new Response(JSON.stringify({ 
      error: String(err.message || err),
      imageUrl: null,
    }), {
      status: 400,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
});