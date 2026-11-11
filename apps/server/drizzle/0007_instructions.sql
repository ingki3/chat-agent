ALTER TABLE `conversations` ADD `research_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `instructions` text;--> statement-breakpoint
ALTER TABLE `runtime_sessions` ADD `instructions_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `youth` integer DEFAULT false NOT NULL;