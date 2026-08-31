import { corsHeaders } from '../_shared/cors.ts';

const HF_API_KEY = Deno.env.get('HF_API_KEY') || '';
const MODEL = 'stabilityai/stable-diffusion-2-1';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { prompt, location, action, mood } = await req.json();
    
    if (!prompt) {
      throw new Error('Prompt is required.');
    }

    const enhancedPrompt = `pixel art style, 16-bit retro game scene, dark fantasy rpg, ${prompt}, pixelated, low resolution, gameboy advance style, detailed pixel art, grim atmosphere`.trim();
    
    let imageUrl = null;
    let usedHF = false;

    // Try Hugging Face
    if (HF_API_KEY) {
      try {
        console.log('Using Hugging Face Inference API...');
        
        const response = await fetch(
          `https://api-inference.huggingface.co/models/${MODEL}`,
          {
            headers: {
              'Authorization': `Bearer ${HF_API_KEY}`,
              'Content-Type': 'application/json',
            },
            method: 'POST',
            body: JSON.stringify({
              inputs: enhancedPrompt,
              parameters: {
                negative_prompt: 'blurry, low quality, distorted, realistic, photograph, 3d',
                width: 512,
                height: 384,
                num_inference_steps: 25,
                guidance_scale: 7.5,
              },
            }),
          }
        );

        if (response.ok) {
          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
          imageUrl = `data:image/png;base64,${base64}`;
          usedHF = true;
          console.log('✅ Hugging Face worked!');
        } else {
          const errorText = await response.text();
          console.warn('Hugging Face returned:', response.status, errorText);
        }
      } catch (err) {
        console.warn('Hugging Face failed:', err.message);
      }
    }

    // --- FALLBACK: Use the canvas renderer ---
    if (!imageUrl) {
      console.log('Using fallback pixel renderer...');
      return new Response(JSON.stringify({
        ok: true,
        imageUrl: null,
        fallback: true,
        prompt: enhancedPrompt,
      }), {
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      imageUrl: imageUrl,
      prompt: enhancedPrompt,
      usedHF: usedHF,
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