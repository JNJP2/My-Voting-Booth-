// Issues quiz -> political-leaning gauge -> candidate alignment.
// Runs entirely in the browser: quiz answers never leave this device. Depends on helpers from index.html (esc, safeUrl, partyClass).
const Match = (() => {
  const LABELS = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];
  const WEIGHTS = [["0", "Skip"], ["1", "Somewhat important"], ["2", "Important"], ["3", "Top priority"]];
  const MIN_ISSUES = 3;   // answers (or sourced stances) needed before we show a score
  let issues = [], congress = null, manual = new Map(), lean = null, state = "", onChange = () => {};
  const api = { sortByMatch: false };

  async function load() {
    issues = (await (await fetch("/data/issues.json")).json()).issues;
    const get = async u => { try { const r = await fetch(u); return r.ok ? r.json() : null; } catch { return null; } };
    congress = await get("/data/congress_scores.json");
    for (const c of (await get("/data/candidate_positions.json"))?.candidates || []) manual.set(key(c.name, c.office), c);
  }

  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();
  const key = (name, office) => `${norm(office)}|${norm(name)}`;

  // ---- the voter's own lean from the quiz ------------------------------------------------------
  function analyze(answers) {
    let sum = 0, total = 0, left = 0, right = 0, rows = [];
    for (const i of issues) {
      const a = answers[i.id];
      if (!a) continue;
      const l = i.agreeLeans ? (a.v / 2) * i.agreeLeans : 0;
      const counted = i.agreeLeans !== 0 && a.v !== 0;
      if (i.agreeLeans !== 0) { sum += a.w * l; total += a.w; }
      if (counted) l < 0 ? left++ : right++;
      rows.push({ issue: i, answer: a.v, lean: l, mapped: i.agreeLeans !== 0 });
    }
    return { score: total ? sum / total : null, left, right, rows, counted: rows.filter(x => x.mapped).length };
  }

  function label(s) {
    const m = Math.abs(s);
    if (m < 0.15) return "Centrist / balanced";
    return `${m < 0.4 ? "Leans" : m < 0.7 ? "Moderately" : "Strongly"} ${s < 0 ? "left" : "right"}`;
  }

  // ---- finding data for a candidate ------------------------------------------------------------
  function nameParts(full) {
    let n = String(full || "");
    if (n.includes(",")) { const [l, f] = n.split(","); n = `${f} ${l}`; }
    const t = norm(n).split(" ").filter(Boolean);
    return { first: t[0] || "", full: t.join(" ") };
  }

  // Conservative: match only on chamber + state + district (if known) + last name + first name. Otherwise "no data".
  function congressRecord(cand, contest) {
    if (!congress || contest.level !== "federal" || !state) return null;
    const office = contest.office.toLowerCase();
    const chamber = /senat/.test(office) ? "Senate" : /(house|representative)/.test(office) ? "House" : null;
    if (!chamber) return null;
    const dm = /(\d{1,2})(?!\d)/.exec(contest.district || "");
    const { first, full } = nameParts(cand.name);
    const hits = congress.members.filter(m => {
      if (m.chamber !== chamber || m.state !== state) return false;
      if (chamber === "House" && dm && m.district !== +dm[1]) return false;
      const last = norm(m.last);
      if (!(full === last || full.endsWith(" " + last))) return false;
      const names = [norm(m.first), norm(m.nick)].filter(Boolean);
      return names.some(n => n === first || (n.length >= 3 && first.length >= 3 && (n.startsWith(first) || first.startsWith(n))));
    });
    if (hits.length !== 1) return null; // ambiguous or absent: don't guess
    const m = hits[0];
    return { lean: m.score, basis: "voting", detail: `Overall voting record in the ${congress.congress}th Congress (${m.party}, ${m.chamber === "Senate" ? "Senate" : "House"}).`, source: congress.source };
  }

  function manualRecord(cand, contest) {
    const rec = manual.get(key(cand.name, contest.office));
    if (!rec) return null;
    let sum = 0, rows = [];
    for (const i of issues) {
      const s = rec.stances?.[i.id];
      if (!s || !i.agreeLeans) continue;
      sum += (s.v / 2) * i.agreeLeans;
      rows.push({ issue: i, them: s.v, src: s.src, url: s.url });
    }
    if (rows.length < MIN_ISSUES) return null;
    return { lean: sum / rows.length, basis: "stances", rows, detail: `Positions we could source on ${rows.length} issues.` };
  }

  const record = (c, contest) => manualRecord(c, contest) || congressRecord(c, contest);
  const alignment = r => Math.round(100 * (1 - Math.abs(lean - r.lean) / 2));

  function candidateHtml(c, contest) {
    const r = record(c, contest);
    const name = safeUrl(c.url) ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : esc(c.name);
    let extra;
    if (!r) {
      extra = `<div class="nodata"><b>No data found.</b> We couldn't find a voting record or sourced positions for this candidate. That is common for challengers, newer candidates and local races, and it says nothing about where they stand. Check their campaign website or a voter guide.</div>`;
    } else {
      const pct = alignment(r);
      extra = `<div class="bar" role="img" aria-label="${pct}% aligned"><span style="width:${pct}%"></span></div>
        <div class="meta"><b>${pct}% aligned</b> with your overall leaning · ${esc(r.detail)}
        ${r.source ? `<a href="${esc(r.source.url)}" target="_blank" rel="noopener">${esc(r.source.name)}</a>` : ""}</div>`;
      if (r.basis === "stances") extra += `<details><summary>Positions and sources</summary><table class="cmp">
        ${r.rows.map(x => `<tr><td>${esc(x.issue.title)}</td><td>${LABELS[x.them + 2]}</td><td>${safeUrl(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">source</a>` : esc(x.src || "")}</td></tr>`).join("")}</table></details>`;
    }
    return { r, html: `<li class="cand cand-m"><div class="top"><span>${name}</span><span class="pill ${partyClass(c.party)}">${esc(c.party)}</span></div>${extra}</li>` };
  }

  function candidateList(contest) {
    const items = contest.candidates.map(c => ({ c, ...candidateHtml(c, contest) }));
    const last = x => x.c.name.split(" ").pop();
    items.sort((a, b) => last(a).localeCompare(last(b)));  // neutral default: alphabetical by last name
    if (api.sortByMatch) items.sort((a, b) => (b.r ? alignment(b.r) : -1) - (a.r ? alignment(a.r) : -1));
    return `<ul>${items.map(x => x.html).join("")}</ul>`;
  }

  function noticeHtml() {
    return `<label class="sortbar"><input type="checkbox" id="sortm" ${api.sortByMatch ? "checked" : ""}> Sort by best match (default is alphabetical by last name)</label>
      <div class="banner"><b>How to read candidate matches:</b> your quiz answers give an overall left-to-right leaning (${label(lean)}). Where we found a candidate's
      record, we show how close it is to yours. Today that mostly means current members of Congress, using their overall voting records, so it isn't issue-by-issue.
      Candidates marked <b>No data found</b> have no match here, which says nothing about their views. This is not an endorsement. Read candidates' own words before you decide.</div>`;
  }

  // ---- quiz UI ---------------------------------------------------------------------------------
  function resultHtml(r) {
    if (r.score === null || r.counted < MIN_ISSUES) return `<div class="card"><b>A few more answers needed.</b> You've answered ${r.counted} left/right issue${r.counted === 1 ? "" : "s"}; answer at least 3 for a meaningful result. You can skip any others.</div>`;
    const pos = Math.round((r.score + 1) / 2 * 100);
    const mixed = r.left >= 2 && r.right >= 2;
    const chip = x => !x.mapped ? "not counted" : x.answer === 0 ? "neutral" : x.lean < 0 ? "left-leaning answer" : "right-leaning answer";
    return `<div class="card" style="border-left-color:var(--navy2)"><h3>Your political leaning</h3>
      <div class="lean-label">${label(r.score)}</div>
      <div class="gauge" role="img" aria-label="${label(r.score)}"><span class="dot" style="left:50%" data-pos="${pos}"></span></div>
      <div class="gauge-ends"><span>Left</span><span>Center</span><span>Right</span></div>
      ${mixed ? `<p class="meta">Your answers are <b>mixed</b>: ${r.left} lean left and ${r.right} lean right. A single left-to-right line can hide that, so look at the issue list.</p>` : ""}
      <details><summary>How each answer counted</summary><table class="cmp">
        ${r.rows.map(x => `<tr><td>${esc(x.issue.title)}</td><td>${LABELS[x.answer + 2]}</td><td><span class="chip">${chip(x)}</span></td></tr>`).join("")}</table></details>
      <p class="note">This is a simplified, one-dimensional snapshot based only on the issues you answered, weighted by how much each matters to you. It isn't a label or a voting recommendation. Housing and foreign policy don't map cleanly onto left versus right, so they aren't counted. Candidate matches below use this same line.</p></div>`;
  }

  function renderQuiz(el) {
    el.innerHTML = `<details class="card quiz" id="quizBox"><summary><b>🧭 How Do I Lean?</b>
        <span class="meta"> (optional · 2 minutes · answers stay on your device)</span></summary>
      <p class="meta">Say how much you agree with each statement and how much it matters to you. We'll show where your answers fall on the left-right spectrum, and how that compares with candidates where we have data. <b>Leave any you'd rather not answer blank</b>; you'll still get a result from the rest.</p>
      <form id="qf">${issues.map(i => `<fieldset><legend><b>${esc(i.title)}</b><br>${esc(i.statement)}</legend>
        <div class="opts">${LABELS.map((l, k) => `<label><input type="radio" name="${i.id}" value="${k - 2}"><span>${l}</span></label>`).join("")}</div>
        <label class="imp">Importance <select name="w_${i.id}">${WEIGHTS.map(([v, t]) => `<option value="${v}"${v === "2" ? " selected" : ""}>${t}</option>`).join("")}</select></label>
      </fieldset>`).join("")}
      <button type="submit">Show How I Lean</button> <button type="button" id="qclear" class="ghost">Clear</button></form></details>
      <div id="leanOut"></div>`;
    const out = el.querySelector("#leanOut");
    const show = html => {
      out.innerHTML = html;
      const dot = out.querySelector(".gauge .dot");
      // Force layout so the slide animates; use a timer rather than rAF so it also runs in background tabs.
      if (dot) { const w = dot.dataset.pos; out.offsetWidth; setTimeout(() => dot.style.left = w + "%", 30); }
    };
    el.querySelector("#qf").addEventListener("submit", e => {
      e.preventDefault();
      const f = new FormData(e.target), a = {};
      for (const i of issues) {
        const v = f.get(i.id), w = +f.get("w_" + i.id);
        if (v !== null && w > 0) a[i.id] = { v: +v, w };
      }
      const r = analyze(a);
      lean = r.score !== null && r.counted >= MIN_ISSUES ? r.score : null;
      show(resultHtml(r));
      el.querySelector("#quizBox").open = false;
      out.scrollIntoView({ behavior: "smooth", block: "nearest" });
      onChange();
    });
    el.querySelector("#qclear").addEventListener("click", () => { el.querySelector("#qf").reset(); out.innerHTML = ""; lean = null; onChange(); });
  }

  return Object.assign(api, {
    async init(el, cb) { if (cb) onChange = cb; await load(); renderQuiz(el); },
    active: () => lean !== null,
    setState: s => { state = String(s || "").toUpperCase(); },
    candidateList, noticeHtml,
  });
})();
