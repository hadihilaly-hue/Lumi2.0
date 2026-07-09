# Demo-student schedule (all 8 synthetic personas)

Loads one class from each of the 8 synthetic teachers into a student session
so you can chat with every persona from one sidebar. Requires the synthetic
`TEACHER_EMAIL_MAP` block (app.js + teacher.html) to be present in the
**deployed** build, and the personas seeded in RDS (both already done).

Because `loadProfileFromSupabase()` only pulls the DB schedule into
localStorage when localStorage has none (`app.js:1304`), a directly-set
localStorage schedule takes precedence and persists — no DB write, no creds.

## Use it
1. Sign into the student app (`app.html`) with your Menlo Google account.
2. Open the browser console (F12 → Console) and paste:

```js
localStorage.setItem('lumi_schedule', '[{"course":"Algebra II","teacher":"Dale Ferraro","subject":"Mathematics","block":"B"},{"course":"Biology","teacher":"Priya Ramaswamy","subject":"Science","block":"A"},{"course":"Music Theory","teacher":"Nadia Okonkwo","subject":"Music","block":"E"},{"course":"English 10","teacher":"Thomas Beck","subject":"English","block":"B"},{"course":"Spanish II","teacher":"Carmen Alvarado","subject":"World Languages","block":"C"},{"course":"Intro to Computer Science","teacher":"Kevin Zhou","subject":"Computer Science","block":"A"},{"course":"US History","teacher":"Greg Halloran","subject":"History","block":"B"},{"course":"Physical Education 9","teacher":"Rick Santos","subject":"Physical Education","block":"A"}]');
location.reload();
```

All 8 classes appear under **My Classes**; click any to chat with that persona.

## Reset
```js
localStorage.removeItem('lumi_schedule'); location.reload();
```
(Then it falls back to whatever schedule your profile has in the DB.)
