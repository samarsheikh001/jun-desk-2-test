-- AI-16: a model per AI job, within the workspace's provider.
-- JSON {"brief"?: "…", "nudge"?: "…", ...}; a job without an entry uses ai_settings.model.
ALTER TABLE ai_settings ADD COLUMN models TEXT NOT NULL DEFAULT '{}';
