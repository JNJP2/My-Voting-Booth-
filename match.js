// Issues quiz -> political-leaning gauge. Runs entirely in the browser: answers never leave this device.
// Depends on helpers from index.html (esc).
const Match = (() => {
  const LABELS = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];
  const WEIGHTS = [["0", "Skip"], ["1", "Somewhat important"], ["2", "Important"], ["3", "Top priority"]];
  let issues = [];

  async function load() {
    issues = (await (await fetch("/data/issues.json")).json()).issues;
  }

  // Each answer becomes a lean in [-1 (left), +1 (right)] using the issue's direction, weighted by importance.
  function analyze(answers) {
    let sum = 0, total = 0, left = 0, right = 0, rows = [];
    for (const i of issues) {
      const a = answers[i.id];
      if (!a) continue;
      const lean = i.agreeLeans ? (a.v / 2) * i.agreeLeans : 0;
      const counted = i.agreeLeans !== 0 && a.v !== 0;
      if (i.agreeLeans !== 0) { sum += a.w * lean; total += a.w; }
      if (counted) lean < 0 ? left++ : right++;
      rows.push({ issue: i, answer: a.v, lean, mapped: i.agreeLeans !== 0 });
    }
    return { score: total ? sum / total : null, left, right, rows, counted: rows.filter(x => x.mapped).length };
  }

  function label(s) {
    const m = Math.abs(s);
    if (m < 0.15) return "Centrist / balanced";
    return `${m < 0.4 ? "Leans" : m < 0.7 ? "Moderately" : "Strongly"} ${s < 0 ? "left" : "right"}`;
  }

  function resultHtml(r) {
    if (r.score === null || r.counted < 3) return `<div class="card"><b>A few more answers needed.</b> You've answered ${r.counted} left/right issue${r.counted === 1 ? "" : "s"}; answer at least 3 for a meaningful result. You can skip any others.</div>`;
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
      <p class="note">This is a simplified, one-dimensional snapshot based only on the issues you answered, weighted by how much each matters to you. It isn't a label or a voting recommendation. Housing and foreign policy don't map cleanly onto left versus right, so they aren't counted.</p></div>`;
  }

  function renderQuiz(el) {
    el.innerHTML = `<details class="card quiz" id="quizBox"><summary><b>🧭 How Do I Lean?</b>
        <span class="meta"> (optional · 2 minutes · answers stay on your device)</span></summary>
      <p class="meta">Say how much you agree with each statement and how much it matters to you. We'll show where your answers fall on the left-right spectrum. <b>Leave any you'd rather not answer blank</b>; you'll still get a result from the rest.</p>
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
      show(resultHtml(r));
      el.querySelector("#quizBox").open = false;
      out.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    el.querySelector("#qclear").addEventListener("click", () => { el.querySelector("#qf").reset(); out.innerHTML = ""; });
  }

  return { async init(el) { await load(); renderQuiz(el); } };
})();
