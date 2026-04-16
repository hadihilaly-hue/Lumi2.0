-- Create api_usage table for rate limiting
CREATE TABLE IF NOT EXISTS api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  is_teacher BOOLEAN NOT NULL DEFAULT false,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for efficient rate limit queries (count by user + date)
CREATE INDEX IF NOT EXISTS idx_api_usage_user_date ON api_usage (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_api_usage_email_date ON api_usage (user_email, created_at);

-- RLS policies
ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY;

-- Service role (Edge Function) can do everything
DROP POLICY IF EXISTS "Service role full access" ON api_usage;
CREATE POLICY "Service role full access" ON api_usage
  FOR ALL USING (auth.role() = 'service_role');

-- Users can view their own usage
DROP POLICY IF EXISTS "Users can view own usage" ON api_usage;
CREATE POLICY "Users can view own usage" ON api_usage
  FOR SELECT USING (auth.uid() = user_id);
