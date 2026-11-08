const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const recentRequests = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 4;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = recentRequests.get(ip) || { start: now, count: 0 };
  if (now - bucket.start >= WINDOW_MS) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  recentRequests.set(ip, bucket);
  if (recentRequests.size > 1000) {
    for (const [key, value] of recentRequests) {
      if (now - value.start >= WINDOW_MS) recentRequests.delete(key);
    }
  }
  return bucket.count > MAX_REQUESTS_PER_WINDOW;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/generate") {
      return json({ error: "הכתובת לא נמצאה." }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "צריך לשלוח בקשת יצירה." }, 405);
    }

    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) {
      return json({ error: "הבקשה לא אושרה." }, 403);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (isRateLimited(ip)) {
      return json({ error: "נוצרו הרבה לוחות בזמן קצר. נסו שוב בעוד דקה." }, 429);
    }

    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > 2048) return json({ error: "הבקשה ארוכה מדי." }, 413);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "לא הצלחנו לקרוא את הבקשה. נסו שוב." }, 400);
    }

    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    const players = Number(body.players);
    if (topic.length < 2 || topic.length > 100) {
      return json({ error: "כתבו נושא באורך 2 עד 100 תווים." }, 400);
    }
    if (!Number.isInteger(players) || players < 1 || players > 50) {
      return json({ error: "אפשר לבחור בין שחקן אחד ל־50 שחקנים." }, 400);
    }
    if (!env.AI) {
      return json({ error: "חיבור הבינה המלאכותית עדיין לא הופעל ב־Cloudflare." }, 503);
    }

    try {
      const result = await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content: "אתה מכין מילים למשחק בינגו לילדים בני 8 ו-10. החזר JSON בלבד במבנה {\"words\":[...]}. כתוב בעברית. צור בדיוק 40 מילים קצרות, שונות זו מזו, ידידותיות לילדים, ומדויקות בנושא שניתן. השתמש במושגים, דמויות, מקומות וחפצים הקשורים ישירות לנושא. אל תוסיף הסברים, סימני ניקוד, מספרים או תוכן אחר.",
          },
          {
            role: "user",
            content: `צור רשימת מילים לבינגו בנושא: ${topic}`,
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 900,
        temperature: 0.5,
      });

      const raw = typeof result?.response === "string" ? result.response : "";
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.words)) throw new Error("Missing words");
      const seen = new Set();
      const words = [];
      for (const item of parsed.words) {
        if (typeof item !== "string") continue;
        const word = item.trim().replace(/\s+/g, " ");
        const key = word.toLocaleLowerCase("he");
        if (word.length < 2 || word.length > 48 || seen.has(key)) continue;
        seen.add(key);
        words.push(word);
      }
      if (words.length < 20) throw new Error("Not enough words");
      return json({ topic, words: words.slice(0, 40), players });
    } catch (error) {
      console.error("Bingo AI generation failed:", error?.message || "unknown error");
      return json(
        { error: "הבינה המלאכותית לא הצליחה להכין מספיק מילים הפעם. נסו שוב או בחרו נושא אחר." },
        502,
      );
    }
  },
};
