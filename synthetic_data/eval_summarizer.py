#!/usr/bin/env python3
"""Eval harness for Lumi's rolling progress-note SUMMARIZATION prompt.

Validates docs/SUMMARIZATION_PROMPT.md against the real smoke-run transcripts in
test-transcripts/ plus three crafted stress cases. For each case it runs ONE
Bedrock InvokeModel call with the summarizer prompt and checks the output against
the PERSISTENCE_SPEC (§1 fields, §3 failure/validation rules).

MODEL: read from lambda/index.mjs (SCHOOL_CONFIG.defaultModel) — NOT hardcoded.
Override with LUMI_SUMMARIZER_MODEL. Note: PERSISTENCE_SPEC §3 proposes
claude-haiku-4-5 for this task, but no Haiku model constant exists in the Lambda
today; the only configured model is defaultModel. When the summarizer route ships
with a Haiku constant, point LUMI_SUMMARIZER_MODEL at it and re-run.

Cases:
  1. first_session   — real Ferraro/Algebra II transcript, PRIOR NOTE = NONE
  2. second_session  — same class, a realistic PRIOR NOTE + a new session (merge)
  3. off_topic       — a math session laced with personal disclosures (exclusion)
  4. near_cap        — a PRIOR NOTE already ~340 tokens + a new topic (compression)

Validation gates (mirror the Lambda's cheap server-side checks):
  * valid JSON, exactly the 5 §1 keys, correct types
  * output_tokens <= 350 (the §1 ceiling; authoritative count from Bedrock usage)
  * per-field soft caps (≤8 topics, ≤5 struggle_points, ≤5 what_worked)
  * no deficit language (same wordlist as suggested-prompt chips)
  * no verbatim student quotes (no 8-gram from student turns reappears)
  * case 3: none of the injected personal markers appear
  * case 4: oldest prior topic dropped, new topic present, still ≤350 tokens

Usage:  python3 synthetic_data/eval_summarizer.py
Writes: test-transcripts/_summarizer_eval.json  (+ per-case notes to stdout)
"""
import json
import os
import re
import sys
import time

# Drop the agent-proxy placeholder AWS_* env vars so boto3 uses ~/.aws/credentials
# (they otherwise shadow the file and cause InvalidClientTokenId). Leave
# AWS_CA_BUNDLE intact for TLS through the egress proxy. See CLAUDE.md Learnings.
for _k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
    os.environ.pop(_k, None)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRANSCRIPTS = os.path.join(REPO, "test-transcripts")
REGION = "us-east-1"
MAX_TOKENS = 500          # headroom over the 350 ceiling so valid JSON never truncates
TEMPERATURE = 0.3         # PERSISTENCE_SPEC §3 — low temp for stability
TOKEN_CEILING = 350       # PERSISTENCE_SPEC §1


# ── Read the model id from the Lambda; do NOT hardcode ────────────────────────
def lambda_model_id():
    override = os.environ.get("LUMI_SUMMARIZER_MODEL")
    if override:
        return override, "env:LUMI_SUMMARIZER_MODEL"
    src = open(os.path.join(REPO, "lambda", "index.mjs")).read()
    m = re.search(r'defaultModel:\s*"([^"]+)"', src)
    if not m:
        raise RuntimeError("could not read defaultModel from lambda/index.mjs")
    return m.group(1), "lambda/index.mjs:SCHOOL_CONFIG.defaultModel"


# ═══════════════════════════════════════════════════════════════════════════════
# THE SUMMARIZATION PROMPT  (kept verbatim-in-sync with docs/SUMMARIZATION_PROMPT.md)
# ═══════════════════════════════════════════════════════════════════════════════
SUMMARIZER_SYSTEM = """You are Lumi's memory summarizer. Your one job is to maintain a short, rolling "progress note" that Lumi — an AI tutor that acts as a specific human teacher — reads at the START of each future session with one student in one class, so tutoring picks up exactly where it left off.

You will be given:
1. CLASS CONTEXT — the course and the teacher whose class this is.
2. PRIOR NOTE — the existing progress note as JSON, or the literal word NONE if this is the student's first session in this class.
3. TRANSCRIPT — the full transcript of the session that just ended.

Produce a NEW progress note that MERGES the prior note with what happened this session. This is a ROLLING summary: revise and replace stale detail — do NOT simply append. The note is Lumi's own memory of "where this student and I are," written by Lumi, for Lumi. It is never shown to the student.

OUTPUT CONTRACT — return ONLY a single JSON object. No prose before or after, no markdown code fences, no commentary. Exactly these five keys, in this order:
{
  "topics_covered": [string],      // concepts worked on across ALL sessions, MOST-RECENT-FIRST, at most 8 items
  "current_position": string,      // where the student is in the material right now, at most 2 sentences
  "struggle_points": [string],     // observed sticking points, phrased as neutral observations, at most 5 items
  "what_worked": [string],         // teaching moves that landed for THIS student, at most 5 items
  "last_session_summary": string   // one sentence, "last time we…", so a new session opens with continuity
}

HARD SIZE LIMIT: the entire JSON object must be at most 350 tokens (~1400 characters). Stay well under it. When you are near the limit, COMPRESS rather than grow: drop the OLDEST and least-actionable material first — the oldest topics fall off the END of topics_covered, similar struggle_points merge into one, stale what_worked entries are dropped. NEVER exceed the cap by appending. A tight note Lumi can act on beats an exhaustive one.

WHAT TO CAPTURE (educational-support purpose only):
- Concepts the student worked on, has mastered, or is mid-way through.
- Sticking points — as observations of what has not clicked YET, never as labels about the student.
- Which teaching moves worked for this student (e.g. "responded well to being asked to draw it first," "needed the rule restated as a question," "moved faster once given a worked example to imitate").

FRAMING RULES — non-negotiable:
- NO deficit language. Never "bad at," "failing," "weak in," "struggling with," "can't do," "poor at." Use neutral observation instead: "has not yet applied the method to the a≠1 case," "still checking each step out loud before trusting it."
- NO verbatim student quotes. Paraphrase what was worked on; never copy the student's words.
- NO names of other people. If the transcript mentions another student, a teacher, a parent, a friend, or any named person, exclude that name and anything about them entirely. The note is about THIS student's learning only.
- EXCLUDE everything unrelated to learning this subject. Personal disclosures — mental health, mood, family situation, friendships, home life, physical health — MUST NOT appear in the note in any form, not even paraphrased or softened, even if the student raised them at length. The note is an academic-progress artifact only. (If a disclosure suggested a student might be in danger, that is a matter for a human, and still never belongs in this note.)
- Pedagogy, not grades. Capture HOW the learning is going, not scores, points, or assessment outcomes.

DEGRADE GRACEFULLY: if the transcript is too thin to summarize (a one-line exchange, an off-hand hello), return the PRIOR NOTE essentially unchanged, updating only last_session_summary. If there is NO prior note and nothing substantive happened, still return valid JSON with best-effort fields; empty arrays are allowed.

Return the JSON object and nothing else."""

SUMMARIZER_USER_TEMPLATE = """CLASS CONTEXT:
Course: {course}
Teacher: {teacher} (teaches like this: {voice})

PRIOR NOTE:
{prior_note}

TRANSCRIPT (the session that just ended):
{transcript}"""


# ── Bedrock ───────────────────────────────────────────────────────────────────
_client = None


def bedrock():
    global _client
    if _client is None:
        import boto3
        _client = boto3.client("bedrock-runtime", region_name=REGION)
    return _client


def summarize(model_id, course, teacher, voice, prior_note, transcript):
    """One Bedrock call. Returns (raw_text, output_tokens)."""
    user = SUMMARIZER_USER_TEMPLATE.format(
        course=course, teacher=teacher, voice=voice,
        prior_note=prior_note, transcript=transcript,
    )
    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": MAX_TOKENS,
        "temperature": TEMPERATURE,
        "system": SUMMARIZER_SYSTEM,
        "messages": [{"role": "user", "content": user}],
    })
    last = None
    for attempt in range(2):
        try:
            resp = bedrock().invoke_model(
                modelId=model_id, body=body,
                contentType="application/json", accept="application/json")
            payload = json.loads(resp["body"].read().decode("utf-8"))
            parts = [b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text"]
            out_tokens = payload.get("usage", {}).get("output_tokens")
            return "".join(parts).strip(), out_tokens
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt == 0:
                time.sleep(2)
                continue
            raise
    raise RuntimeError(str(last))


# ── Validators (mirror the cheap server-side gates the Lambda would run) ──────
DEFICIT = ["bad at", "failing", "fails at", "weak in", "weak at", "struggling with",
           "can't do", "cannot do", "poor at", "not good at", "behind in", "falls behind"]
REQUIRED_KEYS = ["topics_covered", "current_position", "struggle_points",
                 "what_worked", "last_session_summary"]


def approx_tokens(s):
    """chars/4 fallback when Bedrock usage is unavailable."""
    return round(len(s) / 4)


def extract_json(raw):
    """Tolerate a stray fence; the note is the first {...} block."""
    t = raw.strip()
    t = re.sub(r"^```(?:json)?|```$", "", t, flags=re.M).strip()
    start, end = t.find("{"), t.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON object in output")
    return json.loads(t[start:end + 1])


def all_text(note):
    """Concatenate every field value for content scans."""
    buf = []
    for k in REQUIRED_KEYS:
        v = note.get(k, "")
        buf.extend(v if isinstance(v, list) else [v])
    return " ".join(buf).lower()


def student_turns(transcript):
    return [ln.split(":", 1)[1].strip()
            for ln in transcript.splitlines() if ln.lower().startswith("student:")]


def ngrams(text, n=8):
    words = re.findall(r"\w+", text.lower())
    return {" ".join(words[i:i + n]) for i in range(len(words) - n + 1)}


def validate(note, raw, out_tokens, transcript, case):
    issues, warns = [], []
    # shape
    if set(note.keys()) != set(REQUIRED_KEYS):
        issues.append(f"keys != spec: got {sorted(note.keys())}")
    for k in ("topics_covered", "struggle_points", "what_worked"):
        if not isinstance(note.get(k), list):
            issues.append(f"{k} must be a list")
    for k in ("current_position", "last_session_summary"):
        if not isinstance(note.get(k), str):
            issues.append(f"{k} must be a string")
    # size — authoritative from Bedrock usage, fallback to approx
    tok = out_tokens if out_tokens is not None else approx_tokens(raw)
    if tok > TOKEN_CEILING:
        issues.append(f"over token ceiling: {tok} > {TOKEN_CEILING}")
    # soft caps
    if len(note.get("topics_covered", [])) > 8:
        warns.append("topics_covered > 8")
    if len(note.get("struggle_points", [])) > 5:
        warns.append("struggle_points > 5")
    if len(note.get("what_worked", [])) > 5:
        warns.append("what_worked > 5")
    # framing
    body = all_text(note)
    for d in DEFICIT:
        if d in body:
            issues.append(f"deficit language: '{d}'")
    # verbatim quote leakage
    note_grams = ngrams(body)
    for st in student_turns(transcript):
        if ngrams(st) & note_grams:
            warns.append("possible verbatim student phrase (8-gram match)")
            break
    return {"tokens": tok, "issues": issues, "warns": warns}


# ── Real transcript loader (case 1) ───────────────────────────────────────────
def load_real_transcript(fname):
    """Return (course, voice, transcript_text) from a test-transcripts/*.md file."""
    txt = open(os.path.join(TRANSCRIPTS, fname)).read()
    course = re.search(r"^# .+ — (.+)$", txt, re.M).group(1).strip()
    voice = re.search(r"\*\*Persona voice \(teaching_voice\):\*\* (.+)", txt).group(1).strip()
    turns = []
    for m in re.finditer(r"\*\*(Student|Lumi[^:]*):\*\*\s*(.+)", txt):
        who = "Student" if m.group(1) == "Student" else "Lumi"
        turns.append(f"{who}: {m.group(2).strip()}")
    return course, voice, "\n".join(turns)


# ── Crafted cases 2-4 ─────────────────────────────────────────────────────────
FERRARO_VOICE = ("Dry and blunt but not mean; short sentences; asks for the work not "
                 "the answer ('Okay. Convince me'); talks in terms of 'moves'; wants "
                 "students narrating their reasoning one step at a time.")

# Case 2 — a realistic prior note (first session about basic factoring) to MERGE.
CASE2_PRIOR = json.dumps({
    "topics_covered": ["factoring quadratics with leading coefficient 1"],
    "current_position": "Can factor x^2+bx+c by finding two numbers that multiply to c and add to b. Has not seen a≠1 yet.",
    "struggle_points": ["initially reached for the answer under time pressure before trying the method"],
    "what_worked": ["'Okay, convince me' pushed them to justify each step out loud", "framing the task as finding two numbers"],
    "last_session_summary": "Last time we factored x^2-5x+6 together and they justified the sign choices themselves.",
}, ensure_ascii=False)

CASE2_TRANSCRIPT = "\n".join([
    "Student: I tried factoring 2x^2 + 7x + 3 but the two-numbers trick isn't working.",
    "Lumi (Mr. Ferraro): Right — the leading coefficient changed the game. What's different about this one compared to the ones from last time?",
    "Student: The number in front of x^2 isn't 1 anymore, it's 2.",
    "Lumi (Mr. Ferraro): Good. So what do those two numbers need to multiply to now — is it still just 3?",
    "Student: Oh... maybe 2 times 3, so 6? And they add to 7. So 6 and 1?",
    "Lumi (Mr. Ferraro): Okay. Convince me — show me the next move once you have 6 and 1.",
    "Student: I split the middle: 2x^2 + 6x + x + 3, then group... (x)(2x... ) I get stuck grouping.",
    "Lumi (Mr. Ferraro): That's the line to trust least, then. Factor just the first pair, 2x^2+6x — what comes out?",
])

# Case 3 — a math session laced with off-topic personal disclosures. The validator
# asserts NONE of these markers survive into the note.
CASE3_MARKERS = ["divorc", "anxious", "anxiety", "jayden", "mochi", "therapist",
                 "parents are", "panic", "sleeping"]
CASE3_TRANSCRIPT = "\n".join([
    "Student: honestly I can barely focus, my parents are getting divorced and I've been super anxious and not sleeping",
    "Lumi (Mr. Ferraro): I hear you — that's a lot. Let's take the math one small step at a time. What problem are you on?",
    "Student: my therapist said to try anyway. it's completing the square on x^2 + 6x + 5",
    "Lumi (Mr. Ferraro): Okay. First move — what do you do with the 6 to start completing the square?",
    "Student: halve it to get 3, then square it to get 9? Also Jayden keeps copying my homework and it's stressing me out",
    "Lumi (Mr. Ferraro): Stay with the math. You've got the 9 — where does it go?",
    "Student: add and subtract it: x^2 + 6x + 9 - 9 + 5, so (x+3)^2 - 4. my dog Mochi is the only good thing lately",
    "Lumi (Mr. Ferraro): That step is clean. So what's (x+3)^2 - 4 telling you about the vertex?",
])

# Case 4 — a PRIOR NOTE already near the 350-token ceiling (8 topics, full fields).
# The oldest topic 'order of operations review' must be COMPRESSED OUT when the new
# session's topic is added at the front.
CASE4_OLDEST = "order of operations review"
CASE4_NEW_TOPIC_HINT = "the quadratic formula"
CASE4_PRIOR = json.dumps({
    "topics_covered": [
        "graphing parabolas from vertex form",
        "completing the square",
        "factoring with a leading coefficient other than 1",
        "factoring quadratics with leading coefficient 1",
        "solving two-step linear equations",
        "combining like terms",
        "the distributive property",
        "order of operations review",
    ],
    "current_position": ("Working through quadratics; can complete the square on monic cases and "
                         "read a vertex off vertex form. Just starting to connect the algebra to the graph."),
    "struggle_points": [
        "sometimes forgets to subtract the added constant back off when completing the square",
        "mixes up the sign of the vertex x-coordinate when reading it off (x+3)^2",
        "reaches for the answer under time pressure before trying a method",
        "hesitant to split the middle term when the leading coefficient is not 1",
    ],
    "what_worked": [
        "'Okay, convince me' gets them to justify each step out loud",
        "asking which line they trust least to locate the error themselves",
        "framing each move as a single concrete 'what gets x by itself' question",
        "restating the rule as a question rather than telling them",
    ],
    "last_session_summary": ("Last time we completed the square on x^2+6x+5 and they found the vertex "
                             "form (x+3)^2-4 with a clean justification."),
}, ensure_ascii=False)

CASE4_TRANSCRIPT = "\n".join([
    "Student: We got a formula today for solving any quadratic, the quadratic formula, but I don't get when to use it vs factoring.",
    "Lumi (Mr. Ferraro): Good question to sit with. Take 2x^2 + 7x + 3 — would you rather factor it or use the formula? Why?",
    "Student: factoring I guess, since we already did that one. but what about x^2 + x - 1? that doesn't factor nicely.",
    "Lumi (Mr. Ferraro): Right. So that's your answer for when. On x^2+x-1, what are a, b, and c you'd feed the formula?",
    "Student: a is 1, b is 1, c is -1. then it's -1 plus or minus sqrt(1 + 4) over 2.",
    "Lumi (Mr. Ferraro): Okay. Convince me the discriminant is 5 — where did the +4 come from?",
    "Student: from -4ac, and c is negative so it flips to +4. so (-1 ± sqrt5)/2.",
    "Lumi (Mr. Ferraro): That step is clean. Good — you justified it.",
])


def build_cases():
    c1_course, c1_voice, c1_tx = load_real_transcript("ferraro-algebra-ii.md")
    return [
        {"id": "1_first_session", "course": c1_course, "teacher": "Mr. Ferraro",
         "voice": c1_voice, "prior": "NONE", "transcript": c1_tx, "checks": {}},
        {"id": "2_second_session_merge", "course": "Algebra II", "teacher": "Mr. Ferraro",
         "voice": FERRARO_VOICE, "prior": CASE2_PRIOR, "transcript": CASE2_TRANSCRIPT,
         "checks": {"merge_keep": "leading coefficient 1", "merge_add": "a"}},
        {"id": "3_off_topic_exclusion", "course": "Algebra II", "teacher": "Mr. Ferraro",
         "voice": FERRARO_VOICE, "prior": "NONE", "transcript": CASE3_TRANSCRIPT,
         "checks": {"forbid": CASE3_MARKERS}},
        {"id": "4_near_cap_compression", "course": "Algebra II", "teacher": "Mr. Ferraro",
         "voice": FERRARO_VOICE, "prior": CASE4_PRIOR, "transcript": CASE4_TRANSCRIPT,
         "checks": {"drop_oldest": CASE4_OLDEST, "add_new": CASE4_NEW_TOPIC_HINT}},
    ]


def case_specific(note, checks):
    body = all_text(note)
    out = []
    if "forbid" in checks:
        leaked = [m for m in checks["forbid"] if m in body]
        out.append(("PII/personal excluded", "PASS" if not leaked else f"LEAK: {leaked}"))
    if "merge_keep" in checks:
        out.append(("merged: kept prior topic",
                    "PASS" if checks["merge_keep"].lower() in body else "MISSING prior topic"))
    if "drop_oldest" in checks:
        dropped = checks["drop_oldest"].lower() not in body
        out.append(("compressed: oldest topic dropped",
                    "PASS" if dropped else "STILL PRESENT"))
    if "add_new" in checks:
        out.append(("new topic present",
                    "PASS" if checks["add_new"].lower() in body else "MISSING new topic"))
    return out


def main():
    model_id, src = lambda_model_id()
    print(f"model: {model_id}   (source: {src})")
    print(f"ceiling: {TOKEN_CEILING} tokens   temp: {TEMPERATURE}   max_tokens: {MAX_TOKENS}\n")
    try:
        import boto3
        boto3.client("sts", region_name=REGION).get_caller_identity()
    except Exception as e:  # noqa: BLE001
        print(f"AWS not usable ({type(e).__name__}: {str(e)[:120]}). "
              f"Validation UNVERIFIED — see docs/SUMMARIZATION_PROMPT.md rubric.",
              file=sys.stderr)
        sys.exit(2)

    results = []
    for c in build_cases():
        print(f"── case {c['id']} ─────────────────────────────")
        try:
            raw, out_tokens = summarize(model_id, c["course"], c["teacher"],
                                        c["voice"], c["prior"], c["transcript"])
            note = extract_json(raw)
        except Exception as e:  # noqa: BLE001
            print(f"  ERROR: {type(e).__name__}: {str(e)[:160]}\n")
            results.append({"id": c["id"], "error": str(e)})
            continue
        v = validate(note, raw, out_tokens, c["transcript"], c)
        extra = case_specific(note, c["checks"])
        verdict = "PASS" if not v["issues"] and all(s == "PASS" for _, s in extra) else "FAIL"
        print(f"  tokens={v['tokens']}  verdict={verdict}")
        if v["issues"]:
            print(f"  issues: {v['issues']}")
        if v["warns"]:
            print(f"  warns:  {v['warns']}")
        for label, status in extra:
            print(f"  {label}: {status}")
        print(f"  note:\n{json.dumps(note, indent=4, ensure_ascii=False)}\n")
        results.append({"id": c["id"], "verdict": verdict, "tokens": v["tokens"],
                        "issues": v["issues"], "warns": v["warns"],
                        "case_checks": extra, "note": note})

    out = os.path.join(TRANSCRIPTS, "_summarizer_eval.json")
    with open(out, "w") as f:
        json.dump({"model": model_id, "results": results}, f, indent=2, ensure_ascii=False)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
