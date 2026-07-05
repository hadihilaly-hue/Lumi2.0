// ─── TEACHER ACCESS CONFIG — SINGLE SOURCE OF TRUTH ──────────────────────────
// AUDIT_FRONTEND H3/F1: the teacher email list and the teacher-mode allowlist
// used to be hand-copied into app.js, teacher.html, and admin.html and had
// already drifted. They now live here, in ONE classic <script>, consumed by:
//   • the app.html ES modules — js/teachers.js re-exports these globals
//     (loaded before the module bootstrap, same pattern as cognito-auth.js's
//     `sb`), and
//   • the standalone classic pages teacher.html / admin.html, which alias
//     `window.TEACHER_EMAIL_MAP` instead of redeclaring the literal.
// Edit teachers/allowlist HERE only. This is a plain (non-module) script so
// both the module and non-module worlds can load it via <script src>.
//
// NOTE: MENLO_CURRICULUM is intentionally NOT centralized here — its per-page
// copies have diverged in course content (e.g. teacher.html's test course,
// lumi.html's Algebra 2 roster), so merging them is a behavior change that
// needs product sign-off, out of scope for this access-config consolidation.
(function (g) {
  // Maps teacher display name → real @menloschool.org email. Every teacher
  // access decision (teacher.html gate, student-side profile lookup) resolves
  // through this map.
  g.TEACHER_EMAIL_MAP = {
    "Rachel Blumenthal":      "rblumenthal@menloschool.org",
    "Whitney Newton":         "wnewton@menloschool.org",
    "Margaret Ramsey":        "mramsey@menloschool.org",
    "Andrew Warren":          "awarren@menloschool.org",
    "Jay Bush":               "jbush@menloschool.org",
    "Lily Chan":              "lchan@menloschool.org",
    "Rebecca Gertmenian":     "rgertmenian@menloschool.org",
    "Meghann Schroers-Martin":"mschroers-martin@menloschool.org",
    "Tom Garvey":             "tgarvey@menloschool.org",
    "Oscar King":             "oking@menloschool.org",
    "Maura Sincoff":          "msincoff@menloschool.org",
    "Cara Plamondon":         "cplamondon@menloschool.org",
    "Bridgett Longust":       "blongust@menloschool.org",
    "Sabahat Adil":           "sadil@menloschool.org",
    "Franco Cruz-Ochoa":      "fcruz-ochoa@menloschool.org",
    "Katharine Hanson":       "khanson@menloschool.org",
    "Nicholas Merlesena":     "nmerlesena@menloschool.org",
    "Miles Bennett-Smith":    "mbennett-smith@menloschool.org",
    "Glenn Davis":            "gdavis@menloschool.org",
    "Trevor McNeil":          "tmcneil@menloschool.org",
    "Joseph Mitchell":        "jmitchell@menloschool.org",
    "Jack Bowen":             "jbowen@menloschool.org",
    "Dylan Citrin Cummins":   "dcitrin-cummins@menloschool.org",
    "Charles Hanson":         "chanson@menloschool.org",
    "Matthew Nelson":         "mnelson@menloschool.org",
    "John Schafer":           "jschafer@menloschool.org",
    "Peter Brown":            "pbrown@menloschool.org",
    "Christine Walters":      "cwalters@menloschool.org",
    "Rebecca Akers":          "rakers@menloschool.org",
    "Joe Rabison":            "jrabison@menloschool.org",
    "Sujata Ganpule":         "sganpule@menloschool.org",
    "Randall Joss":           "rjoss@menloschool.org",
    "Nandhini Namasivayam":   "nnamasivayam@menloschool.org",
    "Jacqueline Arreaga":     "jarreaga@menloschool.org",
    "Danielle Jensen":        "djensen@menloschool.org",
    "Yu-Loung Chang":         "ychang@menloschool.org",
    "Dave Lowell":            "dlowell@menloschool.org",
    "Reeve Garrett":          "rgarrett@menloschool.org",
    "Jude Loeffler":          "jloeffler@menloschool.org",
    "Dennis Millstein":       "dmillstein@menloschool.org",
    "Douglas Kiang":          "dkiang@menloschool.org",
    "Zachary Blickensderfer": "zblickensderfer@menloschool.org",
    "Chrissy Orangio":        "corangio@menloschool.org",
    "Laura Huntley":          "lhuntley@menloschool.org",
    "Mary McKenna":           "mmckenna@menloschool.org",
    "Zachary Eagleton":       "zeagleton@menloschool.org",
    "Eugenia McCauley":       "emccauley@menloschool.org",
    "Nina Arnberg":           "narnberg@menloschool.org",
    "Zane Moore":             "zmoore@menloschool.org",
    "Matthew Varvir":         "mvarvir@menloschool.org",
    "Todd Hardie":            "thardie@menloschool.org",
    "Cristina Weaver":        "cweaver@menloschool.org",
    "Tatyana Buxton":         "tbuxton@menloschool.org",
    "James Dann":             "jdann@menloschool.org",
    "James Formato":          "jformato@menloschool.org",
    "Leo Jaimez":             "ljaimez@menloschool.org",
    "Janet Tennyson":         "jtennyson@menloschool.org",
    "Adolfo Guevara":         "aguevara@menloschool.org",
    "Perla Amaral":           "pamaral@menloschool.org",
    "Patricia Frias":         "pfrias@menloschool.org",
    "Marie Sajja":            "msajja@menloschool.org",
    "Corinne Chung":          "cchung@menloschool.org",
    "Rita Yeh":               "ryeh@menloschool.org",
    "Mingjung Chen":          "mchen@menloschool.org",
    "Jennifer Jordt":         "jjordt@menloschool.org",
    "Richard Harris":         "rharris@menloschool.org",
    "Test Teacher":            "hadi.hilaly@menloschool.org",
    // ── SYNTHETIC voice-test personas (fake domain @lumidemo.test; NOT real
    //    Menlo staff). Seeded via synthetic_data/seed_personas.py; a demo
    //    student schedule is loaded via seed_demo_student.py. Remove this block
    //    + run cleanup_personas.py to fully revert.
    "Dale Ferraro":           "dferraro@lumidemo.test",
    "Priya Ramaswamy":        "pramaswamy@lumidemo.test",
    "Nadia Okonkwo":          "nokonkwo@lumidemo.test",
    "Thomas Beck":            "tbeck@lumidemo.test",
    "Carmen Alvarado":        "calvarado@lumidemo.test",
    "Kevin Zhou":             "kzhou@lumidemo.test",
    "Greg Halloran":          "ghalloran@lumidemo.test",
    "Rick Santos":            "rsantos@lumidemo.test",
  };

  // Allowlist for the "Switch to Teacher Mode" LINK on the student app
  // (app.html). This is deliberately narrower than teacher.html's actual entry
  // gate (TEACHER_DATABASE, derived from MENLO_CURRICULUM + TEACHER_EMAIL_MAP);
  // it only decides who SEES the shortcut link. Both gates now read from this
  // one file so an access-model change is a single-file edit (AUDIT_FRONTEND
  // F1 — no more app.js vs teacher.html drift across files).
  g.ALLOWED_TEACHER_EMAILS = ["hadi.hilaly@menloschool.org"];
})(typeof globalThis !== "undefined" ? globalThis : window);
