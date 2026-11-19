CREATE TABLE `public_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`owner_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`disabled_at` integer,
	`view_count` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_links_token_hash_unique` ON `public_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `public_links_owner_idx` ON `public_links` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `public_links_artifact_idx` ON `public_links` (`artifact_id`);