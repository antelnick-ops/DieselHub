require('dotenv').config({ path: '.env.local' });

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL.replace(/\/$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/chat`;

const sessionId = globalThis.crypto.randomUUID();
const vehicle = {
  year: 2008,
  make: 'Chevrolet',
  model: 'Silverado 2500HD',
  engine: '6.6 Duramax LMM',
};
const userMessage = 'What lift pump should I run on my truck?';

(async () => {
  const startTime = Date.now();

  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ANON_KEY}`,
      'apikey': ANON_KEY,
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      session_id: sessionId,
      messages: [{ role: 'user', content: userMessage }],
      vehicle,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`HTTP ${res.status}: ${text}`);
    process.exit(1);
  }

  if (!res.body) {
    console.error('No response body');
    process.exit(1);
  }

  console.log(`session_id : ${sessionId}`);
  console.log(`vehicle    : ${vehicle.year} ${vehicle.make} ${vehicle.model} (${vehicle.engine})`);
  console.log(`> ${userMessage}\n`);
  console.log('--- Streaming reply ---');

  let firstTokenMs = null;
  let totalChars = 0;
  let doneReceived = false;
  let exitCode = 0;
  let buffer = '';

  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const dataLines = rawEvent
        .split('\n')
        .filter((l) => l.startsWith('data:'));
      if (dataLines.length === 0) continue; // heartbeat (": ping") or empty

      const dataStr = dataLines
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');

      let payload;
      try {
        payload = JSON.parse(dataStr);
      } catch (e) {
        console.error(`\n[parse error] ${e.message}: ${dataStr}`);
        continue;
      }

      if (payload.type === 'text') {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startTime;
        process.stdout.write(payload.content);
        totalChars += payload.content.length;
      } else if (payload.type === 'done') {
        doneReceived = true;
      } else if (payload.type === 'error') {
        console.error(`\n\n[STREAM ERROR] ${payload.message}`);
        exitCode = 1;
      }
    }
  }

  const totalMs = Date.now() - startTime;
  console.log('\n--- End of stream ---\n');
  console.log(`Time to first token : ${firstTokenMs !== null ? firstTokenMs + ' ms' : 'never'}`);
  console.log(`Total time          : ${totalMs} ms`);
  console.log(`Characters streamed : ${totalChars}`);
  console.log(`Done event received : ${doneReceived}`);

  if (!doneReceived && exitCode === 0) {
    console.warn('WARNING: stream ended without a {type:"done"} event');
  }

  process.exit(exitCode);
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
