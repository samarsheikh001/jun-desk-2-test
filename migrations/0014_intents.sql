-- AI-20 intent-launched conversations (D-37): the host app opened the widget with
-- JunDesk.open({ intent: "<name>" }), e.g. from its "Cancel subscription" button. The intent's
-- opening, quick replies and exit action live in a skill's frontmatter (agent config), so only
-- the name is stored. intent_exited_at: when the visitor clicked the intent's exit button
-- (epoch ms; NULL while they haven't). Reports' save rate is a follow-up.
ALTER TABLE conversations ADD COLUMN intent TEXT;
ALTER TABLE conversations ADD COLUMN intent_exited_at INTEGER;
