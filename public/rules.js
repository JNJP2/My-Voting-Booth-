// "What do I need to vote?" panel: voter ID rules by state (data: /data/voting_rules.json).
// Depends on helpers from index.html (esc, safeUrl).
const Rules = (() => {
  const SUMMARY = {
    "strict-photo": ["Photo ID required", "You must show an accepted photo ID. Without one you can usually vote a provisional ballot, but it only counts if you show ID afterward."],
    "nonstrict-photo": ["Photo ID requested", "You're asked to show a photo ID, but if you don't have one there is another way to vote (such as signing an affidavit)."],
    "strict-nonphoto": ["ID required (photo not always needed)", "You must show identification, which may be a non-photo document. Without it you usually vote a provisional ballot and must follow up."],
    "nonstrict-nonphoto": ["ID requested (photo not required)", "You're asked to show identification or sign a statement, and there is a fallback if you can't."],
    "none": ["No ID document generally required", "Most voters don't need to show ID at the polls. First-time voters who didn't give ID when registering may still be asked for it."],
  };
  let data = null, el = null, officials = {};

  async function init(container) {
    el = container;
    data = await (await fetch("/data/voting_rules.json")).json();
    el.innerHTML = `<details class="card rules" id="rulesBox"><summary><b>🪪 What do I need to vote?</b>
        <span class="meta"> (ID rules by state)</span></summary>
      <label class="imp">State <select id="rulesState"><option value="">Choose a state…</option>
        ${data.states.map(s => `<option value="${s.code}">${esc(s.name)}</option>`).join("")}</select></label>
      <div id="rulesOut"></div></details>`;
    el.querySelector("#rulesState").addEventListener("change", e => show(e.target.value));
  }

  function show(code) {
    const out = el.querySelector("#rulesOut"), s = data.states.find(x => x.code === code);
    if (!s) { out.innerHTML = ""; return; }
    const [title, plain] = SUMMARY[s.id];
    const links = [[officials.registrationUrl, "Check or update your registration"], [officials.url, "Your state election office"]]
      .filter(([u]) => safeUrl(u)).map(([u, t]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${t}</a></li>`).join("");
    out.innerHTML = `<h3 style="margin-top:14px">${esc(s.name)}: ${title}</h3>
      <p>${plain}</p>${s.note ? `<p class="meta">${esc(s.note)}</p>` : ""}
      <p class="meta"><b>Also check with your state:</b> registration deadlines, early and mail voting rules, and what to bring if you registered recently. Many deadlines are close or have passed, and rules change often.</p>
      <ul><li><a href="https://vote.gov" target="_blank" rel="noopener">vote.gov: official U.S. government voting information</a></li>${links}</ul>
      <p class="note">Source: <a href="${esc(data.source.url)}" target="_blank" rel="noopener">${esc(data.source.name)}</a> (${esc(data.source.asOf)}). ${esc(data.caveats)}</p>`;
  }

  // Called after an address lookup: select that state and attach its official links.
  function setState(code, o) {
    if (!el || !data || !code) return;
    officials = o || {};
    const sel = el.querySelector("#rulesState");
    if (data.states.some(s => s.code === code.toUpperCase())) { sel.value = code.toUpperCase(); show(sel.value); }
  }

  return { init, setState };
})();
