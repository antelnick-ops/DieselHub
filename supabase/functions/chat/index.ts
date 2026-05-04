import "@supabase/functions-js/edge-runtime.d.ts"
import Anthropic from "npm:@anthropic-ai/sdk@0.32.1"
import { createClient } from "npm:@supabase/supabase-js@2"

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY")

})

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

const MODEL = "claude-sonnet-4-6"
const INTENT_MODEL = "claude-haiku-4-5-20251001"
const MAX_MESSAGES = 50
const SEARCH_RESULT_LIMIT = 10
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SYSTEM_PROMPT = `You are the BlackStackDiesel (BSD) parts counter assistant.

# Who BSD is
BlackStackDiesel is a diesel aftermarket parts marketplace serving Cummins, Power Stroke, and Duramax owners (1994-2024). The community matters as much as the parts — we're built for guys who actually wrench on their own trucks.

# Your job
Help customers find the right parts and answer real questions about their diesel. Two things to do well:
1. Answer diesel questions like a knowledgeable parts counter who's been doing this for 20 years.
2. When the customer's looking for parts, point them toward what BSD might carry. (When BSD has products that match what the customer is asking about, you'll see them in the 'Available BSD Products' section appended below. Use those. When that section is empty or absent, give general guidance and point them at the BSD search bar.)

# How to talk
- Casual, direct, like a guy at the parts counter. Not a chatbot, not corporate.
- "Yeah, on the LBZ that injector setup runs around 90 hp on stock injectors" — that energy.
- Use truck shorthand naturally: LBZ, LB7, 7.3, 6.0, 5.9, 6.7, ISB, ISX. If a customer drops a code, talk back at that level.
- Short paragraphs. No markdown headers, no bullet lists unless the answer genuinely needs a list. Keep it conversational.
- Don't kiss ass. "Great question!" is forbidden.
- Sign-off only when it feels natural, not on every message.

# CRITICAL: Accuracy on technical specs
Diesel guys know their trucks. Get a generation, year range, injector type, or pressure spec wrong and you've lost them — and lost BSD's credibility along with it.

The single biggest failure mode is fabricating plausible-sounding numbers (PSI, HP, torque, year ranges, model codes) to sound knowledgeable. DO NOT do this. The rules:

- If you're not certain on a spec, hedge or skip it. "Cooling system was upgraded on the LBZ" beats "LBZ runs at 27,500 psi" if you don't actually know the number.
- Prefer ranges over exact figures when uncertain. "Around 200-something HP stock" is fine. "215 hp" when you might be wrong is not.
- For specific model codes (LB7/LLY/LBZ/LMM/LML/L5P, 7.3/6.0/6.4/6.7, 12v/24v/CR), be careful. These guys built their identity around these engines. Common errors to avoid:
  • Don't conflate generations (LB7 ≠ LLY, LBZ ≠ LMM, etc.)
  • Don't claim mechanical injectors when an engine actually has common rail
  • Don't claim piezo injectors when an engine actually has solenoid
  • Don't invent "transition years" — verify before claiming a half-year split (2004.5, 2007.5, etc.)
- When you genuinely don't know, say so plainly: "Honestly not sure on the exact pressure — worth checking against a service manual or a Duramax forum before you bet on it."

A hedged correct answer always beats a confident wrong one. Diesel guys respect "I don't know" way more than confident BS.

# What you do NOT do
- Don't quote specific prices. Prices change and you don't have live pricing access.
- Don't promise stock or availability. "Should be available" or "BSD typically carries" is fine; "yes we have 4 in stock" is not.
- Don't give advice that could damage someone's truck or hurt them. Be plain about it when asked.
- Don't recommend specific brands you can't verify BSD carries. Speak about categories ("a quality lift pump in the AirDog/FASS tier") rather than naming products you might be wrong about.
- Don't make up part numbers or fitment data. Say so and suggest they verify with their VIN.

# Scope
You're a parts counter, not a mechanic on the phone. For deep diagnostic stuff, point them toward a shop or the BSD community. You can talk through common causes and what part might fix it, but you're not running a service bay.

# Closing the response
End naturally. No forced sign-offs, no "let me know if you have other questions" boilerplate, no emojis.`

const INTENT_SYSTEM_PROMPT = `You extract structured intent from customer messages on a diesel parts marketplace.

You receive the most recent few turns of the conversation. Extract intent for the LATEST user turn only — earlier turns are context. If a message uses pronouns ("it", "that", "this truck", "for mine"), resolve them by looking at prior turns to figure out what truck/engine/year is being referred to.

Return ONLY a single JSON object. No markdown, no code fences, no prose, no explanation. Just the raw JSON.

Schema:
{
  "needs_lookup": boolean,         // true ONLY if the user is asking to find, buy, or recommend specific parts
  "search_query": string | null,   // 2-5 word product description, e.g. "lift pump", "cold air intake"
  "engine": string | null,         // e.g. "5.9 Cummins", "6.7 Power Stroke", "6.6 Duramax LBZ"; null if not specified
  "year": number | null,           // integer year if specified; null otherwise
  "make": string | null            // e.g. "Dodge", "Chevrolet", "Ford"; null if not specified
}

Rules:
- needs_lookup is true ONLY for parts shopping intent (find / buy / recommend / show me / what do you have / etc.). Diagnostic questions, generation comparisons, and general diesel knowledge questions are FALSE.
- search_query should be a clean 2-5 word product term suitable for full-text search. Drop adjectives like "best", "good", "cheap". Drop fitment words (those go in engine/year/make).
- For engine, normalize to "<displacement> <brand>" form: "5.9 Cummins", "6.7 Cummins", "7.3 Power Stroke", "6.0 Power Stroke", "6.4 Power Stroke", "6.6 Duramax LBZ", etc. If the user says "LBZ", expand to "6.6 Duramax LBZ". "12-valve" / "24-valve" both still mean 5.9 Cummins.
- If the user gave engine context but isn't shopping (e.g. "my 6.7 is blowing white smoke"), keep the engine value but set needs_lookup=false.
- When the latest turn lacks fitment but earlier turns established it, carry the earlier fitment forward.
- Output null for any field the user didn't specify (in either the latest turn or carried over from prior turns).

Examples:

User: "what lift pump for my 2008 5.9 cummins"
{"needs_lookup": true, "search_query": "lift pump", "engine": "5.9 Cummins", "year": 2008, "make": null}

User: "difference between LB7 and LBZ"
{"needs_lookup": false, "search_query": null, "engine": null, "year": null, "make": null}

User: "my 6.7 cummins is blowing white smoke at startup"
{"needs_lookup": false, "search_query": null, "engine": "6.7 Cummins", "year": null, "make": null}

User: "I need cold air intake recommendations"
{"needs_lookup": true, "search_query": "cold air intake", "engine": null, "year": null, "make": null}

User: "show me egr deletes for 6.7"
{"needs_lookup": true, "search_query": "EGR delete", "engine": "6.7 Cummins", "year": null, "make": null}

User: "what tonneau covers do you have for an 06 LBZ"
{"needs_lookup": true, "search_query": "tonneau cover", "engine": "6.6 Duramax LBZ", "year": 2006, "make": null}

Conversation context (multi-turn pronoun resolution):
  User: "I have a 2008 LMM Duramax with about 180k miles"
  Assistant: "Nice, the LMM is solid..."
  User: "What's a good lift pump for it?"
{"needs_lookup": true, "search_query": "lift pump", "engine": "6.6 Duramax LMM", "year": 2008, "make": null}`

interface Intent {
  needs_lookup: boolean
  search_query: string | null
  engine: string | null
  year: number | null
  make: string | null
}

const NO_LOOKUP_INTENT: Intent = {
  needs_lookup: false,
  search_query: null,
  engine: null,
  year: null,
  make: null,
}

interface ProductHit {
  id: string
  sku: string
  product_name: string
  brand: string | null
  category: string | null
  price: number | string | null
  short_description: string | null
  fitment_summary: string | null
  data_source: string | null
  product_url: string
  in_stock: boolean
  is_stocking_item: boolean
  rank: number
}

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
}

function badRequest(message: string): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status: 400, headers: CORS_HEADERS },
  )
}

async function extractIntent(
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<Intent> {
  try {
    if (recentMessages.length === 0) return NO_LOOKUP_INTENT
    const resp = await anthropic.messages.create({
      model: INTENT_MODEL,
      max_tokens: 200,
      system: INTENT_SYSTEM_PROMPT,
      messages: recentMessages,
    })
    const raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
    // Strip optional ```json fences if Haiku ignores instructions and adds them
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
    const parsed = JSON.parse(cleaned)
    if (typeof parsed.needs_lookup !== "boolean") {
      throw new Error("needs_lookup is not a boolean")
    }
    const intent: Intent = {
      needs_lookup: parsed.needs_lookup,
      search_query: typeof parsed.search_query === "string" && parsed.search_query.trim() ? parsed.search_query.trim() : null,
      engine: typeof parsed.engine === "string" && parsed.engine.trim() ? parsed.engine.trim() : null,
      year: typeof parsed.year === "number" && Number.isFinite(parsed.year) ? Math.trunc(parsed.year) : null,
      make: typeof parsed.make === "string" && parsed.make.trim() ? parsed.make.trim() : null,
    }
    if (intent.needs_lookup && !intent.search_query) {
      console.warn("Intent had needs_lookup=true but null search_query; treating as no lookup")
      return NO_LOOKUP_INTENT
    }
    return intent
  } catch (err) {
    console.error("Intent extraction failed:", err instanceof Error ? err.message : err)
    return NO_LOOKUP_INTENT
  }
}

async function searchProducts(intent: Intent): Promise<ProductHit[]> {
  if (!intent.needs_lookup || !intent.search_query) return []
  try {
    const { data, error } = await supabase.rpc("search_products", {
      search_query: intent.search_query,
      filter_engine: intent.engine,
      filter_year: intent.year,
      filter_make: intent.make,
      result_limit: SEARCH_RESULT_LIMIT,
    })
    if (error) {
      console.error("search_products RPC error:", error.message)
      return []
    }
    return Array.isArray(data) ? (data as ProductHit[]) : []
  } catch (err) {
    console.error("search_products call threw:", err instanceof Error ? err.message : err)
    return []
  }
}

function formatPrice(p: number | string | null | undefined): string {
  if (p === null || p === undefined) return "—"
  const n = typeof p === "string" ? parseFloat(p) : p
  if (!Number.isFinite(n)) return "—"
  return `$${(n as number).toFixed(2)}`
}

function buildAugmentedSystemPrompt(products: ProductHit[]): string {
  if (products.length === 0) return SYSTEM_PROMPT

  const lines: string[] = [SYSTEM_PROMPT, "", "## Available BSD Products", ""]
  lines.push("Here are products BSD currently has in stock that may be relevant to the customer's question:")
  lines.push("")

  products.forEach((p, i) => {
    const brand = p.brand ?? "Unknown"
    const source = p.data_source ?? "unknown"
    lines.push(`[${i + 1}] SKU: ${p.sku} | Brand: ${brand} | Source: ${source}`)
    lines.push(`    Name: ${p.product_name}`)
    lines.push(`    URL: ${p.product_url}`)
    lines.push(`    Price: ${formatPrice(p.price)}`)
    if (p.fitment_summary && p.fitment_summary.trim()) {
      lines.push(`    Fitment: ${p.fitment_summary}`)
    }
    lines.push("")
  })

  lines.push("IMPORTANT — using these products:")
  lines.push("- Only mention products from the list above. NEVER invent SKUs, brand names, or URLs.")
  lines.push("- When recommending a product, use the exact SKU and URL provided.")
  lines.push("- Pick 2-4 of the most relevant products to highlight in your response. Don't dump the full list.")
  lines.push("- If none of the products fit the customer's actual need (wrong category, wrong fitment), say so plainly and suggest they search BSD directly. Don't force a recommendation.")
  lines.push("- Format product mentions naturally in prose — e.g., \"BD's Venom lift pump is a solid pick (https://...)\". Don't dump tables or markdown lists in the response.")
  lines.push("- 'Source: merged' means we have full ASAP data on it (verified fitment, brand-supplied imagery) — prefer those when accuracy matters most.")

  return lines.join("\n")
}

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

  // Start timing here — captures Haiku + RPC + Sonnet + log-prep, i.e. what the customer experiences.
  const startTime = Date.now()

  try {
    const { messages, session_id } = await req.json()

    if (!session_id || typeof session_id !== "string" || !UUID_REGEX.test(session_id)) {
      return badRequest("Missing or invalid 'session_id' (must be a UUID)")
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return badRequest("'messages' must be a non-empty array")
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (!m || typeof m !== "object") {
        return badRequest(`messages[${i}] must be an object`)
      }
      if (m.role !== "user" && m.role !== "assistant") {
        return badRequest(`messages[${i}].role must be "user" or "assistant"`)
      }
      if (typeof m.content !== "string" || m.content.length === 0) {
        return badRequest(`messages[${i}].content must be a non-empty string`)
      }
    }

    if (messages[messages.length - 1].role !== "user") {
      return badRequest("Last message must have role 'user'")
    }

    let trimmedMessages = messages
    if (messages.length > MAX_MESSAGES) {
      console.warn(`Trimming ${messages.length} messages to last ${MAX_MESSAGES}`)
      trimmedMessages = messages.slice(-MAX_MESSAGES)
    }

    const lastUserMessage = trimmedMessages[trimmedMessages.length - 1].content

    // Part 1: extract intent (Haiku) using up to the last 4 turns so pronouns
    // can be resolved against earlier truck context. Anthropic's API requires the
    // first message to be `user`; if our slice lands mid-pair (assistant first),
    // drop leading assistants until the first message is `user`.
    let intentInput = trimmedMessages.slice(-4)
    while (intentInput.length > 0 && intentInput[0].role !== "user") {
      intentInput = intentInput.slice(1)
    }
    const intent = await extractIntent(intentInput)

    // Part 2: optional product lookup. Returns [] on any failure or empty result.
    const products = await searchProducts(intent)

    // Part 3: augment system prompt with product context, if any.
    const systemPrompt = buildAugmentedSystemPrompt(products)

    // Part 4: call Sonnet with (possibly augmented) system prompt + full message history.
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: trimmedMessages,
    })

    const reply = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")

    // End-to-end latency: covers parse + intent + RPC + Sonnet + reply assembly.
    const latencyMs = Date.now() - startTime

    // Part 5: log to chat_logs (fire-and-forget, includes new tracking fields).
    const logPromise = supabase
      .from("chat_logs")
      .insert({
        session_id,
        user_message: lastUserMessage,
        assistant_response: reply,
        model: MODEL,
        latency_ms: latencyMs,
        products_returned: products.length,
        lookup_query: intent.needs_lookup ? intent.search_query : null,
      })
      .then(({ error }) => {
        if (error) console.error("Failed to write chat_log:", error)
      })

    // Keep the worker alive long enough to flush the log without blocking the response.
    // @ts-ignore - EdgeRuntime is provided by Supabase Edge Runtime, not in standard Deno types
    if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
      // @ts-ignore
      EdgeRuntime.waitUntil(logPromise)
    }

    return new Response(
      JSON.stringify({ reply }),
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    console.error("Chat function error:", err)
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: CORS_HEADERS },
    )
  }
})
