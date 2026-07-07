#!/usr/bin/env python3
"""Cost-capped voice smoke test for the 8 synthetic personas.

For each persona: ONE short conversation (the 3 student turns in
personas.SMOKE_QUESTIONS — one of which demands a direct answer, to check the
no-direct-answers guardrail). Each student turn = one Bedrock InvokeModel call.

Faithful to production: the system prompt is a direct port of app.js
buildTutorSystem()'s profile branch (work-samples omitted — these personas
have none — and the <<LUMI_TEACHER_NOTES>> marker stripped, exactly as the
chat Lambda does when there are no notes). Model + body shape match the
Lambda's callClaude(): global.anthropic.claude-sonnet-4-6, anthropic_version
bedrock-2023-05-31.

HARD CAPS (task constraints):
  * MAX_TOTAL_CALLS = 30 Bedrock messages across the whole run (8*3 = 24 planned).
  * max_tokens = 400 (keep replies short and cheap).
  * At most ONE retry per failed call.

Transcripts are written to test-transcripts/<lastname>-<course>.md so voice
can be reviewed without re-spending tokens.

Usage: python3 synthetic_data/smoke_test.py
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from personas import PERSONAS, SMOKE_QUESTIONS, display_name, quality_by_email  # noqa: E402

# Drop the agent-proxy placeholder AWS_* env vars so boto3 uses ~/.aws/credentials
# (they otherwise shadow the file and cause InvalidClientTokenId).
for _k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
    os.environ.pop(_k, None)

import boto3  # noqa: E402

REGION = "us-east-1"
MODEL_ID = os.environ.get("LUMI_BEDROCK_MODEL", "global.anthropic.claude-sonnet-4-6")
MAX_TOTAL_CALLS = 30
MAX_TOKENS = 400
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test-transcripts")

_calls_made = 0
_client = None


def bedrock():
    global _client
    if _client is None:
        _client = boto3.client("bedrock-runtime", region_name=REGION)
    return _client


# ── Faithful port of app.js studentCtx() for a generic test student ──────────
def student_ctx():
    return ("The student you're helping is Alex, a 10th grade student at Menlo School.\n"
            "Study style: 25 min work / 5 min break (Short Bursts).\n"
            "Bedtime: 10:30 PM — never schedule or encourage work past this time.")


# ── Faithful port of app.js buildTutorSystem() — profile branch, no work
#    samples, notes marker stripped. Kept close to the source so the voice
#    the test exercises is the voice production ships. ────────────────────────
def build_tutor_system(persona, course, course_info):
    display = display_name(persona)          # e.g. "Mr. Ferraro"
    first = persona["first"]
    FIRST = first.upper()
    p_engagement = persona["engagement_rules"] or "(No rules specified)"
    p_voice = persona["teaching_voice"] or "(No voice specified)"
    p_info = course_info or "(No course info)"

    prompt = f"""You are Lumi, {display}'s 24/7 digital stand-in for their {course} class at Menlo School. {display} has given you a deep briefing on how they teach, and your job is to help this student exactly the way {display} would — so teach in the FIRST PERSON, as {display}. Do NOT talk about {display} in the third person: never say "{display} would ask…", "{display}'s approach is…", or "here's how {display} teaches." Just say it and do it directly, as them. Only name {display} in the third person if the student explicitly asks who their teacher is.

Never begin a response with a code block or markdown formatting. Always start with plain conversational text.
Always complete your full response. If approaching length limits, wrap up your current point concisely rather than stopping mid-thought.
When writing any math, always use LaTeX: inline math in $…$ and display math in $$…$$. Never use plain-text math like sqrt(x) or x^2 — always $\\sqrt{{x}}$ or $x^2$.

{student_ctx()}

═══ HOW {FIRST} WANTS YOU TO HELP STUDENTS ═══
{p_engagement}

═══ HOW {FIRST} TALKS AND TEACHES ═══
{p_voice}

═══ ABOUT THIS COURSE ═══
{p_info}

═══ STUDENT MODE RULES — FOLLOW THESE AT ALL TIMES ═══

NEVER:
- Give direct answers to homework or test questions
- Say "that's wrong" — instead ask the student to walk through their reasoning
- Make more than one correction per response
- Generate analysis on behalf of the student — not even partially disguised as a hint
- Tell students what their conclusions should be
- Validate surface-level thinking to be encouraging — false floors are not kindness

ALWAYS:
- Ask the student to walk through their reasoning BEFORE you respond
- Find the single most important weakness and ask exactly ONE question targeting it
- Push back on reasoning quality, never on conclusions
- Let students find their own inconsistencies
- Match {display}'s voice, tone, and teaching style exactly
- When you have multiple feedback points, deliver ONE AT A TIME. List them as headlines first, then expand only the first one.
- If the student asks for everything at once, gently push back: "Let's tackle these one at a time so each one actually sticks. Start with [first point] — what would you change?" Wait for them to attempt a revision OR explain the point in their own words before moving to the next one.

FRUSTRATION AND TIME PRESSURE:
When a student expresses frustration or time pressure, acknowledge it in one sentence maximum, then immediately redirect to a single focused question. Never explain at length why you won't give direct answers — just don't give them, and get back to work.

Response length: SHORT — 1-3 sentences for simple questions. Longer only when a concept truly needs it. No essays.

After EVERY reply, append this JSON on its own line at the very end (stripped before display):
{{"values":["..."],"goals":["..."],"interests":["..."]}}
Only include NEWLY learned things about the student. Empty arrays if nothing new.
NEVER mention the JSON."""
    return prompt


_JSON_TAIL = re.compile(r'\n?\{"values".*\}\s*$', re.S)


def strip_json_tail(text):
    """Remove the trailing values/goals/interests JSON the app hides."""
    return _JSON_TAIL.sub("", text).rstrip()


def call_model(system_prompt, messages):
    """One Bedrock call. Enforces the global cap; at most one retry."""
    global _calls_made
    if _calls_made >= MAX_TOTAL_CALLS:
        raise RuntimeError(f"hard cap of {MAX_TOTAL_CALLS} Bedrock calls reached")
    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
        "messages": messages,
    })
    last = None
    for attempt in range(2):  # initial + one retry
        try:
            _calls_made += 1
            resp = bedrock().invoke_model(modelId=MODEL_ID, body=body,
                                          contentType="application/json", accept="application/json")
            payload = json.loads(resp["body"].read().decode("utf-8"))
            parts = [b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text"]
            return "".join(parts).strip()
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt == 0:
                time.sleep(2)
                continue
            raise
    raise RuntimeError(str(last))


# crude heuristics for the summary — the real judgement is the saved transcript
_DIRECT_MARKERS = {
    "Algebra II": ["(x-2)(x-3)", "(x - 2)(x - 3)", "x=2", "x = 2"],
    "Biology": [],
    "Music Theory": [],
    "English 10": [],
    "Spanish II": ["fui a la tienda"],
    "Intro to Computer Science": [],
    "US History": [],
    "Health": [],
}


def analyze(course, replies):
    """Return (refused_direct_answer, asked_question) heuristics."""
    joined = " ".join(replies).lower()
    markers = [m.lower() for m in _DIRECT_MARKERS.get(course, [])]
    gave_answer = any(m in joined for m in markers)
    asked_q = "?" in " ".join(replies)
    return (not gave_answer), asked_q


def run():
    os.makedirs(OUT_DIR, exist_ok=True)
    # pre-flight identity
    try:
        arn = boto3.client("sts", region_name=REGION).get_caller_identity()["Arn"]
        print("caller:", arn)
    except Exception as e:  # noqa: BLE001
        print(f"AWS credentials not usable: {e}", file=sys.stderr)
        sys.exit(2)
    print(f"model: {MODEL_ID}   hard cap: {MAX_TOTAL_CALLS} calls\n")

    quality = quality_by_email()
    summary = []
    for persona in PERSONAS:
        spec = SMOKE_QUESTIONS[persona["email"]]
        course = spec["course"]
        course_info = next(c["course_info"] for c in persona["classes"] if c["course_name"] == course)
        system_prompt = build_tutor_system(persona, course, course_info)

        transcript, messages, replies, broke = [], [], [], None
        for turn in spec["turns"]:
            messages.append({"role": "user", "content": turn})
            try:
                raw = call_model(system_prompt, messages)
            except Exception as e:  # noqa: BLE001
                broke = str(e)
                transcript.append(("error", broke))
                break
            reply = strip_json_tail(raw)
            messages.append({"role": "assistant", "content": raw})
            transcript.append(("student", turn))
            transcript.append(("lumi", reply))
            replies.append(reply)

        refused, asked_q = analyze(course, replies) if replies else (None, None)
        summary.append({
            "name": display_name(persona), "course": course, "quality": quality[persona["email"]],
            "turns_ok": len(replies), "refused_direct": refused, "asked_q": asked_q, "broke": broke,
        })

        # write transcript
        fname = f"{persona['last'].lower()}-{re.sub(r'[^a-z0-9]+', '-', course.lower()).strip('-')}.md"
        with open(os.path.join(OUT_DIR, fname), "w") as f:
            f.write(f"# {display_name(persona)} — {course}\n")
            f.write(f"_quality tier: {quality[persona['email']]} · model: {MODEL_ID}_\n\n")
            f.write(f"**Persona voice (teaching_voice):** {persona['teaching_voice']}\n\n---\n\n")
            for role, text in transcript:
                if role == "student":
                    f.write(f"**Student:** {text}\n\n")
                elif role == "lumi":
                    f.write(f"**Lumi ({display_name(persona)}):** {text}\n\n")
                else:
                    f.write(f"> **ERROR:** {text}\n\n")
        print(f"  {'BROKE' if broke else 'ok   '} {display_name(persona):16} {course:28} "
              f"turns={len(replies)}/3 refused_direct={refused} asked_q={asked_q}")

    print(f"\nTotal Bedrock calls: {_calls_made}/{MAX_TOTAL_CALLS}")
    print(f"Transcripts: {OUT_DIR}/")
    # machine-readable summary for the report
    with open(os.path.join(OUT_DIR, "_summary.json"), "w") as f:
        json.dump({"calls": _calls_made, "results": summary}, f, indent=2)
    return summary


if __name__ == "__main__":
    run()
