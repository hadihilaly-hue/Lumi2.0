# Lumi — Menlo School AI Companion

A multi-file web app with Google OAuth (Supabase), per-user cloud storage, and a conversation history system. Deployed as a static site on GitHub Pages.

---

## Project Structure

```
lumi/
  index.html   Sign-in page (Google OAuth)
  app.html     Main Lumi app
  auth.js      Supabase auth helpers
  app.js       App logic + Supabase sync
  style.css    Shared styles
  README.md    This file
```

---

## Setup Guide

### 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Choose a name (e.g. `lumi-menlo`) and set a database password
3. Wait for the project to spin up

---

### 2. Enable Google OAuth

1. In your Supabase project → **Authentication → Providers → Google**
2. Toggle **Enable Sign in with Google**
3. Go to [console.cloud.google.com](https://console.cloud.google.com):
   - Create a project (or reuse one)
   - **APIs & Services → Credentials → Create OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URIs — add your Supabase callback URL:
     ```
     https://YOUR_PROJECT_ID.supabase.co/auth/v1/callback
     ```
4. Copy the **Client ID** and **Client Secret** back into Supabase → Google provider → Save

---

### 3. Add Your Supabase Keys to `auth.js`

Open `auth.js` and replace the placeholder values:

```js
const SUPABASE_URL     = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';
```

Find these in: Supabase dashboard → **Project Settings → API**
- **Project URL** → `SUPABASE_URL`
- **anon / public** key → `SUPABASE_ANON_KEY`

---

### 4. Create Database Tables

In Supabase → **SQL Editor**, run:

```sql
-- User profiles
create table profiles (
  id         uuid references auth.users on delete cascade primary key,
  name       text,
  grade      text,
  updated_at timestamptz default now()
);

-- Conversations
create table conversations (
  id             text primary key,
  user_id        uuid references auth.users on delete cascade not null,
  title          text,
  preview        text,
  messages_json  jsonb default '[]',
  values_json    jsonb default '[]',
  goals_json     jsonb default '[]',
  interests_json jsonb default '[]',
  exchange_count int default 0,
  tutor_ctx      jsonb,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- Row Level Security
alter table profiles      enable row level security;
alter table conversations enable row level security;

create policy "Users manage own profile" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "Users manage own conversations" on conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

---

### 5. Set Allowed Redirect URLs in Supabase

Go to **Authentication → URL Configuration** and add:

```
https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME/app.html
http://localhost:8080/app.html
```

(Replace with your actual GitHub Pages URL)

---

### 6. Deploy to GitHub Pages

```bash
git add index.html app.html auth.js app.js style.css README.md
git commit -m "Add Lumi multi-file Supabase app"
git push origin main
```

Then in your GitHub repo → **Settings → Pages**:
- Source: `main` branch, root `/`
- Save → your site will be live at `https://USERNAME.github.io/REPO/`

The sign-in page is `index.html` — set that as your entry point.

---

## How It Works

| Feature | Implementation |
|---|---|
| Auth | Supabase Google OAuth, `@menlo.org` domain check |
| Session | Supabase session persists across refreshes |
| Conversations | localStorage (fast cache) + Supabase (source of truth) |
| New device | Loads from Supabase on first visit |
| Sync | Fire-and-forget upsert on every save |
| Sign out | Clears session, redirects to `index.html` |
| Non-Menlo user | Rejected with helpful error message |

---

## Adding Your Anthropic API Key

The Claude API key is entered in Settings inside the app. It is stored in `localStorage` only — never sent to any server other than Anthropic's API directly.
