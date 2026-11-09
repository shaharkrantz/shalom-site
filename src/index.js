const MODEL = "@cf/zai-org/glm-4.7-flash";
const recentRequests = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 4;
const KORACH_WORDS = [
  "קורח", "משה", "אהרן", "דתן", "אבירם", "און בן פלת", "לויים",
  "שבט לוי", "שבט ראובן", "נשיאים", "עדת ישראל", "אוהל מועד",
  "פתח אוהל מועד", "מחתה", "מחתות", "קטורת", "אש", "מאתיים וחמישים איש",
  "מטה", "מטה אהרן", "שנים עשר מטות", "מטה פורח", "שקד", "פרח",
  "ניצן", "אדמה", "האדמה נפתחה", "מגפה", "אהרן עוצר את המגפה",
  "משכן", "מעשר", "תרומה", "מתנות כהונה", "בכורות", "עבודת הלויים",
  "מעשר מן המעשר", "שומרי המשכן", "בני ישראל",
];

function isKorachTopic(topic) {
  const normalized = topic.toLocaleLowerCase("he").replace(/[\\s׳״'"-]/g, "");
  return normalized === "קורח" || normalized === "קרח" ||
    normalized === "פרשתקורח" || normalized === "פרשתקרח";
}

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

function parseModelResponse(result) {
  let payload = result?.response ?? result;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (Array.isArray(payload.words)) return payload;
    const message = payload.choices?.[0]?.message?.content;
    if (typeof message === "string") payload = message;
  }
  if (typeof payload !== "string") throw new Error("AI response has an unexpected shape");

  const clean = payload.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error("AI response was not valid JSON");
  }
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
    if (isKorachTopic(topic)) {
      return json({ topic, words: KORACH_WORDS, players });
    }
    if (!env.AI) {
      return json({ error: "חיבור הבינה המלאכותית עדיין לא הופעל ב־Cloudflare." }, 503);
    }

    try {
      const result = await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content: "אתה מכין משחק בינגו בעברית לילדים בני 8 ו-10. כתוב רק בעברית. צור 32 מילים או צירופים קצרים, נכונים ומדויקים לנושא. התאם את הפריטים לנושא המסוים ולא רק לתחום כללי: אם זה סיפור, פרשה, פרק בספר או אירוע, השתמש רק בדמויות, מקומות, חפצים ומעשים השייכים ישירות לאותו סיפור או פרק. אל תוסיף פריטים מנושאים דומים או מסיפורים אחרים כדי למלא את הרשימה. עבור פרשת קורח, היצמד לבמדבר טז–יח וכלול רק פרטים שמופיעים בפרקים האלה. אם אינך בטוח בפריט, השמט אותו. החזר JSON בלבד במבנה {\"words\":[\"מילה\",\"מילה נוספת\"]}, ללא markdown או הסברים.",
          },
          {
            role: "user",
            content: `צור רשימת מילים לבינגו בנושא: ${topic}`,
          },
        ],
        max_tokens: 1200,
        temperature: 0.2,
      });

      const parsed = parseModelResponse(result);
      if (!Array.isArray(parsed.words)) throw new Error("AI response has no words array");

      const seen = new Set();
      const words = [];
      for (const item of parsed.words) {
        const candidate = typeof item === "string" ? item : item?.word ?? item?.term;
        if (typeof candidate !== "string") continue;
        const word = candidate.trim().replace(/\s+/g, " ");
        const key = word.toLocaleLowerCase("he");
        if (word.length < 2 || word.length > 48 || seen.has(key)) continue;
        seen.add(key);
        words.push(word);
      }
      if (words.length < 20) throw new Error("AI returned fewer than 20 usable words");
      return json({ topic, words: words.slice(0, 40), players });
    } catch (error) {
      console.error("Bingo AI generation failed:", error?.message || "unknown error");
      return json(
        { error: "הבינה המלאכותית לא הצליחה ליצור רשימת מילים תקינה. נסו שוב בעוד רגע." },
        502,
      );
    }
  },
};
