export default {
  async fetch(req, env, ctx) {
    const h = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type"
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
          "Longitude","Accuracy","New Account","Pending Review","Reviewed","Account","Photo URLs"
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
    if (req.method === "GET" && url.pathname === "/get-dashboard") {
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
          if (tu.indexOf("SAUDI ARABIA") === 0 || tu === "KSA") return "KSA";
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

    // GET /get-users
    if (req.method === "GET" && url.pathname === "/get-users") {
      const _hit = await cache.match(req);
      if (_hit) return _hit;
      try {
        const fields = ["User ID", "Display Name", "Role", "Territory", "Email", "Active?", "PIN"];
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
        if (!res.ok) return json({ territory: "" });
        return json({ territory: (data.fields && data.fields["Territory"]) || "" });
      } catch (err) {
        return json({ territory: "" });
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
          if (tu.indexOf("SAUDI ARABIA") === 0 || tu === "KSA") return "KSA";
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

    if (req.method !== "POST" && req.method !== "PATCH") {
      return new Response("Method not allowed", { status: 405, headers: h });
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
        const body = await req.json();
        const actionId = body.actionId;
        const userId = body.userId;

        if (!actionId || !userId) {
          return json({ error: "actionId and userId required" }, 400);
        }

        const userRecordId = await findUserRecordIdByUserId(userId);
        if (!userRecordId) return json({ error: "User not found" }, 400);

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
        const body = await req.json();
        const actionId = body.actionId;
        const userId = body.userId;

        if (!actionId || !userId) {
          return json({ error: "actionId and userId required" }, 400);
        }

        const userRecordId = await findUserRecordIdByUserId(userId);
        if (!userRecordId) return json({ error: "User not found" }, 400);

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
        const response = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/Field%20Visits`, { method: "POST", headers: airtableHeaders(), body: JSON.stringify({ fields: visitData }) });
        const data = await response.json();
        if (response.ok) {
          ctx.waitUntil(cache.delete(new Request(new URL("/get-visits", req.url).toString())));
          ctx.waitUntil(cache.delete(new Request(new URL("/get-dashboard", req.url).toString())));
          ctx.waitUntil(cache.delete(new Request(new URL("/get-watchlist", req.url).toString())));
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
