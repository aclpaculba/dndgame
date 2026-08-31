import { corsHeaders } from '../_shared/cors.ts';

const HF_API_KEY = Deno.env.get('HF_API_KEY') || '';

// Try different models if one fails
const MODELS = [
  'runwayml/stable-diffusion-v1-5',
  'stabilityai/stable-diffusion-2-1',
  'prompthero/openjourney',
];

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
    let usedModel = '';

    // Try Hugging Face with multiple models
    if (HF_API_KEY && HF_API_KEY.startsWith('hf_')) {
      for (const model of MODELS) {
        try {
          console.log(`🖼️ Trying model: ${model}...`);
          
          const response = await fetch(
            `https://api-inference.huggingface.co/models/${model}`,
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
                  num_inference_steps: 20,
                  guidance_scale: 7.5,
                },
              }),
            }
          );

          console.log(`📡 ${model} response status:`, response.status);

          if (response.ok) {
            const blob = await response.blob();
            console.log(`📦 ${model} blob size:`, blob.size);
            
            if (blob.size > 0) {
              const arrayBuffer = await blob.arrayBuffer();
              const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
              imageUrl = `data:image/png;base64,${base64}`;
              usedModel = model;
              console.log(`✅ ${model} worked! Image size:`, Math.round(blob.size / 1024), 'KB');
              break; // Exit loop on success
            }
          } else if (response.status === 503) {
            // Model is loading - wait and retry once
            console.log(`⏳ ${model} is loading, waiting 3 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Retry once
            const retryResponse = await fetch(
              `https://api-inference.huggingface.co/models/${model}`,
              {
                headers: {
                  'Authorization': `Bearer ${HF_API_KEY}`,
                  'Content-Type': 'application/json',
                },
                method: 'POST',
                body: JSON.stringify({
                  inputs: enhancedPrompt,
                  parameters: {
                    negative_prompt: 'blurry, low quality, distorted, realistic',
                    width: 512,
                    height: 384,
                    num_inference_steps: 20,
                    guidance_scale: 7.5,
                  },
                }),
              }
            );
            
            if (retryResponse.ok) {
              const blob = await retryResponse.blob();
              if (blob.size > 0) {
                const arrayBuffer = await blob.arrayBuffer();
                const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
                imageUrl = `data:image/png;base64,${base64}`;
                usedModel = model;
                console.log(`✅ ${model} worked on retry!`);
                break;
              }
            }
          } else {
            const errorText = await response.text();
            console.warn(`❌ ${model} returned:`, response.status, errorText.slice(0, 200));
          }
        } catch (err) {
          console.warn(`❌ ${model} failed:`, err.message);
        }
      }
    } else {
      console.warn('⚠️ No valid HF_API_KEY found');
    }

    // --- FALLBACK: Use Pollinations as fallback ---
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
            console.log('✅ Pollinations fallback worked!');
          }
        } else {
          console.warn('Pollinations returned:', response.status);
        }
      } catch (err) {
        console.warn('Pollinations fallback failed:', err.message);
      }
    }

    // --- FINAL FALLBACK: Return null for canvas renderer ---
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

    console.log('✅ Returning image URL, used model:', usedModel || 'Pollinations');
    return new Response(JSON.stringify({
      ok: true,
      imageUrl: imageUrl,
      prompt: enhancedPrompt,
      usedModel: usedModel || 'Pollinations',
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