CREATE TABLE `push_session_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
