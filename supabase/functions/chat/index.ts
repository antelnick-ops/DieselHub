import "@supabase/functions-js/edge-runtime.d.ts"
import Anthropic from "npm:@anthropic-ai/sdk@0.32.1"

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY") 
    
})

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    })
  }

  try {
    const { message } = await req.json()

    if (!message || typeof message !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'message' field" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: message }],
    })

    // Extract the text from Claude's response
    const reply = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")

    return new Response(
      JSON.stringify({ reply }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    )
  } catch (err) {
    console.error("Chat function error:", err)
    return new Response(
      JSON.stringify({ error: err.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    )
  }
})