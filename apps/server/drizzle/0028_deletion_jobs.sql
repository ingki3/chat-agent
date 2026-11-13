CREATE TABLE `deletion_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`runtime` text,
	`connection_id` text,
	`external_session_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deletion_jobs_session_idx` ON `deletion_jobs` (`runtime`,`connection_id`,`user_id`,`external_session_id`);--> statement-breakpoint
CREATE INDEX `deletion_jobs_next_idx` ON `deletion_jobs` (`next_at`);