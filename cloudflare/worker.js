export default {
  async fetch(req, env, ctx) {
    const h = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: h });
    }

    const url = new URL(req.url);
    const cache = caches.default;

    const BASE_ID = "appZpw3gV2XKhAAOo";
    const OPEN_ACTIONS_TABLE = "tblH6hTkfUMB8KxXk";
    const NOTIFICATIONS_TABLE = "tblJ8B3jw5RM4zakV";

    function json(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { ...h, "Content-Type": "application/json" }
      });
    }

    // jsonCached: same as json() but adds Cache-Control so Cloudflare edge stores it.
    // TTL is in seconds. Cache key is the full request URL (set by caller via cache.put).
    function jsonCached(data, ttl) {
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          ...h,
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${ttl}`
        }
      });
    }

    function airtableHeaders() {
      return {
        "Authorization": "Bearer " + env.AIRTABLE_API_KEY,
        "Content-Type": "application/json"
      };
    }
    // airtableFetch: wraps every outbound Airtable request with a 10-second
    // AbortController timeout. Prevents stalled Airtable connections from
    // accumulating and blocking the Worker indefinitely.
    // Under normal conditions this is invisible — Airtable responds in 1-3s.
    // On stall, the connection is aborted cleanly and the caller's catch block
    // returns an error to the browser immediately.
    function airtableFetch(url, options) {
      const ctrl = new AbortController();
      const timer = setTimeout(function() { ctrl.abort(); }, 10000);
      const opts = Object.assign({}, options || {}, { signal: ctrl.signal });
      return fetch(url, opts).then(
        function(res) { clearTimeout(timer); return res; },
        function(err) { clearTimeout(timer); throw err; }
      );
    }

    // Lightweight per-IP rate limiter for write-heavy endpoints, using the
    // same Cache API already used elsewhere in this Worker — no new
    // infrastructure. 20 requests per 60 seconds per IP per endpoint: high
    // enough that no realistic rep/manager usage pattern could hit it during
    // normal work, low enough to catch a runaway retry loop or repeated abuse.
    // Returns true if the request is allowed to proceed, false if the caller
    // should return 429.
    async function checkRateLimit(endpointName, req) {
      const ip = req.headers.get("cf-connecting-ip") || "unknown";
      const rlKey = new Request("https://ratelimit.internal/" + endpointName + "/" + ip);
      let count = 0;
      try {
        const existing = await cache.match(rlKey);
        if (existing) {
          const data = await existing.json();
          count = data.count || 0;
        }
      } catch (e) { /* cache read failure — fail open, never block on our own error */ }
      if (count >= 20) return false;
      try {
        const newRes = new Response(JSON.stringify({ count: count + 1 }), { headers: { "Cache-Control": "max-age=60" } });
        ctx.waitUntil(cache.put(rlKey, newRes));
      } catch (e) { /* non-fatal — request still proceeds even if we can't record it */ }
      return true;
    }


    function safeFormula(value) {
      return String(value || "").replace(/"/g, '\\"');
    }

    function splitActions(text) {
      if (!text) return [];
      return text
        .split("\n")
        .map(x => x.trim())
        .map(x => x.replace(/^\d+\.\s*/, "").replace(/^[-•*]\s*/, "").trim())
        .filter(x => x.length > 5 && x.length < 300);
    }

    function parseTimeFromText(text) {
      const t = String(text || "");
      const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)\b/);
      if (!m) return "";
      let hh = parseInt(m[1], 10);
      const mm = m[2] ? m[2] : "00";
      const ap = m[3].toLowerCase();
      if (ap === "pm" && hh < 12) hh += 12;
      if (ap === "am" && hh === 12) hh = 0;
      return String(hh).padStart(2, "0") + ":" + mm;
    }

    function parseDateFromText(text) {
      const raw = String(text || "");
      const t = raw.toLowerCase();

      const now = new Date();
      const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

      function iso(d) { return d.toISOString().slice(0, 10); }

      function addDays(n) {
        const d = new Date(base);
        d.setUTCDate(d.getUTCDate() + n);
        return iso(d);
      }

      function validDateUTC(y, mIndex, dNum) {
        const d = new Date(Date.UTC(y, mIndex, dNum));
        if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mIndex || d.getUTCDate() !== dNum) return null;
        return d;
      }

      function nextFutureOrTodayDate(monthIndex, dayNum, explicitYear) {
        let year = explicitYear || base.getUTCFullYear();
        let d = validDateUTC(year, monthIndex, dayNum);
        if (!d) return "";
        if (!explicitYear && d < base) {
          d = validDateUTC(year + 1, monthIndex, dayNum);
          if (!d) return "";
        }
        return iso(d);
      }

      function nextDayOfMonth(dayNum) {
        let year = base.getUTCFullYear();
        let month = base.getUTCMonth();
        let d = validDateUTC(year, month, dayNum);
        if (d && d >= base) return iso(d);
        month += 1;
        if (month > 11) { month = 0; year += 1; }
        d = validDateUTC(year, month, dayNum);
        if (!d) return "";
        return iso(d);
      }

      if (/\btoday\b/.test(t)) return addDays(0);
      if (/\btomorrow\b/.test(t)) return addDays(1);

      const months = {
        jan:0, january:0, feb:1, february:1, mar:2, march:2, apr:3, april:3, may:4,
        jun:5, june:5, jul:6, july:6, aug:7, august:7, sep:8, sept:8, september:8,
        oct:9, october:9, nov:10, november:10, dec:11, december:11
      };
      const monthNames = Object.keys(months).join("|");

      const monthFirst = t.match(new RegExp("\\b(" + monthNames + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b"));
      if (monthFirst) {
        const parsed = nextFutureOrTodayDate(months[monthFirst[1]], parseInt(monthFirst[2], 10), monthFirst[3] ? parseInt(monthFirst[3], 10) : null);
        if (parsed) return parsed;
      }

      const dayFirst = t.match(new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(" + monthNames + ")(?:,?\\s*(\\d{4}))?\\b"));
      if (dayFirst) {
        const parsed = nextFutureOrTodayDate(months[dayFirst[2]], parseInt(dayFirst[1], 10), dayFirst[3] ? parseInt(dayFirst[3], 10) : null);
        if (parsed) return parsed;
      }

      const date1 = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
      if (date1) {
        const dd = parseInt(date1[1], 10);
        const mm = parseInt(date1[2], 10);
        let yy = date1[3] ? parseInt(date1[3], 10) : base.getUTCFullYear();
        if (yy < 100) yy += 2000;
        let d = validDateUTC(yy, mm - 1, dd);
        if (d) {
          if (!date1[3] && d < base) d = validDateUTC(yy + 1, mm - 1, dd);
          if (d) return iso(d);
        }
      }

      // Weekday-name guess — deliberately last. Only reached when no
      // explicit month/day/year, day/month/year, or numeric date pattern
      // was found anywhere in the text, so an explicit date (spoken
      // alongside a weekday name, e.g. "Wednesday, July 8th, 2026") always
      // wins over a same-weekday guess.
      const weekdays = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
      const wd = t.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
      if (wd) {
        const target = weekdays[wd[2]];
        const current = base.getUTCDay();
        let diff = (target - current + 7) % 7;
        if (diff === 0 || wd[1]) diff += 7;
        return addDays(diff);
      }

      const dayOnly = t.match(/\b(?:on|by|for|around|back on|come back on|return on|follow up on|follow-up on)?\s*(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/);
      if (dayOnly) {
        const dayNum = parseInt(dayOnly[1], 10);
        if (dayNum >= 1 && dayNum <= 31) {
          const parsed = nextDayOfMonth(dayNum);
          if (parsed) return parsed;
        }
      }

      return "";
    }

    // Identity verification backing POST /login only. Not called directly
    // by any other endpoint — /ask-fieldiq and /get-rep-briefing trust a
    // verified session token instead (see signSession/verifySession
    // below), never a client-supplied userId+pin. Every other endpoint in
    // this file still trusts a client-supplied userId with no
    // verification — an accepted, pre-existing pattern this fix
    // deliberately does not touch elsewhere in this pass. Deactivated
    // users are rejected even with a correct PIN.
    async function verifyUserCredentials(userId, pin) {
      if (!userId || !pin) return null;
      const params = new URLSearchParams();
      params.append("filterByFormula", `{User ID}="${safeFormula(userId)}"`);
      params.append("maxRecords", "1");
      const res = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Users?${params.toString()}`, { headers: airtableHeaders() });
      const data = await res.json();
      if (!res.ok) return null;
      const rec = data.records && data.records[0];
      if (!rec) {
        console.log(`[login] no matching user record for userId="${userId}"`);
        return null;
      }
      if (rec.fields["Active?"] === false) return null;
      // Defensive trim — Airtable text fields can pick up trailing
      // whitespace from manual entry; this is harmless if the field is
      // already clean and fixes it silently if it isn't.
      const storedPinRaw = rec.fields["PIN"];
      const storedPin = String(storedPinRaw || "").trim();
      if (!storedPin) {
        console.log(`[login] userId="${userId}" has no usable PIN value on record — check the "PIN" field exists and is Single line text, not Number`);
        return null;
      }
      const enteredPin = String(pin).trim();
      const pinMatches = enteredPin === storedPin;
      if (!pinMatches) return null;
      return {
        recordId: rec.id,
        userId: rec.fields["User ID"] || userId,
        role: rec.fields["Role"] || "Sales Rep",
        displayName: String(rec.fields["Display Name"] || userId).trim()
      };
    }

    // ── Session tokens ─────────────────────────────────────────────────
    // Stateless, HMAC-signed. No new Airtable table, no server-side
    // session store — the Worker can verify a token's authenticity and
    // expiry using only the secret it already holds. Format:
    // base64url(payload_json) + "." + base64url(HMAC-SHA256 signature).
    // Any change to the payload (userId, role, anything) invalidates the
    // signature, so a token cannot be edited client-side to change who or
    // what role it claims to represent — this is the actual mechanism
    // that makes "derive identity from the token, never from the
    // request" meaningful rather than just a naming convention.
    //
    // Requires env.SESSION_SECRET to be configured as a real Worker
    // secret before deployment. If it is missing, both signSession and
    // verifySession fail closed (verifySession returns null; signSession
    // throws, which /login's try/catch turns into a 500) rather than
    // silently falling back to a predictable or empty key.
    function _b64urlEncode(bytes) {
      let bin = "";
      bytes.forEach(b => { bin += String.fromCharCode(b); });
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function _b64urlDecodeToString(str) {
      let base64 = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
      const remainder = base64.length % 4;
      if (remainder === 1) {
        throw new Error("Invalid base64url length");
      }
      if (remainder > 0) {
        base64 += "=".repeat(4 - remainder);
      }
      // atob() returns a binary (Latin-1) string, not a UTF-8 string —
      // directly JSON.parsing that output corrupts any non-ASCII
      // character (Arabic names, accented characters, etc). Convert the
      // binary string to raw bytes, then decode those bytes as UTF-8 to
      // correctly reverse what TextEncoder produced on the signing side.
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes);
    }
    async function signSession(payload, secret) {
      if (!secret) throw new Error("SESSION_SECRET not configured");
      const encoder = new TextEncoder();
      const payloadB64 = _b64urlEncode(Array.from(encoder.encode(JSON.stringify(payload))));
      const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
      const sigB64 = _b64urlEncode(Array.from(new Uint8Array(sigBuf)));
      return payloadB64 + "." + sigB64;
    }
    async function verifySession(token, secret) {
      if (!secret || !token || token.indexOf(".") === -1) return null;
      const parts = token.split(".");
      if (parts.length !== 2) return null;
      const [payloadB64, sigB64] = parts;
      const encoder = new TextEncoder();
      try {
        const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const expectedSigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
        const expectedSigB64 = _b64urlEncode(Array.from(new Uint8Array(expectedSigBuf)));
        // Signature must match exactly — this is what makes an altered
        // userId or role in the payload get rejected rather than trusted.
        if (expectedSigB64 !== sigB64) return null;
        const payload = JSON.parse(_b64urlDecodeToString(payloadB64));
        if (!payload || !payload.exp || Date.now() > payload.exp) return null;
        return payload;
      } catch (err) { return null; }
    }
    function getBearerToken(req) {
      const auth = req.headers.get("Authorization") || "";
      const match = auth.match(/^Bearer\s+(.+)$/i);
      return match ? match[1] : "";
    }

    async function findUserRecordIdByUserId(userId) {
      const params = new URLSearchParams();
      params.append("filterByFormula", `{User ID}="${safeFormula(userId)}"`);
      params.append("maxRecords", "1");
      const res = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Users?${params.toString()}`, { headers: airtableHeaders() });
      const data = await res.json();
      if (!res.ok) return null;
      return data.records && data.records[0] ? data.records[0].id : null;
    }

    async function getUserByRecordId(recordId) {
      const res = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Users/${recordId}`, { headers: airtableHeaders() });
      const data = await res.json();
      if (!res.ok) return null;
      return data;
    }

    async function getAction(actionId) {
      const res = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}/${actionId}`, { headers: airtableHeaders() });
      const data = await res.json();
      if (!res.ok) return null;
      return data;
    }

    // GET /get-visits
    // Optional filters: filterByUser (User ID, existing), territory, rep —
    // all plain text fields on Field Visits, filtered server-side via
    // filterByFormula instead of fetching everything and filtering client-side.
    // Account is a linked-record field and is deliberately NOT filterable
    // here — same limitation documented below on /get-actions (ARRAYJOIN
    // returns display names, not record IDs, so FIND-based matching doesn't
    // work). Left exactly as before: no account param, no change in behaviour.
    //
    // Caching: only the fully unfiltered request (no filterByUser/territory/
    // rep) is stored in Cloudflare's edge cache, now for longer (300s instead
    // of 30s). Any filtered request always goes straight to Airtable and is
    // never cached at the edge — this avoids creating a new, unbounded set of
    // cache keys (one per filter combination) that /save-visit's single
    // cache.delete() call would not be able to invalidate.
    if (req.method === "GET" && url.pathname === "/get-visits") {
      const filterByUser = url.searchParams.get("filterByUser");
      const territory = url.searchParams.get("territory");
      const rep = url.searchParams.get("rep");
      const isFiltered = !!(filterByUser || territory || rep);

      // Only the fully unfiltered request is cached — same reasoning as
      // /get-dashboard: caching every filter combination would create an
      // unbounded set of cache keys that the existing invalidation calls
      // in /update-visit and /save-visit (below, targeting this exact
      // bare URL) could never fully clear. Filtered requests (rep-scoped,
      // territory-scoped) always compute fresh, as before.
      if (!isFiltered) {
        const _hit = await cache.match(req);
        if (_hit) return _hit;
      }

      try {
        const fields = [
          "Hospital Name","Visit Date","Territory","Visit Type","Rep Name","User ID",
          "AI Summary","Meeting Notes","Action Items","Outcome","Priority","Latitude",
          "Longitude","Accuracy","New Account","Pending Review","Reviewed","Account","Photo URLs",
          "Visit Thread ID"
        ];

        const formulaParts = [];
        if (filterByUser) formulaParts.push(`{User ID}="${safeFormula(filterByUser)}"`);
        if (territory)    formulaParts.push(`{Territory}="${safeFormula(territory)}"`);
        if (rep)          formulaParts.push(`{Rep Name}="${safeFormula(rep)}"`);
        const combinedFormula = formulaParts.length === 0 ? null
          : formulaParts.length === 1 ? formulaParts[0]
          : `AND(${formulaParts.join(",")})`;

        let allRecords = [], offset = null;
        do {
          const params = new URLSearchParams();
          fields.forEach(f => params.append("fields[]", f));
          params.append("pageSize", "100");
          if (offset) params.append("offset", offset);
          if (combinedFormula) params.append("filterByFormula", combinedFormula);
          params.append("sort[0][field]", "Visit Date");
          params.append("sort[0][direction]", "desc");
          const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits?${params.toString()}`, { method: "GET", headers: airtableHeaders() });
          const data = await response.json();
          if (!response.ok) return json(data, response.status);
          allRecords = allRecords.concat(data.records || []);
          offset = data.offset || null;
        } while (offset);

        if (!isFiltered) {
          // 60s TTL, matching /get-dashboard's already-proven number rather
          // than a longer, untested one — invalidation via /update-visit
          // and /save-visit does the real correctness work; this is a
          // backstop, not the primary guarantee.
          const _res = jsonCached({ records: allRecords }, 60);
          ctx.waitUntil(cache.put(req, _res.clone()));
          return _res;
        }
        return json({ records: allRecords });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // GET /get-dashboard
    // Architectural companion to /get-visits, not a replacement — /get-visits
    // remains the complete, untouched source of truth powering Visit History,
    // Management Radar, Rep Review Report, CSV export, and AI Insights,
    // exactly as before. This endpoint exists only because dashboard.html's
    // KPI/sentiment/rep/territory/Priority-Review/New-Accounts widgets were
    // downloading every visit's full text fields (AI Summary, Meeting Notes,
    // Action Items) just to compute small aggregate numbers, most of it for
    // records that are already reviewed and never render as anything. This
    // computes the same numbers server-side and returns a small JSON instead.
    // No caching — Mark Reviewed must always be reflected on next load.
    // Dashboard aggregation, extracted into a directly-callable function so
    // /ask-fieldiq can use it in-process instead of over the network. Not
    // one line of the logic below was changed by this extraction — only
    // this opening signature and the closing dispatch differ from before.
    async function buildDashboardResponse(req, url) {
      try {
        const repFilter = url.searchParams.get("rep") || "";
        const territoryFilter = url.searchParams.get("territory") || "";
        const priorityFilter = url.searchParams.get("priority") || "";
        const periodFilter = url.searchParams.get("period") || "";
        const isFiltered = !!(repFilter || territoryFilter || priorityFilter || periodFilter);

        // Only the fully unfiltered dashboard load is ever cached — same
        // reasoning as /get-visits's original filtering design: caching
        // every distinct filter combination would create an unbounded set
        // of cache keys that /update-visit's single delete() call below
        // could never fully invalidate. Filtered requests (e.g. a manager
        // viewing one territory) always compute fresh.
        if (!isFiltered) {
          const _hit = await cache.match(req);
          if (_hit) return _hit;
        }

        // ---- Ported verbatim from dashboard.html — do not reimplement ----
        function getSentiment(s) {
          if (!s) return "unknown";
          s = s.toLowerCase();
          var i = s.indexOf("sentiment");
          if (i > -1) {
            var t = s.substring(i, i + 120);
            if (t.indexOf("positive") > -1) return "positive";
            if (t.indexOf("negative") > -1) return "negative";
            if (t.indexOf("neutral") > -1) return "neutral";
          }
          if (s.indexOf("positive") > -1) return "positive";
          if (s.indexOf("negative") > -1) return "negative";
          if (s.indexOf("neutral") > -1) return "neutral";
          return "unknown";
        }
        function normalizeTerritory(raw) {
          var t = (raw || "").trim();
          if (!t) return "Unknown";
          var tu = t.toUpperCase();
          if (tu.indexOf("SAUDI ARABIA") === 0) return "Saudi Arabia";
          if (tu === "UAE") return "UAE";
          if (tu === "QATAR") return "Qatar";
          if (tu === "KUWAIT") return "Kuwait";
          if (tu === "BAHRAIN") return "Bahrain";
          if (tu === "OMAN") return "Oman";
          return t;
        }
        function isReviewed(value) {
          if (value === true) return true;
          if (value === 1) return true;
          if (typeof value === "string") {
            var v = value.trim().toLowerCase();
            return v === "true" || v === "1" || v === "yes";
          }
          return false;
        }
        function getPeriodRange(period) {
          var now = new Date();
          var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          var dayOfWeek = today.getDay();
          var diffToMonday = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
          var thisMonday = new Date(today); thisMonday.setDate(today.getDate() - diffToMonday);
          if (period === "today") return { start: today, end: null };
          if (period === "yesterday") { var yest = new Date(today); yest.setDate(today.getDate() - 1); var yestEnd = new Date(today); yestEnd.setMilliseconds(-1); return { start: yest, end: yestEnd }; }
          if (period === "thisWeek") return { start: thisMonday, end: null };
          if (period === "lastWeek") { var lastMonday = new Date(thisMonday); lastMonday.setDate(thisMonday.getDate() - 7); var lastSunday = new Date(thisMonday); lastSunday.setDate(thisMonday.getDate() - 1); lastSunday.setHours(23, 59, 59, 999); return { start: lastMonday, end: lastSunday }; }
          if (period === "thisMonth") return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null };
          if (period === "lastMonth") { var lm = new Date(now.getFullYear(), now.getMonth() - 1, 1); var lmEnd = new Date(now.getFullYear(), now.getMonth(), 0); lmEnd.setHours(23, 59, 59, 999); return { start: lm, end: lmEnd }; }
          return { start: null, end: null };
        }
        // ---- end ported logic ----

        const fields = [
          "Hospital Name", "Visit Date", "Territory", "Visit Type", "Rep Name",
          "AI Summary", "Meeting Notes", "Action Items", "Outcome", "Priority",
          "New Account", "Pending Review", "Reviewed"
        ];

        let allRecords = [], offset = null;
        do {
          const params = new URLSearchParams();
          fields.forEach(f => params.append("fields[]", f));
          params.append("pageSize", "100");
          if (offset) params.append("offset", offset);
          params.append("sort[0][field]", "Visit Date");
          params.append("sort[0][direction]", "desc");
          const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits?${params.toString()}`, { method: "GET", headers: airtableHeaders() });
          const data = await response.json();
          if (!response.ok) return json(data, response.status);
          allRecords = allRecords.concat(data.records || []);
          offset = data.offset || null;
        } while (offset);

        // Apply the same filters the dashboard's own UI exposes — mirrors
        // getFilteredRecords() in dashboard.html, done server-side instead.
        const periodRange = periodFilter ? getPeriodRange(periodFilter) : null;
        const filtered = allRecords.filter(r => {
          const f = r.fields || {};
          if (repFilter) {
            let repName = (f["Rep Name"] || "").trim();
            repName = repName.charAt(0).toUpperCase() + repName.slice(1).toLowerCase();
            if (repName !== repFilter) return false;
          }
          if (territoryFilter && normalizeTerritory(f["Territory"]) !== territoryFilter) return false;
          if (priorityFilter && f["Priority"] !== priorityFilter) return false;
          if (periodRange && (periodRange.start || periodRange.end)) {
            if (!f["Visit Date"]) return false;
            const vDate = new Date(f["Visit Date"]);
            if (periodRange.start && vDate < periodRange.start) return false;
            if (periodRange.end && vDate > periodRange.end) return false;
          }
          return true;
        });

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const weekRange = getPeriodRange("thisWeek");
        const monthRange = getPeriodRange("thisMonth");

        let todayCount = 0, weekCount = 0, monthCount = 0, newAccountsCount = 0;
        const reps = {}, territories = {};
        const sentCounts = { positive: 0, neutral: 0, negative: 0, unknown: 0 };
        const high = [], medium = [], low = [];
        const newAccountsFeed = [];

        filtered.forEach(r => {
          const f = r.fields || {};
          const sent = getSentiment(f["AI Summary"] || "");
          sentCounts[sent] = (sentCounts[sent] || 0) + 1;

          const vDate = f["Visit Date"] ? new Date(f["Visit Date"]) : null;
          if (vDate) {
            if (vDate >= today) todayCount++;
            if (vDate >= weekRange.start) weekCount++;
            if (vDate >= monthRange.start) monthCount++;
          }

          const isNewAccount = f["New Account"] === true || f["New Account"] === "true" || f["New Account"] === 1 || f["New Account"] === "1";
          const pending = isReviewed(f["Pending Review"]);
          if (isNewAccount && pending) {
            newAccountsCount++;
            newAccountsFeed.push(r);
          }

          let rep = f["Rep Name"] || "Unknown";
          rep = rep.trim();
          rep = rep.charAt(0).toUpperCase() + rep.slice(1).toLowerCase();
          if (!reps[rep]) reps[rep] = { count: 0, lastVisit: null, sentiments: [] };
          reps[rep].count++;
          reps[rep].sentiments.push(sent);
          if (vDate && (!reps[rep].lastVisit || vDate > reps[rep].lastVisit)) reps[rep].lastVisit = vDate;

          const terr = normalizeTerritory(f["Territory"]);
          if (terr !== "Unknown") territories[terr] = (territories[terr] || 0) + 1;

          if (!isReviewed(f["Reviewed"])) {
            const p = f["Priority"] || "";
            if (p === "High") high.push(r);
            else if (p === "Medium") medium.push(r);
            else if (p === "Low") low.push(r);
          }
        });

        const repsArray = Object.keys(reps).map(name => {
          const r = reps[name];
          const dist = r.sentiments.reduce((a, s) => { a[s] = (a[s] || 0) + 1; return a; }, {});
          const topSentiment = Object.keys(dist).sort((a, b) => dist[b] - dist[a])[0] || "unknown";
          return {
            name,
            count: r.count,
            lastVisit: r.lastVisit ? r.lastVisit.toISOString() : null,
            sentiment: topSentiment
          };
        }).sort((a, b) => b.count - a.count);

        const territoriesArray = Object.keys(territories)
          .map(name => ({ name, count: territories[name] }))
          .sort((a, b) => b.count - a.count);

        // Management Radar — ported verbatim from dashboard.html's
        // buildManagementRadar(), computed from the same already-fetched
        // records above (no extra Airtable call). Deliberately keeps the
        // EXACT strict `r.fields["Reviewed"] !== true` check this widget
        // has always used — not the tolerant isReviewed() used elsewhere —
        // since Management Radar's behavior was explicitly protected from
        // changes earlier in this project.
        // Fetch Open Actions once — Source Visit, Status, and Due Date —
        // same pagination pattern already used in /get-watchlist. Open
        // Actions is now the sole source of truth for the follow-up signal
        // below; static Action Items text / Outcome are no longer checked
        // at all for this purpose.
        const actParamsRadar = new URLSearchParams();
        actParamsRadar.append("pageSize", "100");
        ["Source Visit","Status","Due Date","Action Text"].forEach(f => actParamsRadar.append("fields[]", f));
        let allActionsRadar = [], aoffsetRadar = null;
        do {
          if (aoffsetRadar) actParamsRadar.set("offset", aoffsetRadar);
          const res = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}?${actParamsRadar.toString()}`, { headers: airtableHeaders() });
          const data = await res.json();
          if (!res.ok) break; // non-fatal — falls back to showing neither signal below
          allActionsRadar = allActionsRadar.concat(data.records || []);
          aoffsetRadar = data.offset || null;
        } while (aoffsetRadar);
        const todayStr = new Date().toISOString().slice(0, 10);
        // Maps from visit ID to the specific action detail driving the flag
        // (not just a yes/no Set) — this is what lets Manager Home link to
        // and label the actual action, not just the account's latest visit.
        const overdueActionByVisit = new Map();
        const dueTodayActionByVisit = new Map();
        allActionsRadar.forEach(a => {
          if (String(a.fields["Status"] || "Open").toLowerCase() !== "open") return;
          const due = a.fields["Due Date"];
          if (!due) return; // no due date — never treated as overdue/due-today, per explicit instruction
          const dueStr = String(due).slice(0, 10);
          const actionText = String(a.fields["Action Text"] || "").trim();
          (a.fields["Source Visit"] || []).forEach(vid => {
            if (dueStr < todayStr) {
              const existing = overdueActionByVisit.get(vid);
              if (!existing || dueStr < existing.dueDate) overdueActionByVisit.set(vid, { dueDate: dueStr, actionText, actionId: a.id });
            } else if (dueStr === todayStr) {
              if (!dueTodayActionByVisit.has(vid)) dueTodayActionByVisit.set(vid, { dueDate: dueStr, actionText, actionId: a.id });
            }
          });
        });

        const accounts = {};
        filtered.forEach(r => {
          const f = r.fields || {};
          const key = String(f["Hospital Name"] || "Unknown").trim();
          if (!accounts[key]) accounts[key] = { name: key, territory: f["Territory"] || "", visits: [], reps: {}, lastVisit: null, lastVisitRecord: null };
          const acc = accounts[key];
          acc.visits.push(r);
          if (!acc.territory && f["Territory"]) acc.territory = f["Territory"];
          let arep = String(f["Rep Name"] || "Unknown").trim();
          arep = arep.charAt(0).toUpperCase() + arep.slice(1).toLowerCase();
          acc.reps[arep] = true;
          const avDate = f["Visit Date"] ? new Date(f["Visit Date"]) : null;
          if (avDate && !isNaN(avDate) && (!acc.lastVisit || avDate > acc.lastVisit)) { acc.lastVisit = avDate; acc.lastVisitRecord = r; }
        });
        const flagged = [];
        Object.keys(accounts).forEach(key => {
          const acc = accounts[key];
          const evidence = [];
          // Find the specific visit that actually qualifies for each
          // signal — not just "does any visit qualify" — since an account
          // can have multiple visits and only one may be the real trigger
          // (e.g. an older High Priority visit still unreviewed, while a
          // newer visit on the same account is already fine). Picks the
          // most recent qualifying visit when more than one exists.
          let highPriorityHit = null, negativeHit = null;
          acc.visits.forEach(r => {
            const rDate = r.fields["Visit Date"] ? new Date(r.fields["Visit Date"]) : null;
            if (r.fields["Priority"] === "High" && r.fields["Reviewed"] !== true) {
              if (!highPriorityHit || (rDate && rDate > highPriorityHit.date)) highPriorityHit = { visitId: r.id, date: rDate };
            }
            if (r.fields["Outcome"] === "Negative" && r.fields["Reviewed"] !== true) {
              if (!negativeHit || (rDate && rDate > negativeHit.date)) negativeHit = { visitId: r.id, date: rDate };
            }
          });
          const highPriorityUnreviewed = !!highPriorityHit;
          const negativeUnreviewed = !!negativeHit;
          // Find the single most urgent qualifying action across this
          // account's visits — most-overdue wins for overdue (earliest due
          // date), any one wins for due-today since they're equally urgent.
          let overdueHit = null, dueTodayHit = null;
          acc.visits.forEach(r => {
            const ov = overdueActionByVisit.get(r.id);
            if (ov && (!overdueHit || ov.dueDate < overdueHit.detail.dueDate)) overdueHit = { visitId: r.id, detail: ov };
            const dt = dueTodayActionByVisit.get(r.id);
            if (dt && !dueTodayHit) dueTodayHit = { visitId: r.id, detail: dt };
          });
          const followUpOverdue = !!overdueHit;
          const followUpDueToday = !!dueTodayHit;
          const repCount = Object.keys(acc.reps).length;
          if (highPriorityUnreviewed) evidence.push("High Priority visit not reviewed");
          if (negativeUnreviewed) evidence.push("Negative outcome not reviewed");
          if (followUpOverdue) evidence.push("Follow-up overdue");
          if (followUpDueToday) evidence.push("Follow-up due today");
          if (repCount >= 2) evidence.push("Visited by " + repCount + " different reps in the selected period");
          if (evidence.length > 0) {
            flagged.push({
              name: acc.name,
              territory: acc.territory,
              evidence,
              lastVisit: acc.lastVisit ? acc.lastVisit.toISOString() : null,
              score: evidence.length,
              visitId: acc.lastVisitRecord ? acc.lastVisitRecord.id : null,
              highPriorityVisitId: highPriorityHit ? highPriorityHit.visitId : null,
              negativeVisitId: negativeHit ? negativeHit.visitId : null,
              followUpOverdueVisitId: overdueHit ? overdueHit.visitId : null,
              followUpOverdueActionId: overdueHit ? overdueHit.detail.actionId : null,
              followUpOverdueActionText: overdueHit ? overdueHit.detail.actionText : null,
              followUpDueTodayVisitId: dueTodayHit ? dueTodayHit.visitId : null,
              followUpDueTodayActionId: dueTodayHit ? dueTodayHit.detail.actionId : null,
              followUpDueTodayActionText: dueTodayHit ? dueTodayHit.detail.actionText : null
            });
          }
        });
        flagged.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          const ad = a.lastVisit ? new Date(a.lastVisit).getTime() : 0;
          const bd = b.lastVisit ? new Date(b.lastVisit).getTime() : 0;
          return bd - ad;
        });
        const managementRadar = flagged.slice(0, 8);

        const responseBody = {
          kpi: {
            total: filtered.length,
            today: todayCount,
            week: weekCount,
            month: monthCount,
            newAccountsPending: newAccountsCount,
            repCount: Object.keys(reps).length
          },
          sentiment: sentCounts,
          reps: repsArray,
          territories: territoriesArray,
          priorityReview: { high, medium, low },
          newAccountsFeed,
          managementRadar
        };

        if (!isFiltered) {
          // 60s TTL — short enough that a stale KPI/Priority Review/
          // Management Radar view is never plausible for long even if a
          // write somehow bypassed the explicit invalidation in
          // /update-visit below, and long enough to absorb repeat opens
          // within the same short window (the actual case this exists for).
          const _res = jsonCached(responseBody, 60);
          ctx.waitUntil(cache.put(req, _res.clone()));
          return _res;
        }
        return json(responseBody);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // GET /get-dashboard — thin route dispatch, calls the function above
    // directly. Identical behavior to before this refactor from any
    // external caller's perspective.
    if (req.method === "GET" && url.pathname === "/get-dashboard") {
      return await buildDashboardResponse(req, url);
    }

    // GET /get-accounts
    if (req.method === "GET" && url.pathname === "/get-accounts") {
      const _hit = await cache.match(req);
      if (_hit) return _hit;
      try {
        const fields = ["Account Name","Account ID","Territory","City"];
        let allRecords = [], offset = null;
        do {
          const params = new URLSearchParams();
          fields.forEach(f => params.append("fields[]", f));
          params.append("pageSize", "100");
          if (offset) params.append("offset", offset);
          const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Accounts?${params.toString()}`, { method: "GET", headers: airtableHeaders() });
          const data = await response.json();
          if (!response.ok) return json(data, response.status);
          allRecords = allRecords.concat(data.records || []);
          offset = data.offset || null;
        } while (offset);
        const _res = jsonCached({ records: allRecords }, 120);
        ctx.waitUntil(cache.put(req, _res.clone()));
        return _res;
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // GET /validate-session
    // Lets a page confirm an existing localStorage token is still valid
    // before restoring the authenticated UI, without requiring the PIN
    // again. Genuinely lightweight: no Airtable call at all — every field
    // in the response comes directly from the already-verified token
    // payload, which now carries displayName alongside userId/recordId/
    // role since /login signs it in. Identity is never accepted from the
    // client here; there is no request body or query param this endpoint
    // reads at all besides the Authorization header itself.
    if (req.method === "GET" && url.pathname === "/validate-session") {
      if (!(await checkRateLimit("validate-session", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      const token = getBearerToken(req);
      const session = await verifySession(token, env.SESSION_SECRET);
      if (!session) return json({ valid: false }, 401);
      return json({
        valid: true,
        userId: session.userId,
        recordId: session.recordId,
        role: session.role,
        name: session.displayName
      });
    }

    // GET /get-users
    // PIN is deliberately NOT in this field list. This endpoint's response
    // is cached and sent to every browser that loads the sign-in screen —
    // it must never carry a credential. Login verification (POST /login)
    // performs its own separate, uncached Airtable lookup and does not
    // depend on this endpoint's response at all.
    if (req.method === "GET" && url.pathname === "/get-users") {
      const _hit = await cache.match(req);
      if (_hit) return _hit;
      try {
        const fields = ["User ID", "Display Name", "Role", "Territory", "Email", "Active?"];
        const params = new URLSearchParams();
        fields.forEach(f => params.append("fields[]", f));
        const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Users?${params.toString()}`, { method: "GET", headers: airtableHeaders() });
        const data = await response.json();
        if (response.ok) {
          const _res = jsonCached(data, 120);
          ctx.waitUntil(cache.put(req, _res.clone()));
          return _res;
        }
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // GET /get-actions
    // ARRAYJOIN({Assigned Rep}) returns primary field display names, not record IDs.
    // FIND(recordId, ARRAYJOIN(...)) therefore never matches for linked record fields.
    // Fix: restore JavaScript filter. Genuine optimization: start the user record ID
    // lookup in parallel with the first Airtable page fetch via Promise, so both
    // round-trips run concurrently instead of sequentially.
    // GET /get-visit-territory — minimal, single-purpose lookup so Log
    // Visit's Update Mode can resolve territory from the original visit
    // itself (authoritative) rather than only the Account record, which
    // can have Territory blank for some accounts. Same single-record fetch
    // pattern already used for getUserByRecordId.
    if (req.method === "GET" && url.pathname === "/get-visit-territory") {
      const visitId = url.searchParams.get("visitId") || "";
      if (!visitId) return json({ error: "visitId required" }, 400);
      try {
        const res = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits/${visitId}`, { headers: airtableHeaders() });
        const data = await res.json();
        if (!res.ok) return json({ territory: "", visitThreadId: visitId });
        const existingThreadId = data.fields && data.fields["Visit Thread ID"];
        const threadId = existingThreadId || visitId;
        // Backfill: if this visit pre-dates the Visit Thread feature (no
        // Visit Thread ID of its own yet), write its own ID onto itself now
        // — the same self-anchoring /save-visit already does for brand new
        // visits. Without this, a Log Update against an old visit would
        // correctly inherit the original's ID, but the original itself
        // would never carry a matching value, so /get-visit-thread could
        // only ever find the update, never the original.
        if (!existingThreadId) {
          ctx.waitUntil(
            airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits/${visitId}`, {
              method: "PATCH",
              headers: airtableHeaders(),
              body: JSON.stringify({ fields: { "Visit Thread ID": visitId } })
            })
          );
        }
        return json({ territory: (data.fields && data.fields["Territory"]) || "", visitThreadId: threadId });
      } catch (err) {
        return json({ territory: "", visitThreadId: visitId });
      }
    }

    if (req.method === "GET" && url.pathname === "/get-actions") {
      try {
        const userId = url.searchParams.get("userId") || "";
        const role = url.searchParams.get("role") || "";
        const visitId = url.searchParams.get("visitId") || "";
        const status = url.searchParams.get("status") || "Open";

        // Short cache for the read-only load path only — never for a
        // visitId-specific request, since that would create an unbounded
        // set of cache keys /complete-action, /dismiss-action, and
        // /send-reminder could never fully invalidate (same reasoning
        // already used for /get-visits and /get-dashboard). 20s is short
        // enough that a manager never waits meaningfully longer for a
        // change to appear, but long enough to absorb the repeated loads
        // a retry-on-timeout produces — which was the actual cause of the
        // reported intermittent timeouts: this endpoint had no caching at
        // all, and the Open-status query can also trigger a second,
        // sequential fetch of the entire Field Visits table (the
        // inference fallback below) when any action lacks a real link.
        if (!visitId) {
          const _hit = await cache.match(req);
          if (_hit) return _hit;
        }

        const params = new URLSearchParams();
        params.append("pageSize", "100");
        // When visitId is present we want that visit's full action history
        // (Pending, Completed, and Dismissed), so the status filter is
        // intentionally skipped in that case.
        if (!visitId) {
          params.append("filterByFormula", `{Status}="${safeFormula(status)}"`);
        }

        // Start user record ID lookup in parallel with Airtable fetch (rep path only).
        const userRecordIdPromise = (role !== "Manager" && userId)
          ? findUserRecordIdByUserId(userId)
          : Promise.resolve(null);

        let allRecords = [], offset = null;
        do {
          if (offset) params.set("offset", offset);
          const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}?${params.toString()}`, { method: "GET", headers: airtableHeaders() });
          const data = await response.json();
          if (!response.ok) return json(data, response.status);
          allRecords = allRecords.concat(data.records || []);
          offset = data.offset || null;
        } while (offset);

        if (visitId) {
          // Source Visit is a linked-record field — same ARRAYJOIN/FIND
          // limitation documented above for Assigned Rep, so this is
          // filtered client-side rather than via filterByFormula. Not
          // cached: each visit has a unique ID, so caching per-visit would
          // create an unbounded set of cache keys, the same concern already
          // avoided elsewhere in this Worker for filtered/scoped queries.
          allRecords = allRecords.filter(r => (r.fields["Source Visit"] || []).includes(visitId));
          return json({ records: allRecords });
        }

        // Infer a visit link for actions genuinely missing a real Source
        // Visit, so View Visit works identically for reps and managers —
        // this was a real product gap, not just old data to wait out.
        // Enrichment is response-only: never written back to Airtable, so
        // the real stored data stays honest about what's a genuine link
        // versus an inferred one. Only runs the extra fetch when at least
        // one action in this batch actually needs it.
        const linkFieldNames = ["Visit","Field Visit","Visit Record","Visit ID","Visit Record ID","Source Visit","Source Visit ID"];
        function hasLinkedVisit(f) {
          return linkFieldNames.some(n => { const v = f[n]; return Array.isArray(v) ? v.length > 0 : !!v; });
        }
        const needsInference = allRecords.filter(r => !hasLinkedVisit(r.fields || {}));
        if (needsInference.length > 0) {
          const vParams = new URLSearchParams();
          vParams.append("pageSize", "100");
          ["Hospital Name","Visit Date"].forEach(f => vParams.append("fields[]", f));
          let visitsForInference = [], voffsetInf = null;
          do {
            if (voffsetInf) vParams.set("offset", voffsetInf);
            const res = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits?${vParams.toString()}`, { headers: airtableHeaders() });
            const data = await res.json();
            if (!res.ok) break; // non-fatal — affected actions simply keep no visit link
            visitsForInference = visitsForInference.concat(data.records || []);
            voffsetInf = data.offset || null;
          } while (voffsetInf);

          const visitsByHospital = new Map();
          visitsForInference.forEach(v => {
            const hn = String((v.fields || {})["Hospital Name"] || "").trim().toLowerCase();
            const vd = (v.fields || {})["Visit Date"];
            if (!hn || !vd) return;
            if (!visitsByHospital.has(hn)) visitsByHospital.set(hn, []);
            visitsByHospital.get(hn).push({ id: v.id, date: String(vd).slice(0, 10) });
          });

          needsInference.forEach(r => {
            const f = r.fields || {};
            const an = String(f["Account Name"] || "").trim().toLowerCase();
            const created = r.createdTime ? r.createdTime.slice(0, 10) : null;
            if (!an || !created) return;
            const candidates = visitsByHospital.get(an);
            if (!candidates) return;
            let best = null;
            candidates.forEach(v => {
              if (v.date <= created && (!best || v.date > best.date)) best = v;
            });
            if (best) f["Source Visit"] = [best.id];
          });
        }


        if (role !== "Manager") {
          if (!userId) return json({ error: "userId required" }, 400);
          const userRecordId = await userRecordIdPromise;
          if (!userRecordId) return json({ records: [] });
          allRecords = allRecords.filter(r => (r.fields["Assigned Rep"] || []).includes(userRecordId));
        }
        if (!visitId) {
          const _res = jsonCached({ records: allRecords }, 20);
          ctx.waitUntil(cache.put(req, _res.clone()));
          return _res;
        }
        return json({ records: allRecords });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // GET /get-calendar
    // Same parallel optimization as /get-actions.
    if (req.method === "GET" && url.pathname === "/get-calendar") {
      try {
        const userId = url.searchParams.get("userId") || "";
        const role = url.searchParams.get("role") || "Sales Rep";
        const params = new URLSearchParams();
        params.append("pageSize", "100");
        params.append("filterByFormula", `{Status}="Open"`);

        const userRecordIdPromise = (role !== "Manager" && userId)
          ? findUserRecordIdByUserId(userId)
          : Promise.resolve(null);

        let allRecords = [], offset = null;
        do {
          if (offset) params.set("offset", offset);
          const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}?${params.toString()}`, { method: "GET", headers: airtableHeaders() });
          const data = await response.json();
          if (!response.ok) return json(data, response.status);
          allRecords = allRecords.concat(data.records || []);
          offset = data.offset || null;
        } while (offset);

        allRecords = allRecords.filter(r => {
          const due = r.fields && r.fields["Due Date"];
          return due !== undefined && due !== null && String(due).trim() !== "";
        });

        if (role !== "Manager") {
          if (!userId) return json({ error: "userId required" }, 400);
          const userRecordId = await userRecordIdPromise;
          if (!userRecordId) return json({ records: [] });
          allRecords = allRecords.filter(r => Array.isArray(r.fields["Assigned Rep"]) && r.fields["Assigned Rep"].includes(userRecordId));
        }

        allRecords.sort((a, b) => String(a.fields["Due Date"] || "").localeCompare(String(b.fields["Due Date"] || "")));
        return json({ success: true, source: "Open Actions", records: allRecords });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // GET /get-notifications
    if (req.method === "GET" && url.pathname === "/get-notifications") {
      const _hit = await cache.match(req);
      if (_hit) return _hit;
      try {
        const userId = url.searchParams.get("userId");
        if (!userId) return json({ error: "userId required" }, 400);
        const params = new URLSearchParams();
        params.append("pageSize", "100");
        params.append("filterByFormula", `AND({Recipient User ID}="${safeFormula(userId)}", NOT({Is Read}))`);
        const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${NOTIFICATIONS_TABLE}?${params.toString()}`, { method: "GET", headers: airtableHeaders() });
        const data = await response.json();
        if (response.ok) {
          const _res = jsonCached(data, 15);
          ctx.waitUntil(cache.put(req, _res.clone()));
          return _res;
        }
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // GET /get-watchlist
    // Deliberately a separate, standalone endpoint rather than folded into
    // /get-dashboard — watched accounts are expected to be a small,
    // manually-curated list, so this stays isolated and never adds weight
    // to the main dashboard aggregate's already-optimized load path.
    // Groups visits by the real Account linked-record field (not the
    // free-text Hospital Name used elsewhere) since that is the reliable
    // key needed to cross-reference against the Accounts table's Watched
    // By field. Open Action counts are matched via Account Name text —
    // the same convention Management Radar already uses, not a new one.
    if (req.method === "GET" && url.pathname === "/get-watchlist") {
      const repFilter = url.searchParams.get("rep") || "";
      const territoryFilter = url.searchParams.get("territory") || "";
      const priorityFilter = url.searchParams.get("priority") || "";
      const periodFilter = url.searchParams.get("period") || "";
      const isFiltered = !!(repFilter || territoryFilter || priorityFilter || periodFilter);
      if (!isFiltered) {
        const _hit = await cache.match(req);
        if (_hit) return _hit;
      }
      try {
        const accParams = new URLSearchParams();
        accParams.append("pageSize", "100");
        accParams.append("filterByFormula", `LEN({Watched By})>0`);
        let watchedAccounts = [], offset = null;
        do {
          if (offset) accParams.set("offset", offset);
          const res = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Accounts?${accParams.toString()}`, { headers: airtableHeaders() });
          const data = await res.json();
          if (!res.ok) {
            const msg = (data && data.error && data.error.message) || JSON.stringify(data);
            return json({ error: "Accounts lookup failed: " + msg }, res.status);
          }
          watchedAccounts = watchedAccounts.concat(data.records || []);
          offset = data.offset || null;
        } while (offset);

        if (!watchedAccounts.length) {
          const _res = jsonCached({ records: [] }, 30);
          if (!isFiltered) ctx.waitUntil(cache.put(req, _res.clone()));
          return _res;
        }

        const watchedIds = new Set(watchedAccounts.map(a => a.id));

        const visitParams = new URLSearchParams();
        visitParams.append("pageSize", "100");
        ["Hospital Name","Account","Visit Date","Rep Name","Priority","Territory"].forEach(f => visitParams.append("fields[]", f));
        let allVisits = [], voffset = null;
        do {
          if (voffset) visitParams.set("offset", voffset);
          const res = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits?${visitParams.toString()}`, { headers: airtableHeaders() });
          const data = await res.json();
          if (!res.ok) {
            const msg = (data && data.error && data.error.message) || JSON.stringify(data);
            return json({ error: "Visits lookup failed: " + msg }, res.status);
          }
          allVisits = allVisits.concat(data.records || []);
          voffset = data.offset || null;
        } while (voffset);

        // Same four filters /get-dashboard exposes, applied identically —
        // this is the actual fix: Watchlist previously ignored all of them,
        // always showing every watched account regardless of the active
        // filter, while every other widget correctly narrowed.
        function normalizeTerritoryWL(raw) {
          var t = (raw || "").trim();
          if (!t) return "Unknown";
          var tu = t.toUpperCase();
          if (tu.indexOf("SAUDI ARABIA") === 0) return "Saudi Arabia";
          if (tu === "UAE") return "UAE";
          if (tu === "QATAR") return "Qatar";
          if (tu === "KUWAIT") return "Kuwait";
          if (tu === "BAHRAIN") return "Bahrain";
          if (tu === "OMAN") return "Oman";
          return t;
        }
        function getPeriodRangeWL(period) {
          var now = new Date();
          var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          var dayOfWeek = today.getDay();
          var diffToMonday = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
          var thisMonday = new Date(today); thisMonday.setDate(today.getDate() - diffToMonday);
          if (period === "today") return { start: today, end: null };
          if (period === "yesterday") { var yest = new Date(today); yest.setDate(today.getDate() - 1); var yestEnd = new Date(today); yestEnd.setMilliseconds(-1); return { start: yest, end: yestEnd }; }
          if (period === "thisWeek") return { start: thisMonday, end: null };
          if (period === "lastWeek") { var lastMonday = new Date(thisMonday); lastMonday.setDate(thisMonday.getDate() - 7); var lastSunday = new Date(thisMonday); lastSunday.setDate(thisMonday.getDate() - 1); lastSunday.setHours(23, 59, 59, 999); return { start: lastMonday, end: lastSunday }; }
          if (period === "thisMonth") return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null };
          if (period === "lastMonth") { var lm = new Date(now.getFullYear(), now.getMonth() - 1, 1); var lmEnd = new Date(now.getFullYear(), now.getMonth(), 0); lmEnd.setHours(23, 59, 59, 999); return { start: lm, end: lmEnd }; }
          return { start: null, end: null };
        }
        const periodRangeWL = periodFilter ? getPeriodRangeWL(periodFilter) : null;

        const latestByAccount = {};
        allVisits.forEach(v => {
          const f = v.fields || {};
          if (repFilter && String(f["Rep Name"] || "").trim() !== repFilter) return;
          if (territoryFilter && normalizeTerritoryWL(f["Territory"]) !== territoryFilter) return;
          if (priorityFilter && String(f["Priority"] || "") !== priorityFilter) return;
          if (periodRangeWL) {
            const vd = f["Visit Date"] ? new Date(f["Visit Date"]) : null;
            if (!vd || isNaN(vd)) return;
            if (periodRangeWL.start && vd < periodRangeWL.start) return;
            if (periodRangeWL.end && vd > periodRangeWL.end) return;
          }
          const linkedIds = f["Account"] || [];
          linkedIds.forEach(accId => {
            if (!watchedIds.has(accId)) return;
            const d = f["Visit Date"] ? new Date(f["Visit Date"]) : null;
            if (!d || isNaN(d)) return;
            if (!latestByAccount[accId] || d > latestByAccount[accId].date) {
              latestByAccount[accId] = { date: d, visit: v };
            }
          });
        });

        const actParams = new URLSearchParams();
        actParams.append("pageSize", "100");
        actParams.append("filterByFormula", `{Status}="Open"`);
        let allActions = [], aoffset = null;
        do {
          if (aoffset) actParams.set("offset", aoffset);
          const res = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}?${actParams.toString()}`, { headers: airtableHeaders() });
          const data = await res.json();
          if (!res.ok) {
            const msg = (data && data.error && data.error.message) || JSON.stringify(data);
            return json({ error: "Open Actions lookup failed: " + msg }, res.status);
          }
          allActions = allActions.concat(data.records || []);
          aoffset = data.offset || null;
        } while (aoffset);

        const records = watchedAccounts
          .filter(acc => !isFiltered || latestByAccount[acc.id])
          .map(acc => {
            const accountName = acc.fields["Account Name"] || "Unknown Account";
            const latest = latestByAccount[acc.id];
            const openCount = allActions.filter(a => String(a.fields["Account Name"] || "").trim() === String(accountName).trim()).length;
            return {
              id: acc.id,
              accountName,
              territory: acc.fields["Territory"] || "",
              lastVisit: latest ? latest.date.toISOString() : null,
              lastRep: latest ? (latest.visit.fields["Rep Name"] || "") : "",
              priority: latest ? (latest.visit.fields["Priority"] || "") : "",
              visitId: latest ? latest.visit.id : null,
              openActionCount: openCount
            };
          });

        const _res = jsonCached({ records }, 30);
        if (!isFiltered) ctx.waitUntil(cache.put(req, _res.clone()));
        return _res;
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // GET /get-account-updates
    // Returns Account Updates for a single account, newest first. Filters
    // by Account Name (text) rather than the Account linked-record field —
    // ARRAYJOIN() on a linked-record field returns display names, not
    // record IDs, so FIND()-based matching against a passed-in record ID
    // would silently never match (same limitation already documented for
    // /get-actions and /get-watchlist elsewhere in this file). Not cached
    // for this account-specific case, matching the same reasoning already
    // used for visitId-specific /get-actions requests.
    if (req.method === "GET" && url.pathname === "/get-account-updates") {
      try {
        const accountName = url.searchParams.get("accountName") || "";
        if (!accountName) return json({ error: "accountName required" }, 400);
        const params = new URLSearchParams();
        params.append("pageSize", "50");
        params.append("filterByFormula", `{Account Name}="${safeFormula(accountName)}"`);
        params.append("sort[0][field]", "Created Date");
        params.append("sort[0][direction]", "desc");
        let allRecords = [], offset = null;
        do {
          if (offset) params.set("offset", offset);
          const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Account%20Updates?${params.toString()}`, { method: "GET", headers: airtableHeaders() });
          const data = await response.json();
          if (!response.ok) return json(data, response.status);
          allRecords = allRecords.concat(data.records || []);
          offset = data.offset || null;
        } while (offset);
        return json({ records: allRecords });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // GET /get-visit-thread
    // Returns every Field Visit sharing the given Visit Thread ID, oldest
    // first — the original visit plus every Log Update that joined it.
    // Not cached — a distinct cache key per thread would be unbounded and
    // /save-visit has no way to invalidate a specific thread's entry.
    if (req.method === "GET" && url.pathname === "/get-visit-thread") {
      try {
        const threadId = url.searchParams.get("threadId") || "";
        if (!threadId) return json({ error: "threadId required" }, 400);
        const params = new URLSearchParams();
        params.append("pageSize", "50");
        const formula = `OR({Visit Thread ID}="${safeFormula(threadId)}",RECORD_ID()="${safeFormula(threadId)}")`;
        params.append("filterByFormula", formula);
        params.append("sort[0][field]", "Visit Date");
        params.append("sort[0][direction]", "asc");
        let allRecords = [], offset = null;
        do {
          if (offset) params.set("offset", offset);
          const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits?${params.toString()}`, { method: "GET", headers: airtableHeaders() });
          const data = await response.json();
          if (!response.ok) return json(data, response.status);
          allRecords = allRecords.concat(data.records || []);
          offset = data.offset || null;
        } while (offset);
        return json({ records: allRecords });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // Rep briefing data aggregation, extracted into a directly-callable
    // function so /rep-daily-briefing can use it in-process instead of
    // over the network — same fix as buildDashboardResponse above, same
    // reasoning: a Worker self-fetching its own public URL was never
    // actually verifiable from a sandbox with no access to real
    // Cloudflare infrastructure, and if it fails, it fails every time.
    // Not one line of logic below was changed by this extraction — only
    // the signature (now takes the already-verified session directly)
    // and the closing dispatch differ from before.
    async function buildRepBriefingData(session, localDateStr) {
      const userRecordId = session.recordId;

      const actParams = new URLSearchParams();
      actParams.append("pageSize", "100");
      actParams.append("filterByFormula", `{Status}="Open"`);
      let allActions = [], offset = null;
      do {
        if (offset) actParams.set("offset", offset);
        const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}?${actParams.toString()}`, { method: "GET", headers: airtableHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error("Airtable request failed: " + JSON.stringify(data));
        allActions = allActions.concat(data.records || []);
        offset = data.offset || null;
      } while (offset);

      const repActions = allActions.filter(r => (r.fields["Assigned Rep"] || []).includes(userRecordId));

      // "Today" is the rep's own local calendar date when the caller
      // supplies one (validated YYYY-MM-DD from the browser), never the
      // Worker's own UTC clock. A rep in Dubai, Sydney, or São Paulo near
      // midnight local time was previously getting overdue/due-today/
      // this-week classifications based on a completely different day
      // than the one they were actually looking at. Falls back to the
      // Worker's UTC date only when no local date is supplied at all —
      // this is what keeps /get-rep-briefing's existing behavior exactly
      // unchanged, since that route doesn't currently collect a local
      // date from its caller and this fix does not add that query.
      const todayStr = (localDateStr && /^\d{4}-\d{2}-\d{2}$/.test(localDateStr)) ? localDateStr : new Date().toISOString().slice(0, 10);
      const dueToday = [], overdue = [], otherOpen = [];
      repActions.forEach(r => {
        const due = r.fields["Due Date"] ? String(r.fields["Due Date"]).slice(0, 10) : "";
        const entry = {
          id: r.id,
          accountName: r.fields["Account Name"] || "Unknown Account",
          actionText: r.fields["Action Text"] || "",
          dueDate: r.fields["Due Date"] || null
        };
        if (due && due < todayStr) overdue.push(entry);
        else if (due && due === todayStr) dueToday.push(entry);
        else otherOpen.push(entry);
      });

      let unacknowledgedNotes = [];
      if (repActions.length) {
        const idFormulas = repActions.map(r => `{Action ID}="${safeFormula(r.id)}"`);
        const notesParams = new URLSearchParams();
        notesParams.append("pageSize", "50");
        notesParams.append("filterByFormula", `AND(NOT({Acknowledged}),OR(${idFormulas.join(",")}))`);
        notesParams.append("sort[0][field]", "Created Date");
        notesParams.append("sort[0][direction]", "desc");
        let noteOffset = null;
        const actionsById = {};
        repActions.forEach(r => { actionsById[r.id] = r; });
        do {
          if (noteOffset) notesParams.set("offset", noteOffset);
          const noteRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Manager%20Notes?${notesParams.toString()}`, { method: "GET", headers: airtableHeaders() });
          const noteData = await noteRes.json();
          if (!noteRes.ok) break; // non-fatal — briefing still returns actions even if notes lookup fails
          (noteData.records || []).forEach(n => {
            const linkedAction = actionsById[n.fields["Action ID"]];
            unacknowledgedNotes.push({
              id: n.id,
              actionId: n.fields["Action ID"],
              notes: n.fields["Notes"] || "",
              createdBy: n.fields["Created By"] || "Manager",
              accountName: linkedAction ? (linkedAction.fields["Account Name"] || "Unknown Account") : "Unknown Account"
            });
          });
          noteOffset = noteData.offset || null;
        } while (noteOffset);
      }

      // Weekly completion stat. Prefers a genuine completion timestamp
      // when one exists on a record, checked in JS rather than gambled
      // on inside the Airtable filterByFormula — referencing a field
      // name that turns out not to exist would error the entire query,
      // not just this one stat, so this checks for it defensively
      // instead of assuming a specific name. Falls back to Due Date
      // (the previous proxy) only for records where none of these
      // plausible field names are present at all.
      const COMPLETION_TIMESTAMP_FIELD_CANDIDATES = ["Completed At", "Completed Date", "Date Completed", "Completion Date"];
      function getCompletionDateStr(fields) {
        for (const fieldName of COMPLETION_TIMESTAMP_FIELD_CANDIDATES) {
          if (fields[fieldName]) {
            const d = String(fields[fieldName]).slice(0, 10);
            if (d) return d;
          }
        }
        return fields["Due Date"] ? String(fields["Due Date"]).slice(0, 10) : null;
      }
      // 6 calendar days before the SAME local todayStr established above
      // — pure date-string arithmetic on the local date, not a second,
      // independent UTC computation via Date.now(). This is what makes
      // "this week" mean the same thing here as it does for overdue/
      // due-today above, rather than two different clocks disagreeing
      // with each other inside the same response.
      const weekAgoDateObj = new Date(todayStr + "T00:00:00Z");
      weekAgoDateObj.setUTCDate(weekAgoDateObj.getUTCDate() - 6);
      const weekAgoStr = weekAgoDateObj.toISOString().slice(0, 10);
      const completedParams = new URLSearchParams();
      completedParams.append("pageSize", "100");
      completedParams.append("filterByFormula", `{Status}="Completed"`);
      let completedThisWeek = 0;
      try {
        let compOffset = null;
        do {
          if (compOffset) completedParams.set("offset", compOffset);
          const compRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}?${completedParams.toString()}`, { method: "GET", headers: airtableHeaders() });
          const compData = await compRes.json();
          if (!compRes.ok) break; // non-fatal — briefing still returns without the weekly stat
          (compData.records || []).forEach(r => {
            if (!(r.fields["Assigned Rep"] || []).includes(userRecordId)) return;
            const dateStr = getCompletionDateStr(r.fields);
            if (dateStr && dateStr >= weekAgoStr) completedThisWeek++;
          });
          compOffset = compData.offset || null;
        } while (compOffset);
      } catch (e) { /* non-fatal — weekly stat is a nice-to-have, not core */ }
      // "This week" on the open side must mean the same thing it means on
      // the completed side: due within the trailing 7-day window, not
      // "overdue by any amount." overdue.length previously counted every
      // open overdue action regardless of how long ago it became overdue
      // — an action overdue for three months was counted identically to
      // one that became overdue yesterday, inflating the denominator with
      // actions that don't actually belong to "this week" at all.
      const openThisWeek = overdue.filter(a => a.dueDate && String(a.dueDate).slice(0, 10) >= weekAgoStr).length + dueToday.length;
      const totalThisWeek = completedThisWeek + openThisWeek;

      return { dueToday, overdue, otherOpen, unacknowledgedNotes, completedThisWeek, totalThisWeek };
    }

    // GET /get-rep-briefing
    // Thin route dispatch — identical behavior to before this refactor
    // from any external caller's perspective. Requires a valid session
    // token (Authorization: Bearer <token>), issued only by POST /login.
    // Identity comes ENTIRELY from the verified token payload — there is
    // no userId parameter of any kind on this request, so there is no
    // field left for a caller to tamper with to request someone else's
    // data.
    if (req.method === "GET" && url.pathname === "/get-rep-briefing") {
      if (!(await checkRateLimit("get-rep-briefing", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const token = getBearerToken(req);
        const session = await verifySession(token, env.SESSION_SECRET);
        if (!session) return json({ error: "Invalid or expired session. Please sign in again." }, 401);
        const data = await buildRepBriefingData(session);
        return json(data);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // GET /rep-daily-briefing
    // The Rep Assistant's actual "what should I do first" guidance.
    // Calls buildRepBriefingData directly, in-process — no self-fetch.
    //
    // v2: structured presentation, not a single AI-written paragraph.
    // Every section (Today's Priorities, Upcoming/Tomorrow, This Week,
    // Watchlist) is built here in plain code from the exact same fields
    // buildRepBriefingData already returns — no new data retrieval, no
    // new Airtable query, nothing beyond what v1 already fetched. This
    // makes "never invents" a structural guarantee rather than a prompt
    // instruction that could be quietly violated: the account names, due
    // dates, and action text in every bullet are copied directly from
    // real records, never generated. The single Anthropic call remaining
    // is scoped to ONE short opening sentence built only from counts
    // (never given an account name or action detail to work with), so
    // even a model that ignored its instructions entirely could not
    // fabricate a specific claim — it has nothing specific to fabricate.
    //
    // Time-of-day framing (morning/afternoon/evening) is driven entirely
    // by the rep's own local time, passed from the browser as localHour/
    // localDate — never the Worker's own UTC clock, which would
    // misjudge evening for anyone outside UTC. This is presentation
    // input only: it changes how the same fetched data is grouped and
    // labeled, never what gets fetched.
    function withPeriod(s) { s = String(s || "").trim(); if (!s) return s; return /[.!?]$/.test(s) ? s : s + "."; }
    if (req.method === "GET" && url.pathname === "/rep-daily-briefing") {
      if (!(await checkRateLimit("rep-daily-briefing", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const token = getBearerToken(req);
        const session = await verifySession(token, env.SESSION_SECRET);
        if (!session) return json({ error: "Invalid or expired session. Please sign in again." }, 401);

        const localHourParam = parseInt(url.searchParams.get("localHour"), 10);
        const localHour = (!isNaN(localHourParam) && localHourParam >= 0 && localHourParam <= 23) ? localHourParam : new Date().getUTCHours();
        const localDateParam = url.searchParams.get("localDate") || "";
        const localDateStr = /^\d{4}-\d{2}-\d{2}$/.test(localDateParam) ? localDateParam : new Date().toISOString().slice(0, 10);
        let timeContext = "morning";
        if (localHour >= 18 || localHour < 5) timeContext = "evening";
        else if (localHour >= 12) timeContext = "afternoon";
        const tomorrowDateObj = new Date(localDateStr + "T00:00:00Z");
        tomorrowDateObj.setUTCDate(tomorrowDateObj.getUTCDate() + 1);
        const tomorrowStr = tomorrowDateObj.toISOString().slice(0, 10);

        const briefing = await buildRepBriefingData(session, localDateStr);

        const overdue = briefing.overdue || [];
        const dueToday = briefing.dueToday || [];
        const otherOpenAll = briefing.otherOpen || [];
        const notes = briefing.unacknowledgedNotes || [];

        // "Tomorrow" is a filter over the same otherOpen data
        // buildRepBriefingData already returned — no new query.
        const tomorrowItems = otherOpenAll.filter(a => a.dueDate && String(a.dueDate).slice(0, 10) === tomorrowStr);
        const laterItems = otherOpenAll.filter(a => a.dueDate && String(a.dueDate).slice(0, 10) > tomorrowStr).slice(0, 5);

        function navFor(actionId) {
          return { label: "Open Actions", url: "./fieldiq-open-actions.html?actionId=" + encodeURIComponent(actionId) };
        }
        function bulletFromAction(a) {
          return { text: a.accountName + " — " + withPeriod(a.actionText || "No detail recorded").replace(/\.$/, ""), actionId: a.id, dueDate: a.dueDate, nav: navFor(a.id) };
        }

        const sections = [];

        if (timeContext !== "evening") {
          const priorityItems = overdue.concat(dueToday).slice(0, 3).map(bulletFromAction);
          sections.push({
            icon: "🎯",
            title: timeContext === "afternoon" ? "What's Left Today" : "Today's Priorities",
            items: priorityItems.length ? priorityItems : [{ text: "Nothing overdue or due today.", actionId: null, nav: null }]
          });
        }

        const upcomingSource = timeContext === "evening" ? tomorrowItems : laterItems;
        sections.push({
          icon: "📅",
          title: timeContext === "evening" ? "Tomorrow" : "Upcoming Visits",
          items: upcomingSource.length ? upcomingSource.map(bulletFromAction) : [{ text: timeContext === "evening" ? "Nothing scheduled for tomorrow yet." : "Nothing else scheduled soon.", actionId: null, nav: null }]
        });

        // Plain factual lines, entirely code-generated from numbers
        // buildRepBriefingData already computed — no AI involved here.
        const weekItems = [];
        if (typeof briefing.completedThisWeek === "number" && typeof briefing.totalThisWeek === "number" && briefing.totalThisWeek > 0) {
          weekItems.push({ text: briefing.completedThisWeek + " of " + briefing.totalThisWeek + " actions completed this week.", actionId: null, nav: null });
        }
        weekItems.push({ text: overdue.length ? overdue.length + " overdue follow-up" + (overdue.length !== 1 ? "s" : "") + "." : "No overdue follow-ups.", actionId: null, nav: null });
        sections.push({ icon: "\u2705", title: "This Week", items: weekItems });

        // The ONLY genuinely conditional section — omitted entirely when
        // there is nothing to flag, never shown empty.
        if (notes.length) {
          sections.push({
            icon: "\u26A0\uFE0F",
            title: "Watchlist",
            items: notes.slice(0, 3).map(n => ({ text: "Manager note on " + n.accountName + " \u2014 review it.", actionId: n.actionId, nav: n.actionId ? navFor(n.actionId) : null }))
          });
        }

        function withPeriodTop(s) { s = String(s || "").trim(); if (!s) return s; return /[.!?]$/.test(s) ? s : s + "."; }

        // Every state the summary must reconcile before it's allowed to
        // say anything resembling "all clear." otherOpenAll already
        // covers everything not overdue/due-today (buildRepBriefingData's
        // three buckets are mutually exclusive and exhaustive), so
        // splitting it into tomorrow / later / undated accounts for every
        // open action without double-counting or dropping any.
        const laterItemsForState = otherOpenAll.filter(a => a.dueDate && String(a.dueDate).slice(0, 10) > tomorrowStr);
        const undatedItems = otherOpenAll.filter(a => !a.dueDate);
        const totalOpenCount = overdue.length + dueToday.length + tomorrowItems.length + laterItemsForState.length + undatedItems.length;

        // Deterministic, truthful by construction — this is both the
        // no-AI-needed fast path and the fallback if synthesis fails, so
        // it alone must never be capable of contradicting the Open
        // Actions count the way the old one-liner could.
        function buildDeterministicRepTopLine() {
          if (timeContext === "evening") {
            if (totalOpenCount === 0) return "You're fully caught up \u2014 no open actions right now.";
            if (tomorrowItems.length > 0) {
              return "You have " + tomorrowItems.length + " item" + (tomorrowItems.length !== 1 ? "s" : "") + " due tomorrow, and " + totalOpenCount + " open action" + (totalOpenCount !== 1 ? "s" : "") + " in total.";
            }
            return "Nothing is due tomorrow, but you still have " + totalOpenCount + " open action" + (totalOpenCount !== 1 ? "s" : "") + (undatedItems.length > 0 ? ", " + undatedItems.length + " with no due date set." : ".");
          }
          if (totalOpenCount === 0) return "You're fully caught up \u2014 no open actions right now.";
          if (overdue.length > 0) {
            return "You have " + overdue.length + " overdue action" + (overdue.length !== 1 ? "s" : "") + " \u2014 start there" +
              (totalOpenCount > overdue.length ? ", then work through the rest of your " + totalOpenCount + " open actions." : ".");
          }
          if (dueToday.length > 0) {
            const restCount = totalOpenCount - dueToday.length;
            return dueToday.length + " action" + (dueToday.length !== 1 ? "s" : "") + " due today" +
              (restCount > 0 ? ", plus " + restCount + " other open action" + (restCount !== 1 ? "s" : "") + " that aren't due yet." : ".");
          }
          // Nothing overdue, nothing due today — but NOT all clear unless
          // totalOpenCount is genuinely zero, which was already handled
          // above.
          let line = "Nothing is overdue or due today, but " + totalOpenCount + " action" + (totalOpenCount !== 1 ? "s are" : " is") + " still open.";
          if (undatedItems.length > 0) line += " " + undatedItems.length + " " + (undatedItems.length !== 1 ? "have" : "has") + " no due date set.";
          return line;
        }

        // Bounded synthesis — same philosophy as the manager agent's
        // reasoning layer: real, verified facts in, a short piece of
        // field-sales advice out, with the same hard ban on inventing
        // anything the digest doesn't state. This is what the deterministic
        // line above falls back to when synthesis fails, so a synthesis
        // outage degrades to "still truthful" rather than "blank" or,
        // worse, "confidently wrong."
        async function synthesizeRepAdvice(factsDigest, env) {
          if (!factsDigest || !factsDigest.trim()) return null;
          const prompt = `You are a field-sales personal assistant speaking directly to a rep, second person. You are not a report generator \u2014 you tell the rep where they stand and what you'd do next, in a short natural paragraph.

These are the ONLY facts you may use. Reason from them, but only from them.

FACTS:
${factsDigest}

Hard rules, no exceptions:
- Never say "all clear," "no pending items," "nothing outstanding," or similar UNLESS the facts show zero open actions of every kind (overdue, due today, due tomorrow, due later, and undated).
- If any open actions exist at all, you must explicitly acknowledge that they exist, even if none are urgent \u2014 do not let a calm tone imply nothing is left.
- Treat overdue, due today, due tomorrow, due later, and undated open actions as different states \u2014 do not blur them together into one vague claim.
- Never invent customer intent, deal value, sales stage, procurement issues, urgency not supported by dates or priority, or motives. You have none of that data.

Write 2 to 3 short sentences, plain English, no markdown, no headings, no bullet points. Include one practical recommendation only if the facts genuinely support one (for example: review an undated action, or consider bringing forward a later one during a quiet stretch) \u2014 do not force a recommendation if there's nothing meaningful to suggest.

Keep the whole answer under 55 words.`;
          try {
            const synRes = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
              body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 150, messages: [{ role: "user", content: prompt }] })
            });
            const synData = await synRes.json();
            if (synRes.ok && synData.content && synData.content[0] && synData.content[0].text) {
              return synData.content[0].text.trim();
            }
            console.log(`[rep-daily-briefing-debug] synthesis returned no usable content, status=${synRes.status}`);
            return null;
          } catch (e) {
            console.log(`[rep-daily-briefing-debug] synthesis call failed: ${e.message}`);
            return null;
          }
        }

        let topLine, usedFallback = false;
        const deterministicTopLine = buildDeterministicRepTopLine();
        if (totalOpenCount === 0 && !notes.length && timeContext !== "evening") {
          // Genuinely nothing to reason over — skip the API call
          // entirely rather than ask the model to manufacture something
          // to say.
          topLine = deterministicTopLine;
        } else {
          const factsDigestLines = [
            "TIME OF DAY: " + timeContext,
            "OVERDUE COUNT: " + overdue.length,
            "DUE TODAY COUNT: " + dueToday.length,
            "DUE TOMORROW COUNT: " + tomorrowItems.length,
            "DUE LATER COUNT: " + laterItemsForState.length,
            "OPEN WITH NO DUE DATE COUNT: " + undatedItems.length,
            "TOTAL OPEN ACTIONS: " + totalOpenCount,
            "UNACKNOWLEDGED MANAGER NOTES: " + notes.length
          ];
          if (typeof briefing.completedThisWeek === "number" && typeof briefing.totalThisWeek === "number" && briefing.totalThisWeek > 0) {
            factsDigestLines.push("COMPLETED THIS WEEK: " + briefing.completedThisWeek + " of " + briefing.totalThisWeek);
          }
          const synthesized = await synthesizeRepAdvice(factsDigestLines.join("\n"), env);
          if (synthesized) {
            topLine = synthesized;
          } else {
            topLine = deterministicTopLine;
            usedFallback = true;
          }
        }

        const greetingPrefix = timeContext === "morning" ? "Good morning" : (timeContext === "afternoon" ? "Good afternoon" : "Good evening");
        return json({
          greeting: greetingPrefix + ", " + String(session.displayName || "there").trim() + ".",
          timeContext: timeContext,
          topLine: topLine,
          sections: sections,
          usedFallback: usedFallback
        });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // GET /get-notes
    // Returns Manager Notes (coaching, not customer interactions) for a
    // single Open Action, newest first. Fully separate feature — never
    // touches Field Visits, /save-visit, Visit Thread ID, KPIs, or
    // Reputation. Filters via a plain text "Action ID" field, not a linked
    // record field — same ARRAYJOIN/FIND limitation already documented
    // elsewhere in this file for linked-record fields; Manager Notes has
    // no linked-record field of its own, by design. Not cached — same
    // reasoning as /get-account-updates: this is a single-action-specific
    // lookup, and caching per-action would create an unbounded set of
    // cache keys /save-note could never fully invalidate.
    if (req.method === "GET" && url.pathname === "/get-notes") {
      try {
        const actionId = url.searchParams.get("actionId") || "";
        if (!actionId) return json({ error: "actionId required" }, 400);
        const params = new URLSearchParams();
        params.append("pageSize", "50");
        params.append("filterByFormula", `{Action ID}="${safeFormula(actionId)}"`);
        params.append("sort[0][field]", "Created Date");
        params.append("sort[0][direction]", "desc");
        let allRecords = [], offset = null;
        do {
          if (offset) params.set("offset", offset);
          const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Manager%20Notes?${params.toString()}`, { method: "GET", headers: airtableHeaders() });
          const data = await response.json();
          if (!response.ok) return json(data, response.status);
          allRecords = allRecords.concat(data.records || []);
          offset = data.offset || null;
        } while (offset);
        return json({ records: allRecords });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    if (req.method !== "POST" && req.method !== "PATCH") {
      return new Response("Method not allowed", { status: 405, headers: h });
    }

    // POST /login
    // The only place PIN verification happens now. Replaces the old
    // client-side comparison entirely — the browser never receives a PIN
    // to compare against, from this endpoint or any other. On success,
    // returns a signed, time-limited session token; the raw PIN is never
    // echoed back in the response. Rate-limited like every write endpoint,
    // since this is now the actual authentication boundary and deserves
    // at least that much protection against repeated PIN guessing.
    if (req.method === "POST" && url.pathname === "/login") {
      if (!(await checkRateLimit("login", req))) return json({ error: "Too many attempts. Please wait a moment and try again." }, 429);
      try {
        const body = await req.json();
        const userId = String(body.userId || "").trim();
        const pin = String(body.pin || "").trim();
        if (!userId || !pin) return json({ error: "userId and pin required" }, 400);

        const verified = await verifyUserCredentials(userId, pin);
        if (!verified) return json({ error: "Incorrect PIN" }, 401);

        const now = Date.now();
        const token = await signSession({
          userId: verified.userId,
          recordId: verified.recordId,
          role: verified.role,
          displayName: verified.displayName,
          iat: now,
          exp: now + 12 * 60 * 60 * 1000 // 12 hours — one working day, not indefinite
        }, env.SESSION_SECRET);

        return json({
          token,
          userId: verified.userId,
          name: verified.displayName,
          role: verified.role,
          recordId: verified.recordId
        });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST /save-actions
    if (url.pathname === "/save-actions") {
      try {
        const body = await req.json();
        const { visitRecordId, accountId, accountName, userId, actionText, assignedRepRecordId } = body;
        if (!visitRecordId || !accountName || !userId || !actionText) {
          return json({ error: "visitRecordId, accountName, userId and actionText required" }, 400);
        }
        const userRecordId = assignedRepRecordId || await findUserRecordIdByUserId(userId);
        if (!userRecordId) return json({ error: "Assigned rep not found in Users table" }, 400);
        const actions = splitActions(actionText);
        if (actions.length === 0) return json({ success: true, created: 0 });
        const records = actions.map(action => {
          const fields = {
            "Action Text": action, "Status": "Open", "Source": "AI",
            "Account Name": accountName, "Assigned Rep": [userRecordId],
            "Source Visit": [visitRecordId], "Reminder Count": 0
          };
          if (accountId) fields["Account"] = [accountId];
          const dueDate = parseDateFromText(action);
          if (dueDate) fields["Due Date"] = dueDate;
          const dueTime = parseTimeFromText(action);
          if (dueTime) fields["Due Time"] = dueTime;
          return { fields };
        });
        let created = [];
        for (let i = 0; i < records.length; i += 10) {
          const batch = records.slice(i, i + 10);
          let response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}`, { method: "POST", headers: airtableHeaders(), body: JSON.stringify({ records: batch }) });
          let data = await response.json();
          if (!response.ok && JSON.stringify(data).includes("Due Time")) {
            const cleaned = batch.map(r => { const copy = { fields: { ...r.fields } }; delete copy.fields["Due Time"]; return copy; });
            response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}`, { method: "POST", headers: airtableHeaders(), body: JSON.stringify({ records: cleaned }) });
            data = await response.json();
          }
          if (!response.ok) return json(data, response.status);
          created = created.concat(data.records || []);
        }
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Open", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Completed", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Dismissed", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?userId="+encodeURIComponent(userId)+"&role=Sales%20Rep&status=Open", req.url).toString())));
        return json({ success: true, created: created.length, records: created });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST /complete-action
    if (url.pathname === "/complete-action") {
      if (!(await checkRateLimit("complete-action", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const token = getBearerToken(req);
        const session = await verifySession(token, env.SESSION_SECRET);
        if (!session) return json({ error: "Invalid or expired session. Please sign in again." }, 401);
        const userRecordId = session.recordId;
        const userId = session.userId;

        const body = await req.json();
        const actionId = body.actionId;
        if (!actionId) return json({ error: "actionId required" }, 400);

        const action = await getAction(actionId);
        if (!action) return json({ error: "Action not found" }, 404);

        const assigned = action.fields["Assigned Rep"] || [];
        if (!assigned.includes(userRecordId)) {
          return json({ error: "Only the assigned rep can complete this action" }, 403);
        }

        const completeRes = await airtableFetch(
          `https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}/${actionId}`,
          {
            method: "PATCH",
            headers: airtableHeaders(),
            body: JSON.stringify({ fields: { "Status": "Completed", "Completed At": new Date().toISOString() } })
          }
        );
        const completeData = await completeRes.json();
        if (!completeRes.ok) return json(completeData, completeRes.status);

        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Open", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Completed", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Dismissed", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?userId="+encodeURIComponent(userId)+"&role=Sales%20Rep&status=Open", req.url).toString())));

        try {
          const notifParams = new URLSearchParams();
          notifParams.append("filterByFormula", `{Related Action ID}="${safeFormula(actionId)}"`);
          notifParams.append("pageSize", "50");

          const notifRes = await airtableFetch(
            `https://api.airtable.com/v0/${BASE_ID}/${NOTIFICATIONS_TABLE}?${notifParams.toString()}`,
            { headers: airtableHeaders() }
          );

          const notifData = await notifRes.json();

          if (notifRes.ok) {
            const allLinked = notifData.records || [];
            const unread = allLinked.filter(r => !r.fields["Is Read"]);

            for (const notif of unread) {
              const patchUrl = `https://api.airtable.com/v0/${BASE_ID}/${NOTIFICATIONS_TABLE}/${notif.id}`;
              const patchBody = { fields: { "Is Read": true } };

              await airtableFetch(patchUrl, {
                method: "PATCH",
                headers: airtableHeaders(),
                body: JSON.stringify(patchBody)
              });
            }
          }
        } catch (sweepErr) {
          // Notification sweep failures are non-fatal — the action itself
          // already completed successfully above.
        }
        ctx.waitUntil(cache.delete(new Request(new URL("/get-notifications?userId="+encodeURIComponent(userId), req.url).toString())));

        return json(completeData, completeRes.status);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // POST /dismiss-action
    // Mirrors /complete-action exactly — same rep-ownership check, same
    // non-fatal notification-read sweep — but records a third, distinct
    // terminal outcome instead of Completed. Never deletes or overwrites
    // the original action record; only adds Status/Dismissed By/Dismissed
    // Date fields, so the account's full history (what was recommended,
    // what was done, what was intentionally not done) is preserved.
    if (url.pathname === "/dismiss-action") {
      if (!(await checkRateLimit("dismiss-action", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const token = getBearerToken(req);
        const session = await verifySession(token, env.SESSION_SECRET);
        if (!session) return json({ error: "Invalid or expired session. Please sign in again." }, 401);
        const userRecordId = session.recordId;
        const userId = session.userId;

        const body = await req.json();
        const actionId = body.actionId;
        if (!actionId) return json({ error: "actionId required" }, 400);

        const action = await getAction(actionId);
        if (!action) return json({ error: "Action not found" }, 404);

        const assigned = action.fields["Assigned Rep"] || [];
        if (!assigned.includes(userRecordId)) {
          return json({ error: "Only the assigned rep can dismiss this action" }, 403);
        }

        const dismissingUser = await getUserByRecordId(userRecordId);
        const dismissedByName = (dismissingUser && dismissingUser.fields && dismissingUser.fields["Display Name"]) || userId;

        const dismissRes = await airtableFetch(
          `https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}/${actionId}`,
          {
            method: "PATCH",
            headers: airtableHeaders(),
            body: JSON.stringify({ fields: { "Status": "Dismissed", "Dismissed By": dismissedByName, "Dismissed Date": new Date().toISOString() } })
          }
        );
        const dismissData = await dismissRes.json();
        if (!dismissRes.ok) {
          // Airtable's error shape is { error: { type, message } } — an
          // object, not a string. Passing dismissData straight through (as
          // before) meant the client's `new Error(data.error)` stringified
          // it to the literal text "[object Object]", silently discarding
          // the actual, specific reason (e.g. an unknown field name or an
          // invalid Single Select value). This extracts the real message
          // so it's visible on the next attempt.
          const airtableMsg = (dismissData && dismissData.error && dismissData.error.message) || JSON.stringify(dismissData);
          return json({ error: airtableMsg, airtableDetail: dismissData }, dismissRes.status);
        }

        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Open", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Completed", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Dismissed", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?userId="+encodeURIComponent(userId)+"&role=Sales%20Rep&status=Open", req.url).toString())));

        try {
          const notifParams = new URLSearchParams();
          notifParams.append("filterByFormula", `{Related Action ID}="${safeFormula(actionId)}"`);
          notifParams.append("pageSize", "50");

          const notifRes = await airtableFetch(
            `https://api.airtable.com/v0/${BASE_ID}/${NOTIFICATIONS_TABLE}?${notifParams.toString()}`,
            { headers: airtableHeaders() }
          );

          const notifData = await notifRes.json();

          if (notifRes.ok) {
            const allLinked = notifData.records || [];
            const unread = allLinked.filter(r => !r.fields["Is Read"]);

            for (const notif of unread) {
              const patchUrl = `https://api.airtable.com/v0/${BASE_ID}/${NOTIFICATIONS_TABLE}/${notif.id}`;
              const patchBody = { fields: { "Is Read": true } };

              await airtableFetch(patchUrl, {
                method: "PATCH",
                headers: airtableHeaders(),
                body: JSON.stringify(patchBody)
              });
            }
          }
        } catch (sweepErr) {
          // Notification sweep failures are non-fatal — the action itself
          // already dismissed successfully above.
        }
        ctx.waitUntil(cache.delete(new Request(new URL("/get-notifications?userId="+encodeURIComponent(userId), req.url).toString())));

        return json(dismissData, dismissRes.status);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // POST /watch-account
    // Adds "Manager" to the Watched By field on an Account record. Multiple
    // Select field on the Accounts table — future-proofed so more than one
    // manager's name could be added later without a schema change, but only
    // "Manager" is used for now, matching the current single-option setup.
    if (url.pathname === "/watch-account") {
      try {
        const body = await req.json();
        const accountId = body.accountId;
        if (!accountId) return json({ error: "accountId required" }, 400);

        const getRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Accounts/${accountId}`, { headers: airtableHeaders() });
        const getData = await getRes.json();
        if (!getRes.ok) { const msg = (getData && getData.error && getData.error.message) || JSON.stringify(getData); return json({ error: "Could not read account: " + msg }, getRes.status); }

        const current = getData.fields["Watched By"] || [];
        const updated = current.includes("Manager") ? current : current.concat("Manager");

        const patchRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Accounts/${accountId}`, {
          method: "PATCH",
          headers: airtableHeaders(),
          body: JSON.stringify({ fields: { "Watched By": updated } })
        });
        const patchData = await patchRes.json();
        if (!patchRes.ok) { const msg = (patchData && patchData.error && patchData.error.message) || JSON.stringify(patchData); return json({ error: "Could not update account: " + msg }, patchRes.status); }

        // Verify against Airtable's own PATCH response (the authoritative
        // post-write state it just confirmed) rather than trusting the
        // write silently succeeded — if "Manager" isn't actually present
        // after this, something is wrong and the caller needs to know.
        const confirmedWatched = (patchData.fields["Watched By"] || []).includes("Manager");
        if (!confirmedWatched) {
          return json({ error: "Watch did not take effect — Watched By field does not contain Manager after the write." }, 500);
        }

        // Awaited, not backgrounded — same reason as /update-visit's
        // invalidation of /get-dashboard: the response must only return
        // once the stale /get-watchlist cache entry is actually gone, so
        // the very next dashboard load can never see pre-write data.
        await cache.delete(new Request(new URL("/get-watchlist", req.url).toString()));

        return json(patchData, 200);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // POST /unwatch-account
    if (url.pathname === "/unwatch-account") {
      try {
        const body = await req.json();
        const accountId = body.accountId;
        if (!accountId) return json({ error: "accountId required" }, 400);

        const getRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Accounts/${accountId}`, { headers: airtableHeaders() });
        const getData = await getRes.json();
        if (!getRes.ok) { const msg = (getData && getData.error && getData.error.message) || JSON.stringify(getData); return json({ error: "Could not read account: " + msg }, getRes.status); }

        const current = getData.fields["Watched By"] || [];
        const updated = current.filter(v => v !== "Manager");

        const patchRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Accounts/${accountId}`, {
          method: "PATCH",
          headers: airtableHeaders(),
          body: JSON.stringify({ fields: { "Watched By": updated } })
        });
        const patchData = await patchRes.json();
        if (!patchRes.ok) { const msg = (patchData && patchData.error && patchData.error.message) || JSON.stringify(patchData); return json({ error: "Could not update account: " + msg }, patchRes.status); }

        // Same verification, inverted: confirm "Manager" is genuinely gone
        // from Airtable's own post-write response, not just assumed.
        const stillWatched = (patchData.fields["Watched By"] || []).includes("Manager");
        if (stillWatched) {
          return json({ error: "Unwatch did not take effect — Watched By field still contains Manager after the write." }, 500);
        }

        await cache.delete(new Request(new URL("/get-watchlist", req.url).toString()));

        return json(patchData, 200);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }


    // POST /update-action — v3.5: reschedule or cancel an Open Action
    if (url.pathname === "/update-action") {
      try {
        const body = await req.json();
        const { actionId, dueDate, status, rescheduleReason,
                lastUpdatedBy, lastUpdatedDate, lastVisitRecordId,
                managerNotification, managerNotificationViewed } = body;

        if (!actionId) {
          return json({ error: "actionId is required" }, 400);
        }

        const fields = {};
        if (dueDate)          fields["Due Date"]         = dueDate;
        if (status)           fields["Status"]            = status;
        if (rescheduleReason) fields["Reschedule Reason"] = rescheduleReason;
        // Rep Activity notification fields — optional, additive only.
        // If none of these are supplied, this endpoint's other behavior is unaffected.
        if (lastUpdatedBy !== undefined)            fields["Last Updated By"]              = lastUpdatedBy;
        if (lastUpdatedDate !== undefined)          fields["Last Updated Date"]            = lastUpdatedDate;
        if (lastVisitRecordId !== undefined)        fields["Last Visit Record ID"]         = lastVisitRecordId;
        if (managerNotification !== undefined)      fields["Manager Notification"]         = managerNotification;
        if (managerNotificationViewed !== undefined) fields["Manager Notification Viewed"]  = managerNotificationViewed;

        if (Object.keys(fields).length === 0) {
          return json({ error: "No fields to update" }, 400);
        }

        const atRes = await airtableFetch(
          `https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}/${actionId}`,
          {
            method: "PATCH",
            headers: airtableHeaders(),
            body: JSON.stringify({ fields })
          }
        );
        const atData = await atRes.json();
        if (!atRes.ok) {
          return json({ error: atData.error?.message || "Airtable error", detail: atData }, 500);
        }
        return json({ success: true, record: atData });

      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

        // POST /send-reminder
    if (url.pathname === "/send-reminder") {
      if (!(await checkRateLimit("send-reminder", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const body = await req.json();
        const actionId = body.actionId;
        if (!actionId) return json({ error: "actionId required" }, 400);
        const action = await getAction(actionId);
        if (!action) return json({ error: "Action not found" }, 404);
        const f = action.fields || {};
        if (f["Status"] !== "Open") return json({ error: "Reminder can only be sent for Open actions" }, 400);
        const lastReminder = f["Last Reminder Sent At"];
        if (lastReminder) {
          const hours = (Date.now() - new Date(lastReminder).getTime()) / 36e5;
          if (hours < 24) return json({ error: "Reminder locked", locked: true, hoursRemaining: Math.ceil(24 - hours) }, 429);
        }
        const assigned = f["Assigned Rep"] || [];
        if (!assigned[0]) return json({ error: "No assigned rep found" }, 400);
        const userRecord = await getUserByRecordId(assigned[0]);
        if (!userRecord) return json({ error: "Assigned user not found" }, 400);
        const recipientUserId = userRecord.fields["User ID"] || "";
        const recipientName = userRecord.fields["Display Name"] || "Rep";
        const accountName = f["Account Name"] || "Account";
        const actionText = f["Action Text"] || "";
        const message = `Reminder: ${accountName} — ${actionText}`;
        const notifRes = await airtableFetch(
          `https://api.airtable.com/v0/${BASE_ID}/${NOTIFICATIONS_TABLE}`,
          {
            method: "POST",
            headers: airtableHeaders(),
            body: JSON.stringify({
              fields: {
                "Recipient User ID": recipientUserId,
                "Recipient Name": recipientName,
                "Type": "Reminder",
                "Action Text": actionText,
                "Message": message,
                "Is Read": false,
                "Delivery Channel": "In-App",
                "Related Action ID": actionId
              }
            })
          }
        );
        const notifData = await notifRes.json();
        if (!notifRes.ok) return json(notifData, notifRes.status);
        const reminderCount = Number(f["Reminder Count"] || 0) + 1;
        const updateRes = await airtableFetch(
          `https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}/${actionId}`,
          { method: "PATCH", headers: airtableHeaders(), body: JSON.stringify({ fields: { "Last Reminder Sent At": new Date().toISOString(), "Reminder Count": reminderCount } }) }
        );
        const updateData = await updateRes.json();
        if (!updateRes.ok) return json(updateData, updateRes.status);
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Open", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Completed", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?role=Manager&status=Dismissed", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-actions?userId="+encodeURIComponent(recipientUserId)+"&role=Sales%20Rep&status=Open", req.url).toString())));
        ctx.waitUntil(cache.delete(new Request(new URL("/get-notifications?userId="+encodeURIComponent(recipientUserId), req.url).toString())));
        return json({ success: true, notification: notifData, action: updateData });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST /mark-notification-read
    if (url.pathname === "/mark-notification-read") {
      try {
        const body = await req.json();
        const { notificationId, userId } = body;
        if (!notificationId || !userId) return json({ error: "notificationId and userId required" }, 400);
        const getRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${NOTIFICATIONS_TABLE}/${notificationId}`, { headers: airtableHeaders() });
        const notif = await getRes.json();
        if (!getRes.ok) return json(notif, getRes.status);
        if (notif.fields["Recipient User ID"] !== userId) return json({ error: "Cannot mark another user's notification as read" }, 403);
        const response = await airtableFetch(
          `https://api.airtable.com/v0/${BASE_ID}/${NOTIFICATIONS_TABLE}/${notificationId}`,
          { method: "PATCH", headers: airtableHeaders(), body: JSON.stringify({ fields: { "Is Read": true } }) }
        );
        const data = await response.json();
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST /transcribe
    if (url.pathname === "/transcribe") {
      try {
        const formData = await req.formData();
        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY }, body: formData });
        const data = await response.json();
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST /upload-photo
    // Accepts multipart/form-data: { photo: File, visitId: string }
    // Compresses to JPEG on the client before reaching here.
    // Stores in Cloudflare R2 bucket bound as env.VISIT_EVIDENCE_BUCKET.
    // Returns { success, url, filename } — URL is env.PHOTO_PUBLIC_BASE_URL + "/" + filename.
    // Does NOT write to Airtable directly; the frontend includes the returned URL
    // inside the subsequent /save-visit or /update-visit call as "Photo URLs".
    if (url.pathname === "/upload-photo") {
      try {
        const formData = await req.formData();
        const photo = formData.get("photo");
        const visitId = String(formData.get("visitId") || "visit").replace(/[^a-zA-Z0-9_-]/g, "_");

        if (!photo) return json({ error: "photo field required" }, 400);

        const filename = `${visitId}-${Date.now()}.jpg`;
        const arrayBuffer = await photo.arrayBuffer();

        await env.VISIT_EVIDENCE_BUCKET.put(filename, arrayBuffer, {
          httpMetadata: { contentType: "image/jpeg" }
        });

        const baseUrl = String(env.PHOTO_PUBLIC_BASE_URL || "").replace(/\/$/, "");
        const photoUrl = `${baseUrl}/${filename}`;

        return json({ success: true, url: photoUrl, filename });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // POST /save-visit
    // Passes all fields to Airtable as-is. If the frontend includes
    // "Photo URLs" (a newline-separated list of R2 URLs) in the body,
    // it is saved automatically — no special handling required here.
    if (url.pathname === "/save-visit") {
      if (!(await checkRateLimit("save-visit", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const visitData = await req.json();
        let sourceVisitId = visitData["sourceVisitId"] || "";
        const sourceActionId = visitData["sourceActionId"] || "";
        delete visitData["sourceVisitId"];
        delete visitData["sourceActionId"];
        // Fallback: if no direct source visit ID was resolved client-side
        // (the action's own Source Visit link was empty when Calendar
        // built the Log Update URL, so visitId was never included at
        // all), but the action's own ID is available, look up that
        // action's Source Visit link directly here instead. This is the
        // actual gap that let a follow-up silently become its own,
        // unrelated thread — the client-side resolution had no fallback
        // when the action's own link was missing.
        if (!sourceVisitId && sourceActionId) {
          try {
            const actRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}/${sourceActionId}`, { headers: airtableHeaders() });
            const actData = await actRes.json();
            const linkedVisit = actRes.ok && actData.fields && actData.fields["Source Visit"];
            if (Array.isArray(linkedVisit) && linkedVisit.length) sourceVisitId = linkedVisit[0];
          } catch (e) { /* non-fatal — falls through, visit still saves as a normal new visit */ }
        }
        // Follow-up visit: resolve the correct thread ID server-side,
        // atomically, before create — guaranteed, rather than depending on
        // a separate, earlier client-side fetch (/get-visit-territory)
        // having already succeeded. Every original visit's own Visit
        // Thread ID always equals its own record ID (enforced below and
        // by the auto-set patch for new visits), so looking up the
        // original's own field and falling back to its own ID if that
        // field is somehow still empty (e.g. a visit that pre-dates this
        // feature and has never been resolved through yet) always
        // produces the correct, matching anchor for this follow-up.
        if (sourceVisitId && !visitData["Visit Thread ID"]) {
          try {
            const srcRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits/${sourceVisitId}`, { headers: airtableHeaders() });
            const srcData = await srcRes.json();
            const srcThreadId = (srcRes.ok && srcData.fields && srcData.fields["Visit Thread ID"]) || sourceVisitId;
            visitData["Visit Thread ID"] = srcThreadId;
            // Backfill the original too, if it didn't already have its own
            // field set — same self-anchoring guarantee as new visits get.
            if (srcRes.ok && !(srcData.fields && srcData.fields["Visit Thread ID"])) {
              ctx.waitUntil(
                airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits/${sourceVisitId}`, {
                  method: "PATCH",
                  headers: airtableHeaders(),
                  body: JSON.stringify({ fields: { "Visit Thread ID": sourceVisitId } })
                })
              );
            }
          } catch (e) {
            // If the lookup itself fails, fall back to the source visit's
            // own id directly — still correct, since a thread's id is
            // always the original's own record id by design.
            visitData["Visit Thread ID"] = sourceVisitId;
          }
        }
        const hasThreadId = !!visitData["Visit Thread ID"];
        const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits`, { method: "POST", headers: airtableHeaders(), body: JSON.stringify({ fields: visitData }) });
        const data = await response.json();
        let finalThreadId = visitData["Visit Thread ID"] || null;
        if (response.ok) {
          ctx.waitUntil(cache.delete(new Request(new URL("/get-visits", req.url).toString())));
          ctx.waitUntil(cache.delete(new Request(new URL("/get-dashboard", req.url).toString())));
          ctx.waitUntil(cache.delete(new Request(new URL("/get-watchlist", req.url).toString())));
          // A normal, new Log Visit (not a Log Update — those already send
          // their own Visit Thread ID, inherited from the original visit).
          // Sets this visit as its own thread anchor, so a future Log
          // Update against it has a real, resolvable thread to join.
          if (!hasThreadId && data.id) {
            finalThreadId = data.id;
            ctx.waitUntil(
              airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits/${data.id}`, {
                method: "PATCH",
                headers: airtableHeaders(),
                body: JSON.stringify({ fields: { "Visit Thread ID": data.id } })
              })
            );
          }
          // Explicit proof of the linkage, directly in the save response —
          // no separate call needed to confirm what thread this visit was
          // actually saved into.
          data._threadInfo = {
            visitThreadId: finalThreadId,
            isNewThread: !sourceVisitId,
            linkedFromSourceVisitId: sourceVisitId || null,
            linkedFromSourceActionId: sourceActionId || null
          };
        }
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST /save-account
    if (url.pathname === "/save-account") {
      if (!(await checkRateLimit("save-account", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const accountData = await req.json();
        const nameToCheck = String(accountData["Account Name"] || "").trim().toLowerCase();
        const territoryToCheck = String(accountData["Territory"] || "").trim();
        const cityToCheck = String(accountData["City"] || "").trim();

        if (nameToCheck) {
          const formulaParts = [`LOWER(TRIM({Account Name}))="${safeFormula(nameToCheck)}"`];
          if (territoryToCheck) formulaParts.push(`{Territory}="${safeFormula(territoryToCheck)}"`);
          if (cityToCheck) formulaParts.push(`{City}="${safeFormula(cityToCheck)}"`);
          const dupFormula = formulaParts.length === 1 ? formulaParts[0] : `AND(${formulaParts.join(",")})`;

          const dupParams = new URLSearchParams();
          dupParams.append("filterByFormula", dupFormula);
          dupParams.append("maxRecords", "1");
          const dupRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Accounts?${dupParams.toString()}`, { headers: airtableHeaders() });
          const dupData = await dupRes.json();
          if (dupRes.ok && dupData.records && dupData.records[0]) {
            // Existing account found — return it exactly as the client already
            // expects a saved-account response to look (a valid record with an
            // id), so the rest of the new-account flow (contact save, visit
            // save) proceeds identically whether the account was just created
            // or already existed.
            return json(dupData.records[0], 200);
          }
        }

        const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Accounts`, { method: "POST", headers: airtableHeaders(), body: JSON.stringify({ fields: accountData }) });
        const data = await response.json();
        if (response.ok) {
          ctx.waitUntil(cache.delete(new Request(new URL("/get-accounts", req.url).toString())));
        }
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST /save-contact
    if (url.pathname === "/save-contact") {
      if (!(await checkRateLimit("save-contact", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const contactData = await req.json();
        const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Contacts%20Name`, { method: "POST", headers: airtableHeaders(), body: JSON.stringify({ fields: contactData }) });
        const data = await response.json();
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST /save-account-update
    // A lightweight, timestamped note recording an interim change to an
    // account between visits — never a replacement for a Visit, never
    // touches the Visits table, never modifies an AI visit report. Stored
    // in a separate "Account Updates" table, linked to the Account.
    if (url.pathname === "/save-account-update") {
      if (!(await checkRateLimit("save-account-update", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const body = await req.json();
        const { accountId, accountName, updateText, createdBy, createdByUserId } = body;
        if (!accountId || !accountName || !updateText) {
          return json({ error: "accountId, accountName and updateText required" }, 400);
        }
        const fields = {
          "Account": [accountId],
          "Account Name": accountName,
          "Update Text": updateText,
          "Created Date": new Date().toISOString()
        };
        if (createdBy) fields["Created By"] = createdBy;
        if (createdByUserId) fields["Created By User ID"] = createdByUserId;
        const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Account%20Updates`, { method: "POST", headers: airtableHeaders(), body: JSON.stringify({ fields }) });
        const data = await response.json();
        if (response.ok) {
          ctx.waitUntil(cache.delete(new Request(new URL("/get-account-updates?accountName=" + encodeURIComponent(accountName), req.url).toString())));
        }
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST /save-note
    // Manager-to-rep coaching note attached to an Open Action. Fully
    // separate feature from Visit History / Visit Thread — writes only to
    // the standalone Manager Notes table (Action ID, Notes, Acknowledged,
    // Created Date, Created By). Never touches Field Visits, Visit Thread
    // ID, /save-visit, KPIs, Reputation, or Notifications. "Action ID" is
    // stored as plain text, not a linked record, so /get-notes can filter
    // on it directly without the ARRAYJOIN/FIND limitation documented
    // elsewhere in this file for linked-record fields.
    if (url.pathname === "/save-note") {
      if (!(await checkRateLimit("save-note", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const body = await req.json();
        const { actionId, commentText, createdBy } = body;
        if (!actionId || !commentText) {
          return json({ error: "actionId and commentText required" }, 400);
        }
        const fields = {
          "Action ID": actionId,
          "Notes": commentText,
          "Created Date": new Date().toISOString(),
          "Acknowledged": false
        };
        if (createdBy) fields["Created By"] = createdBy;
        const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Manager%20Notes`, { method: "POST", headers: airtableHeaders(), body: JSON.stringify({ fields }) });
        const data = await response.json();
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST /acknowledge-note
    // Lets a rep mark a Manager Note as seen. Writes only to Manager
    // Notes — same isolation guarantee as /save-note above.
    if (url.pathname === "/acknowledge-note") {
      try {
        const body = await req.json();
        const { noteId } = body;
        if (!noteId) return json({ error: "noteId required" }, 400);
        const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Manager%20Notes/${noteId}`, { method: "PATCH", headers: airtableHeaders(), body: JSON.stringify({ fields: { "Acknowledged": true } }) });
        const data = await response.json();
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // PATCH /update-visit
    if (url.pathname === "/update-visit") {
      if (!(await checkRateLimit("update-visit", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const body = await req.json();
        const { recordId, priority, reviewed, pendingReview } = body;
        if (!recordId || (priority === undefined && reviewed === undefined && pendingReview === undefined)) {
          return json({ error: "recordId and (priority or reviewed or pendingReview) required" }, 400);
        }
        const fieldsToUpdate = {};
        if (priority !== undefined) fieldsToUpdate["Priority"] = priority;
        if (reviewed !== undefined) fieldsToUpdate["Reviewed"] = reviewed;
        if (pendingReview !== undefined) fieldsToUpdate["Pending Review"] = pendingReview;
        const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits/${recordId}`, { method: "PATCH", headers: airtableHeaders(), body: JSON.stringify({ fields: fieldsToUpdate }) });
        const data = await response.json();
        if (response.ok) {
          // /get-dashboard caches its unfiltered response (60s TTL), so this
          // delete is the one that actually matters here: any Priority,
          // Reviewed, or Pending Review change must invalidate it
          // immediately, or a manager could see stale KPIs/Priority
          // Review/Management Radar for up to a minute after a real change.
          // Awaited, not backgrounded, so the response only returns once
          // the stale entries are actually gone.
          await cache.delete(new Request(new URL("/get-visits", req.url).toString()));
          await cache.delete(new Request(new URL("/get-dashboard", req.url).toString()));
          await cache.delete(new Request(new URL("/get-watchlist", req.url).toString()));
        }
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST /ask-fieldiq
    // Phase 1 "Ask FieldIQ" — a single-shot, bounded-context question
    // answerer for managers. Not a chatbot: no conversation history, no
    // free-form database access, no new Airtable calls of its own. Reuses
    // /get-dashboard's own already-ranked/capped output via an internal
    // sub-fetch on this same Worker, so the agent's context is always
    // exactly what the dashboard itself already shows — never a separate,
    // possibly-drifting computation, and never a raw dump of Field
    // Visits/Accounts. The dashboard JSON itself is never passed to the
    // model directly; it's first reduced to a small, fixed-size text
    // digest (top 8 radar accounts, counts not full records, top 5/6/8
    // of the other already-capped lists).
    //
    // Requires a valid session token (Authorization: Bearer <token>),
    // issued only by POST /login, AND requires the token's own verified
    // role to be Manager. Without this, any caller who discovered this
    // URL — no credential of any kind — could trigger a real Anthropic
    // API call and see aggregate business intelligence. The role check
    // reads session.role from the cryptographically verified token
    // payload, never a client-supplied field, so it cannot be bypassed by
    // simply claiming to be a manager in the request body.
    if (url.pathname === "/ask-fieldiq") {
      if (!(await checkRateLimit("ask-fieldiq", req))) return json({ error: "Too many requests. Please wait a moment and try again." }, 429);
      try {
        const body = await req.json();
        const question = String(body.question || "").trim();
        if (!question) return json({ error: "question required" }, 400);

        const token = getBearerToken(req);
        const session = await verifySession(token, env.SESSION_SECRET);
        if (!session) {
          console.log(`[ask-fieldiq-debug] rejected: invalid or expired session token`);
          return json({ error: "Invalid or expired session. Please sign in again." }, 401);
        }
        if (session.role !== "Manager") {
          console.log(`[ask-fieldiq-debug] rejected: userId=${session.userId} has role=${session.role}, not Manager`);
          return json({ error: "Manager access required" }, 403);
        }
        console.log(`[ask-fieldiq-debug] session verified: userId=${session.userId}, role=Manager`);

        // In-process call, not a self-fetch over the network — this used
        // to be an HTTPS request from the Worker back to its own public
        // URL, which was never actually verifiable from a sandbox with no
        // access to real Cloudflare infrastructure. A synthetic request/
        // URL pair matching /get-dashboard's real shape is passed in so
        // the function's internal 60s cache lookup/write uses the exact
        // same cache key a direct call would — this now shares that
        // cache rather than bypassing it.
        const dashboardUrl = new URL("/get-dashboard", req.url);
        const dashboardReq = new Request(dashboardUrl.toString(), { method: "GET" });
        const dashRes = await buildDashboardResponse(dashboardReq, dashboardUrl);
        const dashboard = await dashRes.json();
        if (!dashRes.ok) {
          console.log(`[ask-fieldiq-debug] dashboard aggregation failed: status=${dashRes.status}, body=${JSON.stringify(dashboard).slice(0, 300)}`);
          return json({ error: "Could not load FieldIQ context" }, 502);
        }

        const visitsLoadedCount = (dashboard.priorityReview && ((dashboard.priorityReview.high || []).length + (dashboard.priorityReview.medium || []).length + (dashboard.priorityReview.low || []).length)) || 0;
        const openActionsFlaggedCount = (dashboard.managementRadar || []).filter(a => a.followUpOverdueActionId || a.followUpDueTodayActionId).length;
        const repsFoundCount = (dashboard.reps || []).length;
        console.log(`[ask-fieldiq-debug] dashboard loaded: visits=${visitsLoadedCount}, accounts flagged=${(dashboard.managementRadar || []).length}, actions referenced in flags=${openActionsFlaggedCount}, reps=${repsFoundCount}`);

        // ── Five management lenses ──────────────────────────────────────
        // Each of these is a genuinely separate query over the real data,
        // not five prompts sharing one digest. buildDashboardResponse
        // only exposes pre-aggregated summaries (counts, top-N flagged
        // accounts) — it was never built to answer "what did Rep 2's
        // last visit look like" or "which visit has no follow-up
        // action," so these five lenses fetch their own raw Field
        // Visits / Open Actions / active-rep data, same field lists and
        // pagination pattern already proven elsewhere in this file, and
        // compute genuinely distinct facts from it. This fetch only runs
        // when one of the five exact lens questions is asked — the daily
        // briefing and any other question never pay this cost.
        const TEAM_Q = "What is my team working on?";
        const HELP_Q = "Where do my reps need my help?";
        const BLOCK_Q = "What is blocking commercial progress?";
        const OPP_Q = "Which opportunities should we push?";
        const COACH_Q = "Who needs coaching or recognition?";
        const LENS_QUESTIONS = [TEAM_Q, HELP_Q, BLOCK_Q, OPP_Q, COACH_Q];

        if (LENS_QUESTIONS.includes(question)) {
          async function gatherLensRawData() {
            // Field Visits — now includes AI Summary and Meeting Notes,
            // the two free-text fields real commercial blockers actually
            // live in (procurement delays, budget timing, competitor
            // pressure, service complaints). None of this exists as a
            // structured field anywhere in this schema — it only ever
            // appears as prose a rep dictated. Same field-list-and-
            // pagination pattern already proven elsewhere in this file.
            const visitFields = ["Hospital Name","Visit Date","Territory","Visit Type","Rep Name","Outcome","Priority","New Account","Pending Review","Reviewed","AI Summary","Meeting Notes"];
            let allVisits = [], vOffset = null;
            do {
              const vParams = new URLSearchParams();
              visitFields.forEach(f => vParams.append("fields[]", f));
              vParams.append("pageSize", "100");
              if (vOffset) vParams.append("offset", vOffset);
              vParams.append("sort[0][field]", "Visit Date");
              vParams.append("sort[0][direction]", "desc");
              const vRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits?${vParams.toString()}`, { headers: airtableHeaders() });
              const vData = await vRes.json();
              if (!vRes.ok) throw new Error("Field Visits lookup failed: " + JSON.stringify(vData));
              allVisits = allVisits.concat(vData.records || []);
              vOffset = vData.offset || null;
            } while (vOffset);

            const actionFields = ["Account Name","Action Text","Status","Due Date","Assigned Rep","Source Visit"];
            let allOpenActions = [], aOffset = null;
            do {
              const aParams = new URLSearchParams();
              actionFields.forEach(f => aParams.append("fields[]", f));
              aParams.append("pageSize", "100");
              aParams.append("filterByFormula", `{Status}="Open"`);
              if (aOffset) aParams.append("offset", aOffset);
              const aRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${OPEN_ACTIONS_TABLE}?${aParams.toString()}`, { headers: airtableHeaders() });
              const aData = await aRes.json();
              if (!aRes.ok) throw new Error("Open Actions lookup failed: " + JSON.stringify(aData));
              allOpenActions = allOpenActions.concat(aData.records || []);
              aOffset = aData.offset || null;
            } while (aOffset);

            // Manager Notes — same table already used by the rep-facing
            // note feature, read here for the first time by the
            // manager-facing lenses: an unacknowledged note is a real
            // "manager intervention" signal (Lens 2), and its own text
            // can itself be evidence of a commercial blocker (Lens 3) if
            // the manager wrote one down.
            const noteFields = ["Action ID","Notes","Created By","Acknowledged"];
            let allManagerNotes = [], nOffset = null;
            do {
              const nParams = new URLSearchParams();
              noteFields.forEach(f => nParams.append("fields[]", f));
              nParams.append("pageSize", "100");
              if (nOffset) nParams.append("offset", nOffset);
              const nRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Manager%20Notes?${nParams.toString()}`, { headers: airtableHeaders() });
              const nData = await nRes.json();
              if (!nRes.ok) throw new Error("Manager Notes lookup failed: " + JSON.stringify(nData));
              allManagerNotes = allManagerNotes.concat(nData.records || []);
              nOffset = nData.offset || null;
            } while (nOffset);

            // Filtered by Role only at the Airtable level — plain text
            // equality has no ambiguity. Active status is decided after
            // the fetch, in JS: a bare {Active?} reference inside
            // filterByFormula only evaluates correctly if that field is
            // a genuine Airtable Checkbox type. If it's actually stored
            // as text or something else, the formula-level filter can
            // silently return zero rows even when active reps clearly
            // exist — exactly the "No active reps found" failure this
            // replaces. This defaults to active unless there's a clear,
            // explicit false-ish signal, rather than requiring a
            // positive match against an assumed representation.
            function isExplicitlyInactive(value) {
              if (value === false) return true;
              if (typeof value === "string") {
                const v = value.trim().toLowerCase();
                return v === "false" || v === "no" || v === "0" || v === "inactive";
              }
              return false;
            }
            const repUserParams = new URLSearchParams();
            repUserParams.append("filterByFormula", `{Role}="Sales Rep"`);
            ["Display Name","Active?"].forEach(f => repUserParams.append("fields[]", f));
            let allSalesRepUsers = [], ruOffset = null;
            do {
              if (ruOffset) repUserParams.set("offset", ruOffset);
              const ruRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Users?${repUserParams.toString()}`, { headers: airtableHeaders() });
              const ruData = await ruRes.json();
              if (!ruRes.ok) throw new Error("Users lookup failed: " + JSON.stringify(ruData));
              allSalesRepUsers = allSalesRepUsers.concat(ruData.records || []);
              ruOffset = ruData.offset || null;
            } while (ruOffset);
            const activeRepUsers = allSalesRepUsers.filter(u => !isExplicitlyInactive(u.fields["Active?"]));

            return { allVisits, allOpenActions, allManagerNotes, activeRepUsers };
          }

          function normalizeRepNameLens(raw) {
            const t = String(raw || "").trim();
            return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
          }

          function computeRepActivity(repUserRecord, allVisits, allOpenActions) {
            const repName = normalizeRepNameLens(repUserRecord.fields["Display Name"]);
            const repRecordId = repUserRecord.id;
            const repVisits = allVisits.filter(v => normalizeRepNameLens(v.fields["Rep Name"]) === repName);
            repVisits.sort((a, b) => {
              const ad = a.fields["Visit Date"] ? new Date(a.fields["Visit Date"]).getTime() : 0;
              const bd = b.fields["Visit Date"] ? new Date(b.fields["Visit Date"]).getTime() : 0;
              return bd - ad;
            });
            const latestVisit = repVisits[0] || null;
            const repActions = allOpenActions.filter(a => (a.fields["Assigned Rep"] || []).includes(repRecordId));
            const todayStr = new Date().toISOString().slice(0, 10);
            const overdueActions = repActions.filter(a => a.fields["Due Date"] && String(a.fields["Due Date"]).slice(0, 10) < todayStr);
            let daysSinceLastVisit = null;
            if (latestVisit && latestVisit.fields["Visit Date"]) {
              daysSinceLastVisit = Math.floor((Date.now() - new Date(latestVisit.fields["Visit Date"]).getTime()) / (24 * 60 * 60 * 1000));
            }
            return { name: repName, recordId: repRecordId, visitCount: repVisits.length, latestVisit, daysSinceLastVisit, openActionCount: repActions.length, overdueActionCount: overdueActions.length, overdueActions };
          }

          function addVisitSourceLens(sources, seen, id, label) {
            if (!id || seen.has(id)) return;
            seen.add(id);
            sources.push({ type: "visit", id, label, url: "./fieldiq-visit-history.html?visitId=" + encodeURIComponent(id) });
          }
          function addActionSourceLens(sources, seen, id, label) {
            if (!id || seen.has(id)) return;
            seen.add(id);
            sources.push({ type: "action", id, label, url: "./fieldiq-actions.html?actionId=" + encodeURIComponent(id) });
          }

          // Commercial blocker taxonomy \u2014 only ever applied to real
          // recorded text (Action Text, visit AI Summary/Meeting Notes,
          // Manager Notes), never guessed. This list exists to constrain
          // the model's vocabulary to real, named commercial concepts
          // grounded in standard field-sales pipeline management
          // (procurement/approval cycles, budget timing, competitive
          // and service issues, and execution gaps like missing
          // follow-up) \u2014 not to give it license to invent which one
          // applies. The model is explicitly told to say "No explicit
          // blocker recorded" the moment the text doesn't clearly
          // support one of these.
          const BLOCKER_CATEGORIES = "customer procurement delay, budget timing, quotation or pricing approval, internal company approval, tender process, product availability, service failure, competitor pressure, decision pending, missing access to decision-maker, missing next action, overdue follow-up, customer objection, relationship issue";

          async function categorizeForBlockers(items, env) {
            // items: [{ id, type, account, text }], already filtered to a
            // small, genuinely relevant set before this is ever called.
            // Attaches .category to each item from real text only.
            if (!items.length) return items;
            const digest = items.map((it, i) => `${i + 1}. ${it.account}: "${String(it.text || "").slice(0, 180)}"`).join("\n");
            const prompt = `Below are real records from a sales system (visit notes, action text, or manager notes). For EACH one, state in under 14 words which of these categories the text actually supports, using only what is written \u2014 do not guess: ${BLOCKER_CATEGORIES}. If the text does not clearly support any of these, write exactly: "No explicit blocker recorded." Format as a numbered list matching the input, one line each, no extra commentary.

${digest}`;
            try {
              const catRes = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST", headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
                body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: prompt }] })
              });
              const catData = await catRes.json();
              if (catRes.ok && catData.content && catData.content[0] && catData.content[0].text) {
                const catLines = catData.content[0].text.trim().split("\n").filter(l => l.trim());
                items.forEach((it, i) => { it.category = (catLines[i] || "").replace(/^\d+\.\s*/, "").trim() || "No explicit blocker recorded."; });
              } else {
                items.forEach(it => { it.category = null; }); // AI unavailable \u2014 distinct from a genuine "no blocker" result, handled separately below
              }
            } catch (e) {
              console.log(`[ask-fieldiq-debug] blocker categorization failed: ${e.message}`);
              items.forEach(it => { it.category = null; });
            }
            return items;
          }

          function classifyBlockerBucket(categoryText) {
            // Splits the model's category label into the four required
            // buckets \u2014 based only on which named category (if any) it
            // matched, never a separate judgment call of its own.
            if (!categoryText || /no explicit blocker/i.test(categoryText)) return "visibility";
            const t = categoryText.toLowerCase();
            if (/procurement|budget|tender|objection|decision.?maker|decision pending|competitor|service failure/.test(t)) return "customer";
            if (/pricing|quotation|internal|approval/.test(t)) return "internal";
            if (/missing next action|overdue follow.?up|relationship/.test(t)) return "execution";
            return "visibility";
          }

          // The reasoning layer. Every lens below computes its facts
          // deterministically first \u2014 that computation is unchanged and
          // is still what guarantees every account name, number, and
          // status is real. This function's only job is to reason OVER
          // those already-verified facts the way an experienced sales
          // director would: what matters, why, and what to do about it
          // \u2014 never to discover or add a fact of its own. The prompt
          // enforces this explicitly, and the deterministic bullet list
          // is always the fallback if this call fails, so a synthesis
          // failure degrades to "database-only" rather than an error.
          async function synthesizeCommercialAdvice(lensLabel, factsDigest, env) {
            if (!factsDigest || !factsDigest.trim()) return null;
            const prompt = `You are an experienced Regional Sales Director reviewing a territory with its manager. You do not generate reports \u2014 you interpret evidence and give commercial advice, the way a trusted mentor would, looking at the same facts a manager already has and telling them what actually matters.

Lens: "${lensLabel}"

These are the ONLY facts you may use. Reason strongly from them, but reason ONLY from them.

FACTS:
${factsDigest}

Hard rules, no exceptions:
- Never introduce an account name, number, or claim not listed above.
- Never assign a MOTIVE or explanation for behavior the facts don't state \u2014 do not say a rep is "avoiding," "blocked," "hesitant," or similar, unless the facts explicitly say why. A missing visit is a missing visit, not a choice you've diagnosed.
- Never assign IMPORTANCE or VALUE to an account or deal \u2014 do not say "biggest account," "high-value," "leaving money on the table," or similar, unless the facts explicitly state size or value. You have no revenue or deal-size data at all.
- Never assign a SALES STAGE \u2014 do not say "proposal," "demo," "closing," "negotiation," or similar, unless that exact word appears in the facts above.
- Never state a generic sales pattern or truism as if it were derived from this data \u2014 do not say things like "deals almost always cool down after X days" or "this typically means." That is general sales knowledge, not something these specific facts prove, and presenting it as if it came from the data is exactly the kind of invented claim you must avoid.
- If you want to flag a risk or interpretation the facts don't fully prove, label it plainly as your own inference \u2014 e.g., "I'd want to check whether X is the reason, but the record doesn't say" \u2014 never state it as settled fact.

Write two to four sentences of plain-English commercial narrative: what's actually happening across these facts, and why it matters commercially \u2014 not database language like "positive visit" or "high engagement" on their own, but what that means for the business, using only what the facts support. If a cause isn't explicitly recorded or the evidence is thin, say so honestly within that narrative rather than asserting a conclusion the facts don't support \u2014 for example: "I suspect X may be the cause, but there isn't enough evidence yet."

Then add a heading "What I'd do next" followed by 2 to 4 short bullet points, each a concrete management action with a brief "because\u2026" reason tied to a fact above.

No markdown symbols, no other headings. Keep the whole answer under 130 words.`;
            try {
              const synRes = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST", headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
                body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 350, messages: [{ role: "user", content: prompt }] })
              });
              const synData = await synRes.json();
              if (synRes.ok && synData.content && synData.content[0] && synData.content[0].text) {
                return synData.content[0].text.trim();
              }
              console.log(`[ask-fieldiq-debug] synthesis call returned no usable content, status=${synRes.status}`);
              return null;
            } catch (e) {
              console.log(`[ask-fieldiq-debug] synthesis call failed: ${e.message}`);
              return null;
            }
          }

          try {
            const { allVisits, allOpenActions, allManagerNotes, activeRepUsers } = await gatherLensRawData();
            const repActivities = activeRepUsers.map(u => computeRepActivity(u, allVisits, allOpenActions));
            const unacknowledgedNotes = allManagerNotes.filter(n => !n.fields["Acknowledged"]);
            const actionsById = {}; allOpenActions.forEach(a => { actionsById[a.id] = a; });
            console.log(`[ask-fieldiq-debug] lens raw data: visits=${allVisits.length}, openActions=${allOpenActions.length}, notes=${allManagerNotes.length}, activeReps=${activeRepUsers.length}, question="${question}"`);

            let result;

            if (question === TEAM_Q) {
              // Latest known operational state per rep — never a claim
              // about where someone physically is or a future plan,
              // only what was actually logged and how recent it is.
              const lines = [];
              const sources = []; const seen = new Set();
              repActivities.forEach(r => {
                if (r.latestVisit) {
                  const f = r.latestVisit.fields;
                  let detail = f["Hospital Name"] || "an account";
                  if (f["Outcome"]) detail += ", " + String(f["Outcome"]).toLowerCase() + " outcome";
                  if (f["Priority"] && f["Priority"] !== "Low") detail += ", " + f["Priority"] + " priority";
                  const recency = (r.daysSinceLastVisit === 0) ? "today" : (r.daysSinceLastVisit === 1 ? "yesterday" : r.daysSinceLastVisit + " days ago");
                  const actionNote = r.openActionCount > 0 ? " \u2014 " + r.openActionCount + " open action" + (r.openActionCount !== 1 ? "s" : "") : "";
                  lines.push(r.name + " \u2014 last visited " + detail + " (" + recency + ")" + actionNote + ".");
                  addVisitSourceLens(sources, seen, r.latestVisit.id, r.name + " \u2014 " + (f["Hospital Name"] || "latest visit"));
                } else {
                  lines.push(r.name + " \u2014 no visit activity recorded in the selected period.");
                }
              });
              const deterministicAnswer = lines.length ? "Today's Team Snapshot\n" + lines.map(l => "\u2022 " + l).join("\n") : "No active reps found.";
              const synthesized = await synthesizeCommercialAdvice("What is my team working on?", lines.join("\n"), env);
              result = { answer: synthesized || deterministicAnswer, sources };
            }

            else if (question === HELP_Q) {
              // Only genuine intervention signals — never an ordinary
              // rep task relabeled as something needing the manager.
              // Now also surfaces unresolved Manager Notes, a real
              // "someone is waiting on me" signal that was never checked
              // by any lens before this pass.
              const needsSupport = [], visibilityGaps = [];
              const sources = []; const seen = new Set();
              (dashboard.priorityReview.high || []).forEach(r => {
                const f = r.fields;
                needsSupport.push((f["Hospital Name"] || "Unknown account") + " \u2014 High Priority visit awaiting review.");
                addVisitSourceLens(sources, seen, r.id, (f["Hospital Name"] || "Account") + " \u2014 High Priority visit");
              });
              (dashboard.priorityReview.medium || []).forEach(r => {
                const f = r.fields;
                needsSupport.push((f["Hospital Name"] || "Unknown account") + " \u2014 Medium Priority visit awaiting review.");
                addVisitSourceLens(sources, seen, r.id, (f["Hospital Name"] || "Account") + " \u2014 Medium Priority visit");
              });
              unacknowledgedNotes.slice(0, 3).forEach(n => {
                const linkedAction = actionsById[n.fields["Action ID"]];
                const acct = linkedAction ? (linkedAction.fields["Account Name"] || "Unknown account") : "Unknown account";
                needsSupport.push(acct + " \u2014 unresolved manager note awaiting rep acknowledgement.");
                addActionSourceLens(sources, seen, n.fields["Action ID"], acct + " \u2014 manager note");
              });
              repActivities.forEach(r => {
                if (r.overdueActionCount > 0) {
                  needsSupport.push(r.name + " \u2014 " + r.overdueActionCount + " overdue action" + (r.overdueActionCount !== 1 ? "s" : "") + ".");
                  r.overdueActions.slice(0, 2).forEach(a => addActionSourceLens(sources, seen, a.id, r.name + " \u2014 " + String(a.fields["Action Text"] || "").slice(0, 40)));
                }
              });
              repActivities.forEach(r => {
                if (r.visitCount === 0) needsSupport.push(r.name + " \u2014 no recorded activity, no recorded blocker.");
                else if (r.daysSinceLastVisit !== null && r.daysSinceLastVisit > 14) needsSupport.push(r.name + " \u2014 no visit logged in " + r.daysSinceLastVisit + " days, no recorded blocker.");
              });
              const importantVisits = allVisits.filter(v => v.fields["Priority"] === "High" || v.fields["Outcome"] === "Negative");
              let gapCount = 0;
              importantVisits.forEach(v => {
                if (gapCount >= 3) return;
                const hasAction = allOpenActions.some(a => (a.fields["Source Visit"] || []).includes(v.id));
                if (!hasAction) {
                  visibilityGaps.push((v.fields["Hospital Name"] || "Unknown account") + " \u2014 needs review, but the system does not record whether pricing, procurement, or customer approval is the cause.");
                  addVisitSourceLens(sources, seen, v.id, (v.fields["Hospital Name"] || "Account") + " \u2014 needs follow-up check");
                  gapCount++;
                }
              });
              let deterministicAnswer = "";
              if (needsSupport.length) deterministicAnswer += "Needs manager support\n" + needsSupport.slice(0, 7).map(l => "\u2022 " + l).join("\n");
              if (visibilityGaps.length) deterministicAnswer += (deterministicAnswer ? "\n\n" : "") + "Visibility gaps\n" + visibilityGaps.slice(0, 3).map(l => "\u2022 " + l).join("\n");
              if (!deterministicAnswer) deterministicAnswer = "No reps currently show a recorded reason for manager intervention.";
              const factsDigest = needsSupport.concat(visibilityGaps).join("\n");
              const synthesized = await synthesizeCommercialAdvice("Where do my reps need my help?", factsDigest, env);
              result = { answer: synthesized || deterministicAnswer, sources };
            }

            else if (question === BLOCK_Q) {
              // The one lens where AI reads real text \u2014 a bounded set
              // drawn from three genuine sources (overdue action text,
              // unreviewed high-priority visit text, unresolved manager
              // note text), classified into the full commercial taxonomy
              // and split into four required buckets: known customer
              // blocker, known internal blocker, execution gap, and
              // visibility gap. Never the whole database, never a guess
              // beyond what the actual text supports.
              const sources = []; const seen = new Set();
              const todayStr = new Date().toISOString().slice(0, 10);
              const overdueActions = allOpenActions.filter(a => a.fields["Due Date"] && String(a.fields["Due Date"]).slice(0, 10) < todayStr);
              const itemsToClassify = [];
              overdueActions.slice(0, 4).forEach(a => itemsToClassify.push({ id: a.id, type: "action", account: a.fields["Account Name"] || "Unknown account", text: a.fields["Action Text"] || "" }));
              (dashboard.priorityReview.high || []).slice(0, 3).forEach(v => itemsToClassify.push({ id: v.id, type: "visit", account: v.fields["Hospital Name"] || "Unknown account", text: v.fields["AI Summary"] || v.fields["Meeting Notes"] || "" }));
              unacknowledgedNotes.slice(0, 3).forEach(n => {
                const linkedAction = actionsById[n.fields["Action ID"]];
                itemsToClassify.push({ id: n.fields["Action ID"], type: "note", account: linkedAction ? (linkedAction.fields["Account Name"] || "Unknown account") : "Unknown account", text: n.fields["Notes"] || "" });
              });

              const knownCustomer = [], knownInternal = [], executionGaps = [], visibilityGaps = [];
              if (itemsToClassify.length) {
                await categorizeForBlockers(itemsToClassify, env);
                itemsToClassify.forEach(it => {
                  const bucket = classifyBlockerBucket(it.category);
                  if (bucket === "customer") knownCustomer.push(it.account + " \u2014 " + it.category);
                  else if (bucket === "internal") knownInternal.push(it.account + " \u2014 " + it.category);
                  else if (bucket === "execution") executionGaps.push(it.account + " \u2014 " + it.category);
                  else visibilityGaps.push(it.account + " \u2014 " + (it.category === null ? "could not be categorized right now" : "no explicit blocker recorded" + (it.type === "action" ? " (overdue follow-up)" : "")));
                  if (it.type === "visit") addVisitSourceLens(sources, seen, it.id, it.account + " \u2014 " + it.type);
                  else addActionSourceLens(sources, seen, it.id, it.account + " \u2014 " + it.type);
                });
              }

              // Missing-next-action visits — deterministic, no AI needed
              // for this specific fact: either a linked action exists or
              // it doesn't.
              const importantVisits = allVisits.filter(v => v.fields["Priority"] === "High" || v.fields["Outcome"] === "Positive");
              let noActionCount = 0;
              importantVisits.forEach(v => {
                if (noActionCount >= 3) return;
                const hasAction = allOpenActions.some(a => (a.fields["Source Visit"] || []).includes(v.id));
                if (!hasAction) {
                  executionGaps.push((v.fields["Hospital Name"] || "Unknown account") + " \u2014 no next action recorded after this visit.");
                  addVisitSourceLens(sources, seen, v.id, (v.fields["Hospital Name"] || "Account") + " \u2014 no next action");
                  noActionCount++;
                }
              });

              let deterministicAnswer = "";
              if (knownCustomer.length) deterministicAnswer += "Known customer blockers\n" + knownCustomer.slice(0, 3).map(l => "\u2022 " + l).join("\n");
              if (knownInternal.length) deterministicAnswer += (deterministicAnswer ? "\n\n" : "") + "Known internal blockers\n" + knownInternal.slice(0, 3).map(l => "\u2022 " + l).join("\n");
              if (executionGaps.length) deterministicAnswer += (deterministicAnswer ? "\n\n" : "") + "Execution gaps\n" + executionGaps.slice(0, 4).map(l => "\u2022 " + l).join("\n");
              if (visibilityGaps.length) deterministicAnswer += (deterministicAnswer ? "\n\n" : "") + "Visibility gaps\n" + visibilityGaps.slice(0, 4).map(l => "\u2022 " + l).join("\n");
              if (!deterministicAnswer) deterministicAnswer = "No overdue actions, unresolved visits, or open manager notes are currently recorded.";
              const factsDigestParts = [];
              if (knownCustomer.length) factsDigestParts.push("KNOWN CUSTOMER BLOCKERS:\n" + knownCustomer.join("\n"));
              if (knownInternal.length) factsDigestParts.push("KNOWN INTERNAL BLOCKERS:\n" + knownInternal.join("\n"));
              if (executionGaps.length) factsDigestParts.push("EXECUTION GAPS:\n" + executionGaps.join("\n"));
              if (visibilityGaps.length) factsDigestParts.push("VISIBILITY GAPS (no explicit cause recorded):\n" + visibilityGaps.join("\n"));
              const synthesized = await synthesizeCommercialAdvice("What is blocking commercial progress?", factsDigestParts.join("\n\n"), env);
              result = { answer: synthesized || deterministicAnswer, sources };
            }

            else if (question === OPP_Q) {
              // Never treats highest visit volume as opportunity by
              // itself — only positive outcome, repeat engagement, a
              // genuinely new account, or a warm-but-underdeveloped
              // account count as grounded signals here.
              const sources = []; const seen = new Set();
              const opportunities = [];
              const positiveVisits = allVisits.filter(v => v.fields["Outcome"] === "Positive");
              let count = 0;
              positiveVisits.forEach(v => {
                if (count >= 4) return;
                const hasAction = allOpenActions.some(a => (a.fields["Source Visit"] || []).includes(v.id));
                if (!hasAction) {
                  opportunities.push((v.fields["Hospital Name"] || "Unknown account") + " \u2014 positive visit, but the next action is missing.");
                  addVisitSourceLens(sources, seen, v.id, (v.fields["Hospital Name"] || "Account") + " \u2014 positive, no next step");
                  count++;
                }
              });
              const accountStats = {};
              allVisits.forEach(v => {
                const name = v.fields["Hospital Name"];
                if (!name) return;
                if (!accountStats[name]) accountStats[name] = { count: 0, positive: 0 };
                accountStats[name].count++;
                if (v.fields["Outcome"] === "Positive") accountStats[name].positive++;
              });
              Object.keys(accountStats).filter(name => accountStats[name].count >= 2 && accountStats[name].positive >= 1).slice(0, 3).forEach(name => {
                opportunities.push(name + " \u2014 high engagement, " + accountStats[name].count + " visits with positive outcomes recorded.");
              });
              (dashboard.newAccountsFeed || []).slice(0, 2).forEach(r => {
                opportunities.push((r.fields["Hospital Name"] || "Unknown account") + " \u2014 new account pending review.");
              });
              const deterministicAnswer = opportunities.length
                ? "Opportunities to push\n" + opportunities.slice(0, 6).map(l => "\u2022 " + l).join("\n")
                : "No accounts currently show a grounded opportunity signal (positive outcome, repeat engagement, or new account pending review).";
              const synthesized = await synthesizeCommercialAdvice("Which opportunities should we push?", opportunities.join("\n"), env);
              result = { answer: synthesized || deterministicAnswer, sources };
            }

            else { // COACH_Q
              // A single visit is one weak signal, not a verdict — reps
              // with only one recorded visit go to "insufficient
              // evidence" regardless of where that one visit would
              // otherwise fall relative to the team average.
              const recognition = [], coaching = [], insufficientEvidence = [];
              const validReps = repActivities.filter(r => r.visitCount > 0);
              const avgVisits = validReps.length ? validReps.reduce((s, r) => s + r.visitCount, 0) / validReps.length : 0;
              repActivities.forEach(r => {
                if (r.visitCount === 0) { insufficientEvidence.push(r.name + " \u2014 no recorded activity, insufficient evidence to assess."); return; }
                if (r.visitCount === 1) { insufficientEvidence.push(r.name + " \u2014 only one recorded visit, insufficient evidence to assess."); return; }
                if (r.visitCount >= avgVisits * 1.3 && r.overdueActionCount < 2) {
                  recognition.push(r.name + " \u2014 activity ahead of peers (" + r.visitCount + " visits)" + (r.overdueActionCount > 0 ? ", " + r.overdueActionCount + " overdue action" + (r.overdueActionCount !== 1 ? "s" : "") : ", no overdue actions") + ".");
                } else if (r.visitCount < avgVisits * 0.6 || r.overdueActionCount >= 2) {
                  const reason = r.visitCount < avgVisits * 0.6 ? "activity is below peers in the selected period" : r.overdueActionCount + " overdue actions";
                  coaching.push(r.name + " \u2014 " + reason + ".");
                }
              });
              let deterministicAnswer = "";
              if (recognition.length) deterministicAnswer += "Recognition\n" + recognition.slice(0, 3).map(l => "\u2022 " + l).join("\n");
              if (coaching.length) deterministicAnswer += (deterministicAnswer ? "\n\n" : "") + "Coaching\n" + coaching.slice(0, 3).map(l => "\u2022 " + l).join("\n");
              if (insufficientEvidence.length) deterministicAnswer += (deterministicAnswer ? "\n\n" : "") + "Insufficient evidence\n" + insufficientEvidence.slice(0, 3).map(l => "\u2022 " + l).join("\n");
              if (!deterministicAnswer) deterministicAnswer = "All active reps show comparable activity levels \u2014 no clear coaching or recognition signal this period.";
              const factsDigest = recognition.concat(coaching).concat(insufficientEvidence).join("\n");
              const synthesized = await synthesizeCommercialAdvice("Who needs coaching or recognition?", factsDigest, env);
              result = { answer: synthesized || deterministicAnswer, sources: [] };
            }

            console.log(`[ask-fieldiq-debug] lens answered: question="${question}", sources=${result.sources.length}`);
            return json({ answer: result.answer, sources: result.sources });
          } catch (lensErr) {
            console.log(`[ask-fieldiq-debug] lens computation failed: ${lensErr.message}`);
            return json({ error: "Could not compute this answer right now." }, 502);
          }
        }

        const lines = [];
        lines.push(`TODAY: ${dashboard.kpi.today} visits, ${dashboard.kpi.repCount} active reps, ${dashboard.kpi.newAccountsPending} new accounts pending review.`);

        const radarTop = (dashboard.managementRadar || []).slice(0, 8);
        if (radarTop.length) {
          lines.push("ACCOUNTS FLAGGED BY MANAGEMENT RADAR (ranked, most urgent first):");
          radarTop.forEach((acc, i) => {
            lines.push(`${i + 1}. ${acc.name} (${acc.territory || "Unknown territory"}) — ${(acc.evidence || []).join("; ")}`);
          });
        } else {
          lines.push("No accounts currently flagged by Management Radar.");
        }

        const highCount = ((dashboard.priorityReview && dashboard.priorityReview.high) || []).length;
        const medCount = ((dashboard.priorityReview && dashboard.priorityReview.medium) || []).length;
        lines.push(`UNREVIEWED VISITS AWAITING MANAGER REVIEW: ${highCount} high priority, ${medCount} medium priority.`);

        const newAccountsTop = (dashboard.newAccountsFeed || []).slice(0, 5);
        if (newAccountsTop.length) {
          lines.push("NEW ACCOUNTS PENDING REVIEW: " + newAccountsTop.map(r => (r.fields && r.fields["Hospital Name"]) || "Unknown").join(", "));
        }

        const territoriesTop = (dashboard.territories || []).slice(0, 6);
        if (territoriesTop.length) {
          lines.push("TERRITORY ACTIVITY: " + territoriesTop.map(t => `${t.name} (${t.count} visits)`).join(", "));
        }

        const repsTop = (dashboard.reps || []).slice(0, 8);
        if (repsTop.length) {
          lines.push("REP ACTIVITY: " + repsTop.map(r => `${r.name} (${r.count} visits, ${r.sentiment} sentiment)`).join(", "));
        }

        const contextDigest = lines.join("\n");

        // Sources are assembled here, deterministically, from the exact
        // same real record IDs already computed above — never extracted
        // from the model's own prose. This guarantees every ID returned
        // genuinely exists in Airtable, regardless of what the model
        // says. Deduplicated by ID; null/missing IDs are never included.
        //
        // Account entries use the account NAME as the link parameter,
        // not a fabricated record ID — Management Radar's computation
        // never resolves an Account table record ID for these entries,
        // only a name string, so this uses what's genuinely available
        // rather than inventing an ID that was never actually computed.
        const seenVisitIds = new Set();
        const seenActionIds = new Set();
        const seenAccountNames = new Set();
        const sources = [];
        function addVisitSource(id, label) {
          if (!id || seenVisitIds.has(id)) return;
          seenVisitIds.add(id);
          sources.push({ type: "visit", id: id, label: label, url: "./fieldiq-visit-history.html?visitId=" + encodeURIComponent(id) });
        }
        function addActionSource(id, label) {
          if (!id || seenActionIds.has(id)) return;
          seenActionIds.add(id);
          sources.push({ type: "action", id: id, label: label, url: "./fieldiq-actions.html?actionId=" + encodeURIComponent(id) });
        }
        function addAccountSource(name) {
          if (!name || seenAccountNames.has(name)) return;
          seenAccountNames.add(name);
          // fieldiq-accounts.html does not currently accept a search/
          // filter query parameter — confirmed by inspection, not
          // assumed. Linking to a fabricated ?search= param would silently
          // do nothing once clicked. This links to the real directory
          // page instead; the account name stays in the label so the
          // manager knows what to look for.
          sources.push({ type: "account", id: name, label: name, url: "./fieldiq-accounts.html" });
        }
        radarTop.forEach(acc => {
          addAccountSource(acc.name);
          if (acc.highPriorityVisitId) addVisitSource(acc.highPriorityVisitId, acc.name + " — High Priority visit");
          if (acc.negativeVisitId) addVisitSource(acc.negativeVisitId, acc.name + " — Negative outcome visit");
          if (acc.visitId && !acc.highPriorityVisitId && !acc.negativeVisitId) addVisitSource(acc.visitId, acc.name + " — most recent visit");
          if (acc.followUpOverdueActionId) addActionSource(acc.followUpOverdueActionId, acc.name + " — overdue follow-up");
          if (acc.followUpDueTodayActionId) addActionSource(acc.followUpDueTodayActionId, acc.name + " — follow-up due today");
        });
        ((dashboard.priorityReview && dashboard.priorityReview.high) || []).forEach(r => {
          if (r.id) addVisitSource(r.id, (r.fields && r.fields["Hospital Name"] || "Unknown account") + " — unreviewed High Priority visit");
        });
        ((dashboard.priorityReview && dashboard.priorityReview.medium) || []).forEach(r => {
          if (r.id) addVisitSource(r.id, (r.fields && r.fields["Hospital Name"] || "Unknown account") + " — unreviewed Medium Priority visit");
        });

        function buildDeterministicManagerFallback() {
          const parts = ["The AI assistant is temporarily unavailable, so here is a direct data summary instead."];
          if (radarTop.length) {
            parts.push("Top flagged accounts: " + radarTop.slice(0, 3).map(a => a.name + " (" + (a.evidence || []).join(", ") + ")").join("; ") + ".");
          } else {
            parts.push("No accounts are currently flagged by Management Radar.");
          }
          if (highCount || medCount) {
            parts.push(highCount + " high priority and " + medCount + " medium priority visit" + ((highCount + medCount) !== 1 ? "s" : "") + " are awaiting your review.");
          }
          if (newAccountsTop.length) {
            parts.push(newAccountsTop.length + " new account" + (newAccountsTop.length !== 1 ? "s" : "") + " pending review.");
          }
          return parts.join(" ");
        }

        // Structured daily briefing — same philosophy as the rep briefing:
        // sections are built here, deterministically, from the exact same
        // data already computed above for the free-text path. AI writes
        // only a single short opening sentence, built from counts alone,
        // never given a specific account to work with. This branch only
        // fires for the one fixed, known briefing question the manager
        // home screen sends automatically — every other question (the
        // five Ask FieldIQ buttons) falls through completely unchanged to
        // the existing free-text prompt below.
        const MANAGER_BRIEFING_QUESTION_TEXT = "Give me a short daily briefing: top priorities today, accounts needing immediate attention, overdue follow-ups, high-risk customers, new business opportunities, and any reps who may need coaching based on their activity.";
        if (question === MANAGER_BRIEFING_QUESTION_TEXT) {
          function withPeriodMgr(s) { s = String(s || "").trim(); if (!s) return s; return /[.!?]$/.test(s) ? s : s + "."; }
          const mgrSections = [];

          // Needs Review — the same flagged accounts already computed
          // above, each with its own specific destination instead of a
          // generic button.
          const needsReviewItems = radarTop.slice(0, 4).map(acc => {
            let nav = null;
            if (acc.highPriorityVisitId) nav = { label: "Open Visit", url: "./fieldiq-visit-history.html?visitId=" + encodeURIComponent(acc.highPriorityVisitId) };
            else if (acc.negativeVisitId) nav = { label: "Open Visit", url: "./fieldiq-visit-history.html?visitId=" + encodeURIComponent(acc.negativeVisitId) };
            else if (acc.followUpOverdueActionId) nav = { label: "Open Action", url: "./fieldiq-actions.html?actionId=" + encodeURIComponent(acc.followUpOverdueActionId) };
            else if (acc.visitId) nav = { label: "Open Visit", url: "./fieldiq-visit-history.html?visitId=" + encodeURIComponent(acc.visitId) };
            return { text: acc.name + " — " + withPeriodMgr((acc.evidence || []).join("; ")).replace(/\.$/, ""), nav: nav };
          });
          if (highCount || medCount) {
            needsReviewItems.push({ text: highCount + " high priority and " + medCount + " medium priority visit" + ((highCount + medCount) !== 1 ? "s" : "") + " awaiting review.", nav: { label: "View Dashboard", url: "./dashboard.html" } });
          }
          mgrSections.push({
            icon: "\uD83C\uDFAF",
            title: "Needs Review",
            items: needsReviewItems.length ? needsReviewItems : [{ text: "No accounts currently flagged for review.", nav: null }]
          });

          // Rep Coverage — reps with genuinely zero activity this period.
          //
          // dashboard.reps is built by iterating Field Visits records —
          // a rep only gets an entry in it when at least one visit
          // exists for them in the current period. That means it can
          // NEVER contain a zero-count entry by construction, so
          // filtering it for count===0 always returns empty and this
          // section would always claim "all reps active" regardless of
          // how many reps had genuinely done nothing. Fixed by fetching
          // the real active Sales Rep list from Users and computing the
          // true difference: active reps who are simply absent from
          // dashboard.reps, not reps with a count that was never there
          // to find. If that fetch fails for any reason, this section
          // says coverage could not be verified — it never falls back to
          // claiming "all active" on an assumption it hasn't checked.
          let repCoverageItems;
          try {
            function isExplicitlyInactiveRC(value) {
              if (value === false) return true;
              if (typeof value === "string") {
                const v = value.trim().toLowerCase();
                return v === "false" || v === "no" || v === "0" || v === "inactive";
              }
              return false;
            }
            // Filtered by Role only — see the identical fix and full
            // reasoning in gatherLensRawData above: a bare {Active?}
            // reference inside filterByFormula only evaluates correctly
            // against a genuine Airtable Checkbox field, and silently
            // returning zero rows here would make this section falsely
            // claim "all reps active" — precisely the false-positive
            // this section exists to prevent.
            const repUserParams = new URLSearchParams();
            repUserParams.append("filterByFormula", `{Role}="Sales Rep"`);
            ["Display Name","Active?"].forEach(f => repUserParams.append("fields[]", f));
            let allRepUsersRaw = [], repUserOffset = null;
            do {
              if (repUserOffset) repUserParams.set("offset", repUserOffset);
              const repUserRes = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Users?${repUserParams.toString()}`, { headers: airtableHeaders() });
              const repUserData = await repUserRes.json();
              if (!repUserRes.ok) throw new Error("Users lookup failed: " + JSON.stringify(repUserData));
              allRepUsersRaw = allRepUsersRaw.concat(repUserData.records || []);
              repUserOffset = repUserData.offset || null;
            } while (repUserOffset);
            const allRepUsers = allRepUsersRaw.filter(u => !isExplicitlyInactiveRC(u.fields["Active?"]));

            // Same title-case normalization dashboard.reps already
            // applies to Rep Name, so "REP 5" in Users and "Rep 5" as a
            // dashboard.reps key are recognized as the same rep rather
            // than falsely mismatching on casing alone.
            function normalizeRepName(raw) {
              const t = String(raw || "").trim();
              return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
            }
            const activeRepNames = allRepUsers.map(u => normalizeRepName(u.fields["Display Name"])).filter(Boolean);
            const namesWithVisits = new Set((dashboard.reps || []).map(r => r.name));
            const trueZeroActivityNames = activeRepNames.filter(name => !namesWithVisits.has(name));

            repCoverageItems = trueZeroActivityNames.length
              ? trueZeroActivityNames.slice(0, 4).map(name => ({ text: name + " — no logged activity this period.", nav: null }))
              : [{ text: "All active reps have logged activity this period.", nav: null }];
          } catch (repCoverageErr) {
            console.log(`[ask-fieldiq-debug] Rep Coverage check failed: ${repCoverageErr.message}`);
            repCoverageItems = [{ text: "Rep coverage could not be verified right now.", nav: null }];
          }
          mgrSections.push({
            icon: "\uD83D\uDC65",
            title: "Rep Coverage",
            items: repCoverageItems
          });

          // Territory Activity — top territories, already-computed data.
          mgrSections.push({
            icon: "\uD83D\uDCCD",
            title: "Territory Activity",
            items: territoriesTop.length
              ? territoriesTop.slice(0, 4).map(t => ({ text: t.name + " — " + t.count + " visit" + (t.count !== 1 ? "s" : "") + ".", nav: null }))
              : [{ text: "No territory activity recorded yet.", nav: null }]
          });

          // Today — plain factual counts, zero AI involved.
          mgrSections.push({
            icon: "\u2705",
            title: "Today",
            items: [
              { text: dashboard.kpi.today + " visit" + (dashboard.kpi.today !== 1 ? "s" : "") + " logged today.", nav: null },
              { text: newAccountsTop.length ? newAccountsTop.length + " new account" + (newAccountsTop.length !== 1 ? "s" : "") + " pending review." : "No new accounts pending review.", nav: newAccountsTop.length ? { label: "View Dashboard", url: "./dashboard.html" } : null }
            ]
          });

          function buildDeterministicManagerTopLine() {
            if (radarTop.length) return "You have " + radarTop.length + " account" + (radarTop.length !== 1 ? "s" : "") + " that need" + (radarTop.length === 1 ? "s" : "") + " a look today.";
            if (highCount || medCount) return "Nothing flagged, but some visits are still awaiting your review.";
            return "Territory is quiet — nothing urgent right now.";
          }

          let mgrTopLine, mgrUsedFallback = false;
          const topLinePrompt = `You are an executive assistant writing a ONE-SENTENCE opening line for a sales manager's daily briefing. Use ONLY the counts below — never invent an account name or detail. Describe only the overall shape of the day. Plain English, no markdown, second person, under 15 words.

FLAGGED ACCOUNTS: ${radarTop.length}
UNREVIEWED VISITS: ${highCount + medCount}
NEW ACCOUNTS PENDING: ${newAccountsTop.length}

One-sentence opening line:`;
          try {
            const topLineRes = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
              body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 60, messages: [{ role: "user", content: topLinePrompt }] })
            });
            const topLineData = await topLineRes.json();
            if (!topLineRes.ok || !topLineData.content || !topLineData.content[0] || !topLineData.content[0].text) {
              mgrTopLine = buildDeterministicManagerTopLine();
              mgrUsedFallback = true;
            } else {
              mgrTopLine = topLineData.content[0].text.trim();
            }
          } catch (e) {
            mgrTopLine = buildDeterministicManagerTopLine();
            mgrUsedFallback = true;
          }

          return json({
            greeting: "Good day.",
            topLine: mgrTopLine,
            sections: mgrSections,
            sources: sources,
            usedFallback: mgrUsedFallback
          });
        }

        const prompt = `You are the FieldIQ Deal Intelligence Agent, helping a sales manager understand their territory. You are not a chatbot — give one short, practical, business-focused answer to the manager's specific question below. Plain English, sales-focused, actionable. Reference specific account names from the data when relevant — name the actual accounts, do not give generic advice. If the data provided does not contain what's needed to fully answer, say so plainly rather than guessing or inventing information. Keep the answer under 120 words and do not use markdown formatting.

CURRENT FIELDIQ DATA:
${contextDigest}

MANAGER'S QUESTION:
${question}

Answer:`;

        let answerText, usedFallback = false;
        try {
          const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: prompt }] })
          });
          const aiData = await aiRes.json();
          if (!aiRes.ok || !aiData.content || !aiData.content[0] || !aiData.content[0].text) {
            console.log(`[ask-fieldiq-debug] Anthropic call FAILED: status=${aiRes.status}, using deterministic fallback`);
            answerText = buildDeterministicManagerFallback();
            usedFallback = true;
          } else {
            answerText = aiData.content[0].text.trim();
          }
        } catch (aiErr) {
          console.log(`[ask-fieldiq-debug] Anthropic call threw: ${aiErr.message}, using deterministic fallback`);
          answerText = buildDeterministicManagerFallback();
          usedFallback = true;
        }

        console.log(`[ask-fieldiq-debug] responding: usedFallback=${usedFallback}, sources=${sources.length}`);
        return json({ answer: answerText, sources: sources, usedFallback: usedFallback });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // POST / — Claude AI
    if (url.pathname === "/") {
      try {
        const body = await req.json();
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify(body)
        });
        const data = await response.json();
        return json(data, response.status);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    return json({ error: "Unknown endpoint: " + url.pathname }, 404);
  }
};
